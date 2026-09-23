import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { optimizeArmor, type ArmorCandidate } from '../builds/optimizer.js';
import type { Context } from '../context.js';
import { ARMOR_STATS, STAT_CAP } from '../inventory/constants.js';
import { locationLabel, namedStats, type Item } from '../inventory/model.js';
import { describeSubclass, subclassStatBonus } from '../inventory/subclass.js';
import { activeSetBonuses } from './inventory.js';
import { READ_ONLY, UserError, ok, resolveCharacter, safe, slotIndex, statKeyNames, statMapSchema, statMapToVector } from './util.js';

export function registerBuildTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'optimize_armor',
    {
      title: 'Optimize armor',
      description:
        'Finds the best 5-piece armor combinations from armor you own (vault + all characters) for a character. ' +
        'Supports a required exotic, stat minimums (0-200), stat priorities, and armor-set requirements (e.g. 2 or 4 pieces of a set for its bonus). ' +
        'Stat mods (+10 major or +5 minor, one per piece) are used first to reach minimums, then on the highest-priority stats. ' +
        "The equipped subclass's fragment stat bonuses are included by default. Use get_subclass_options and search_inventory first to decide on an exotic and stat goals.",
      inputSchema: {
        character: z.string().optional().describe('Character id or class name (titan/hunter/warlock); default is the most recently played'),
        exotic: z.string().optional().describe('"any" (default: best of all exotics, at most one), "none", or an exotic armor name/hash you own'),
        minimums: statMapSchema.optional().describe('Required stat totals, e.g. {"grenade": 150, "health": 100}'),
        priorities: statMapSchema
          .optional()
          .describe('Relative weight per stat, e.g. {"grenade": 3, "class": 2}. Stats not listed get weight 0.25. Default: all stats equal'),
        sets: z
          .array(z.object({ name: z.string().describe('Armor set name (substring)'), pieces: z.number().int().min(1).max(5) }))
          .optional()
          .describe('Set-bonus requirements, e.g. [{"name": "Techsec", "pieces": 4}]'),
        assumeMasterwork: z.boolean().optional().describe('Treat every piece as fully masterworked (default true)'),
        statMods: z.enum(['major', 'minor', 'none']).optional().describe('Stat mods allowed per piece (default major = +10)'),
        includeSubclassBonus: z.boolean().optional().describe("Add the equipped subclass's fragment stat bonuses (default true)"),
        results: z.number().int().min(1).max(10).optional().describe('Number of combinations to return (default 3)'),
      },
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const character = resolveCharacter(inv, args.character);
      const assumeMasterwork = args.assumeMasterwork ?? true;
      const names = statKeyNames(defs);

      const armor = inv.items.filter(
        (i) => i.kind === 'armor' && i.armor && i.instanceId && (i.classType === character.classType || i.classType === 'any') && slotIndex(i.bucketHash) >= 0,
      );
      if (!armor.length) throw new UserError(`No ${character.classType} armor found.`);

      let exotic: 'any' | 'none' | number = 'any';
      const exoticArg = args.exotic?.trim();
      if (exoticArg && exoticArg.toLowerCase() !== 'any') {
        if (exoticArg.toLowerCase() === 'none') exotic = 'none';
        else {
          const q = exoticArg.toLowerCase();
          const matches = armor.filter((i) => i.isExotic && (String(i.hash) === exoticArg || i.name.toLowerCase().includes(q)));
          const distinct = [...new Map(matches.map((m) => [m.hash, m])).values()];
          const exact = distinct.filter((m) => m.name.toLowerCase() === q);
          const pick = exact.length === 1 ? exact : distinct;
          if (!pick.length) throw new UserError(`You don't own a ${character.classType} exotic matching "${exoticArg}".`);
          if (pick.length > 1) throw new UserError(`"${exoticArg}" matches several exotics: ${pick.map((m) => m.name).join(', ')}`);
          exotic = pick[0].hash;
        }
      }

      const setRequirements: { setHash: number; pieces: number }[] = [];
      for (const s of args.sets ?? []) {
        const q = s.name.toLowerCase();
        const owned = [...new Map(armor.filter((a) => a.armor!.set?.name.toLowerCase().includes(q)).map((a) => [a.armor!.set!.hash, a.armor!.set!])).values()];
        if (!owned.length) throw new UserError(`You don't own any ${character.classType} armor from a set matching "${s.name}".`);
        if (owned.length > 1) throw new UserError(`"${s.name}" matches several sets: ${owned.map((o) => o.name).join(', ')}`);
        setRequirements.push({ setHash: owned[0].hash, pieces: s.pieces });
      }

      const subclassItem = inv.items.find(
        (i) => i.kind === 'subclass' && i.equipped && i.location.type === 'character' && i.location.characterId === character.id,
      );
      const bonus =
        args.includeSubclassBonus === false || !subclassItem
          ? ARMOR_STATS.map(() => 0)
          : subclassStatBonus(describeSubclass(subclassItem, inv, defs, false), defs);

      const candidates: ArmorCandidate[] = armor.map((i) => ({
        id: i.instanceId!,
        slot: slotIndex(i.bucketHash),
        stats: assumeMasterwork ? i.armor!.masterworked : i.armor!.noMods,
        exoticHash: i.isExotic ? i.hash : undefined,
        setHash: i.armor!.set?.hash,
        gearTier: i.gearTier,
      }));
      const minimums = statMapToVector(args.minimums, 0);
      const weights = args.priorities ? statMapToVector(args.priorities, 0.25) : statMapToVector(undefined, 1);
      const modValue = args.statMods === 'none' ? 0 : args.statMods === 'minor' ? 5 : 10;

      const started = Date.now();
      const results = optimizeArmor(candidates, {
        exotic,
        minimums,
        weights,
        setRequirements,
        bonus,
        modValue,
        topN: args.results ?? 3,
      });
      const byId = new Map(armor.map((a) => [a.instanceId!, a]));

      const header = {
        character: `${character.className} (${character.id})`,
        exotic: typeof exotic === 'number' ? armor.find((a) => a.hash === exotic)?.name : exotic,
        subclass: subclassItem?.name,
        subclassStatBonus: bonus.some((b) => b !== 0) ? namedStats(bonus, defs) : undefined,
        assumeMasterwork,
        statCap: STAT_CAP,
        searchMs: Date.now() - started,
      };
      if (!results.length) {
        return ok({
          ...header,
          results: [],
          hint: 'No combination meets the constraints. Lower the minimums, allow major stat mods, drop a set requirement, or try another exotic.',
        });
      }
      return ok({
        ...header,
        results: results.map((r, rank) => {
          const pieces = r.pieces.map((p) => byId.get(p.id)!);
          const setCounts = new Map<number, number>();
          for (const p of pieces) if (p.armor?.set) setCounts.set(p.armor.set.hash, (setCounts.get(p.armor.set.hash) ?? 0) + 1);
          return {
            rank: rank + 1,
            stats: namedStats(r.finalStats, defs),
            statsBeforeMods: namedStats(r.armorStats, defs),
            statMods: r.mods.map((i) => `+${modValue} ${names[ARMOR_STATS[i].key]}`),
            wastedPoints: r.finalStats.reduce((acc, v) => acc + Math.max(0, v - STAT_CAP), 0) || undefined,
            pieces: pieces.map((p) => pieceSummary(p, inv.characters)),
            setBonuses: activeSetBonuses(setCounts, defs).filter((s) => s.bonuses.some((b) => b.active)),
          };
        }),
      });
    }),
  );
}

function pieceSummary(p: Item, characters: Parameters<typeof locationLabel>[1]) {
  return {
    slot: p.slot,
    id: p.instanceId,
    name: p.name,
    tier: p.gearTier,
    archetype: p.armor?.archetype,
    set: p.armor?.set?.name,
    exotic: p.isExotic || undefined,
    location: locationLabel(p.location, characters),
    needsMasterwork: !p.masterworked || undefined,
  };
}
