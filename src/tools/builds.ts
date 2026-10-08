import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { optimizeArmor, type ArmorCandidate } from '../builds/optimizer.js';
import { CHAMPIONS, CHAMPION_NAMES, championCoverage, loadOverrides, ownedChampionWeapons } from '../builds/champions.js';
import { auditBuild, BuildSpecSchema, exportBuild } from '../builds/spec.js';
import { expandHome } from '../config.js';
import { matchByName } from '../names.js';
import { loadSubclassOwnership } from '../world/subclassVendors.js';
import type { Context } from '../context.js';
import { ARMOR_STATS, STAT_CAP } from '../inventory/constants.js';
import { locationLabel, namedStats, type Item } from '../inventory/model.js';
import { describeSubclass, findSubclass, planSubclassSetup, type PlannedSubclassSetup } from '../inventory/subclass.js';
import { activeSetBonuses } from './inventory.js';
import { READ_ONLY, UserError, briefItem, ok, resolveCharacter, resolveItems, safe, slotIndex, statKeyNames, statMapSchema, statMapToVector } from './util.js';

export function registerBuildTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'optimize_armor',
    {
      title: 'Optimize armor',
      description:
        'Finds the best 5-piece armor combinations from armor you own (vault + all characters) for a character. ' +
        'Supports a required exotic, stat minimums (0-200), stat priorities, and armor-set requirements (e.g. 2 or 4 pieces of a set for its bonus). ' +
        'Stat mods (+10 major or +5 minor, one per piece) are used first to reach minimums, then on the highest-priority stats. ' +
        "The equipped subclass's aspect and fragment stat bonuses are included by default. To plan a setup you haven't equipped, pass `aspects` and/or `fragments` (and `subclass` if it isn't the equipped one): " +
        'their stat bonuses replace the equipped ones, and the result warns when the fragments exceed the slots the aspects open. A list you leave out stays as equipped. ' +
        'Use get_subclass_options and search_inventory first to decide on an exotic and stat goals.',
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
        includeSubclassBonus: z.boolean().optional().describe("Add the subclass's aspect and fragment stat bonuses (default true)"),
        subclass: z.string().optional().describe('Subclass to plan with (name or element, e.g. "Nightstalker", "Void", "Prismatic"); default is the equipped one'),
        aspects: z.array(z.string()).max(5).optional().describe('Aspects to plan with instead of the equipped ones'),
        fragments: z.array(z.string()).max(12).optional().describe('Fragments to plan with instead of the equipped ones, e.g. ["Echo of Leeching", "Echo of Starvation"]'),
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
          const exotics = [...new Map(armor.filter((i) => i.isExotic).map((m) => [m.hash, m])).values()];
          const byHash = exotics.filter((m) => String(m.hash) === exoticArg);
          const pick = byHash.length ? byHash : matchByName(exotics, (m) => m.name, exoticArg);
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

      const planned = !!(args.aspects || args.fragments);
      if (planned && args.includeSubclassBonus === false) throw new UserError('aspects and fragments only matter with the subclass bonus; drop includeSubclassBonus: false or the aspects/fragments.');
      const subclassItem = findSubclass(inv, defs, character.id, args.subclass);
      if (args.subclass && !subclassItem) throw new UserError(`No subclass matching "${args.subclass}" on your ${character.className}.`);
      if (planned && !subclassItem) throw new UserError('No subclass to plan aspects or fragments with; pass `subclass`.');
      let setup: PlannedSubclassSetup | undefined;
      if (args.includeSubclassBonus !== false && subclassItem) {
        const ownership = planned ? await loadSubclassOwnership(ctx.profile, defs, character.id, subclassItem) : undefined;
        const summary = describeSubclass(subclassItem, inv, defs, planned && ['ASPECTS', 'FRAGMENTS'], ownership);
        setup = planSubclassSetup(summary, defs, character.classType, { aspects: args.aspects, fragments: args.fragments });
      }
      const bonus = setup?.bonus ?? ARMOR_STATS.map(() => 0);
      const bonusFrom = setup && [...setup.aspects, ...setup.fragments].filter((p) => p.statBonuses).map((p) => ({ plug: p.name, stats: p.statBonuses! }));

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
        plannedSetup: setup && planned ? { aspects: setup.aspects.map((p) => p.name), fragments: setup.fragments.map((p) => p.name), fragmentSlots: setup.fragmentSlots } : undefined,
        unowned: setup?.unowned,
        warning: setup?.warning,
        subclassStatBonus: bonus.some((b) => b !== 0) ? namedStats(bonus, defs) : undefined,
        subclassStatBonusFrom: bonusFrom?.length ? bonusFrom : undefined,
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

  server.registerTool(
    'champion_coverage',
    {
      title: 'Champion coverage',
      description:
        'Which champion types (Barrier, Overload, Unstoppable) a character can handle, and how: weapon frames and perks (the game\'s hidden champion traits, which item text does not show), exotic weapons and armor, ' +
        'the equipped artifact\'s perks, and subclass abilities, aspects and fragments whose stun verbs match the game\'s rules (suppress/slow/jolt = Overload, radiant/volatile/unraveling = Barrier, blind/suspend/shatter/ignition = Unstoppable). ' +
        'high confidence = marked by the game; medium = inferred from ability text. With scope "owned", it also lists owned weapons that fill each gap.',
      inputSchema: {
        character: z.string().optional().describe('Character id or class name; default is the most recently played'),
        items: z.array(z.string()).max(10).optional().describe('Check these weapons/exotic armor (ids or names) instead of what is equipped'),
        scope: z.enum(['equipped', 'owned']).optional().describe('owned: also suggest owned weapons for each missing champion type (default equipped)'),
        includeSubclass: z.boolean().optional().describe('Count the equipped subclass and artifact (default true)'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ character, items, scope, includeSubclass }) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character);
      const extras = { extendedBreaker: await ctx.community.get<Record<string, number>>('extendedBreaker'), overrides: loadOverrides() };
      const checked = items?.length
        ? resolveItems(inv, items)
        : inv.items.filter((i) => i.equipped && i.location.type === 'character' && i.location.characterId === c.id && (i.kind === 'weapon' || i.kind === 'armor'));
      const report = championCoverage(inv, defs, { items: checked, character: includeSubclass === false ? undefined : c, extras });
      const suggestions =
        scope === 'owned'
          ? Object.fromEntries(
              (report.gaps.length ? report.gaps : CHAMPIONS).map((champ) => [
                CHAMPION_NAMES[champ],
                ownedChampionWeapons(inv, defs, c, champ, extras).map(({ item, via }) => ({ ...briefItem(item, inv, defs), via: via!.via })),
              ]),
            )
          : undefined;
      return ok({
        character: c.className,
        checked: checked.filter((i) => i.kind === 'weapon' || i.isExotic).map((i) => i.name),
        champions: Object.fromEntries(CHAMPIONS.map((k) => [CHAMPION_NAMES[k], report.champions[k]])),
        gaps: report.gaps.map((g) => CHAMPION_NAMES[g]),
        ownedOptions: suggestions,
        communityData: extras.extendedBreaker ? undefined : 'DIM extended-breaker data unavailable; a few exotics may be missing',
      });
    }),
  );

  server.registerTool(
    'export_build',
    {
      title: 'Export build',
      description:
        'Saves what a character has equipped as a build spec (JSON): subclass super/abilities/aspects/fragments, exotic and armor pieces, set bonuses, current stats as targets, armor mods per slot, ' +
        'weapons with selected perks and mods, artifact perks, and covered champion types. Edit the file to turn it into a target, then check progress with audit_build.',
      inputSchema: {
        name: z.string().describe('Build name, e.g. "Nezarec\'s Sin gunplay"'),
        character: z.string().optional().describe('Character id or class name; default is the most recently played'),
        path: z.string().optional().describe(`File to write (absolute, or relative to the builds folder). Default: <builds folder>/<name>.json`),
        overwrite: z.boolean().optional().describe('Replace an existing file'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ name, character, path, overwrite }) => {
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character);
      const extras = { extendedBreaker: await ctx.community.get<Record<string, number>>('extendedBreaker'), overrides: loadOverrides() };
      const spec = exportBuild(inv, defs, c, name, extras);
      const file = specPath(ctx.config.buildsDir, path ?? `${slugify(name)}.json`);
      if (existsSync(file) && !overwrite) throw new UserError(`${file} already exists; pass overwrite: true to replace it.`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
      return ok({ file, spec });
    }),
  );

  server.registerTool(
    'audit_build',
    {
      title: 'Audit build',
      description:
        'Checks a character against a build spec (from export_build or hand-written): subclass pieces, exotic, armor pieces and set bonuses, stat targets, armor and weapon mods, selected weapon perks, masterworks, ' +
        'power-10 legacy weapons, artifact and artifact perks, and champion coverage. Returns the differences plus ready-made equip_items ids and apply_plugs changes (nothing is changed; confirm with the user and dry-run first).',
      inputSchema: {
        spec: z.string().describe('Spec file (absolute path, or a name/file in the builds folder)'),
        character: z.string().optional().describe('Character id or class name; default is the spec\'s class, else the most recently played'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ spec: ref, character }) => {
      const file = findSpec(ctx.config.buildsDir, ref);
      const parsed = BuildSpecSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (!parsed.success) throw new UserError(`${file} is not a valid build spec: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      const spec = parsed.data;
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character ?? spec.class);
      const extras = { extendedBreaker: await ctx.community.get<Record<string, number>>('extendedBreaker'), overrides: loadOverrides() };
      return ok({ file, build: spec.name, character: c.className, ...auditBuild(inv, defs, c, spec, extras) });
    }),
  );
}

const slugify = (name: string) => name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'build';

function specPath(buildsDir: string, ref: string): string {
  const p = expandHome(ref)!;
  return isAbsolute(p) ? p : join(buildsDir, p);
}

/** A spec by path, file name, or the `name` inside it. */
function findSpec(buildsDir: string, ref: string): string {
  const direct = specPath(buildsDir, ref);
  for (const candidate of [direct, `${direct}.json`, join(buildsDir, `${slugify(ref)}.json`)]) if (existsSync(candidate)) return candidate;
  if (existsSync(buildsDir)) {
    for (const f of readdirSync(buildsDir).filter((f) => f.endsWith('.json'))) {
      try {
        const spec = JSON.parse(readFileSync(join(buildsDir, f), 'utf8')) as { name?: string };
        if (spec.name && spec.name.toLowerCase() === ref.toLowerCase()) return join(buildsDir, f);
      } catch {
        // not a spec
      }
    }
  }
  throw new UserError(`No build spec "${ref}" (looked in ${buildsDir}). Create one with export_build.`);
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
