import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DestinyComponentType, getPublicMilestones, getPublicVendors, getVendor, type DestinyVendorDefinition, type DestinyVendorResponse } from 'bungie-api-ts/destiny2';
import { z } from 'zod';
import type { Defs } from '../manifest/defs.js';
import type { Context } from '../context.js';
import { unwrap } from '../bungie/http.js';
import { buildCharacters } from '../inventory/model.js';
import { Rarity } from '../inventory/constants.js';
import { isCollected } from '../progress/collections.js';
import { availableActivities, buildCurrentActivity } from '../world/activity.js';
import { costText } from '../world/vendors.js';
import { buildWeekly } from '../world/weekly.js';
import { matchActivities, readModifiers, type ActivityCandidate } from '../world/plan.js';
import { CHAMPION_NAMES, championCoverage, loadOverrides, ownedChampionWeapons } from '../builds/champions.js';
import { describeSubclass } from '../inventory/subclass.js';
import type { Item } from '../inventory/model.js';
import { READ_ONLY, UserError, ok, paginate, resolveCharacter, safe } from './util.js';

/** Vendors often have several definitions under one name; callers try each until one has stock. */
function vendorCandidates(defs: Defs, vendor: string): number[] {
  if (/^\d+$/.test(vendor.trim())) return [Number(vendor.trim())];
  const found = defs.searchTable<DestinyVendorDefinition>('DestinyVendorDefinition', vendor.trim(), 25).filter((v) => v.displayProperties.name);
  const exact = found.filter((v) => v.displayProperties.name.toLowerCase() === vendor.trim().toLowerCase());
  const pool = (exact.length ? exact : found).sort((a, b) => Number(b.enabled) - Number(a.enabled));
  if (!pool.length) throw new UserError(`No vendor matches "${vendor}".`);
  if (new Set(pool.map((v) => v.displayProperties.name)).size > 1) {
    throw new UserError(`"${vendor}" matches several vendors: ${[...new Set(pool.map((v) => v.displayProperties.name))].join(', ')}. Use the full name.`);
  }
  return pool.map((v) => v.hash);
}

export function registerWorldTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'get_weekly_activities',
    {
      title: 'Weekly and daily activities',
      description:
        'Lists what is active in the game right now: featured raids and dungeons, Nightfall, Trials, ritual playlists and other milestones, with the activities, modifiers, ' +
        'challenges, attached vendors and when each rotates out. Public data, the same for every player.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring of a milestone, activity, modifier or challenge name'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 30'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, offset, limit }) => {
      const [milestones, defs] = await Promise.all([unwrap(getPublicMilestones(ctx.http)), ctx.manifest.load()]);
      const q = query?.trim().toLowerCase();
      const all = buildWeekly(milestones, defs).filter(
        (m) =>
          !q ||
          [m.name, ...m.vendors, ...m.activities.flatMap((a) => [a.name, ...a.modifiers, ...a.challenges])].some((t) => t.toLowerCase().includes(q)),
      );
      return ok(paginate(all, offset ?? 0, limit ?? 30));
    }),
  );

  server.registerTool(
    'get_current_activity',
    {
      title: 'Current activity',
      description:
        'What a character is doing right now: offline, in orbit or a social space, or inside an activity (with its modes, start time and score), plus your fireteam and open slots. ' +
        '`gearChangesLikely` says whether gear, mod and loadout changes will probably be accepted. Optionally lists the activities the character can launch (passing query, offset or limit implies it).',
      inputSchema: {
        character: z.string().optional().describe('Character id or class name. Default: most recently played'),
        available: z.boolean().optional().describe('Also list activities the character can launch now'),
        query: z.string().optional().describe('With available: case-insensitive substring of the activity or modifier name'),
        offset: z.number().int().min(0).optional().describe('With available: skip this many results (default 0)'),
        limit: z.number().int().min(1).max(100).optional().describe('With available: default 30'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ character, available, query, offset, limit }) => {
      const [profile, defs] = await Promise.all([
        ctx.profile.components([DestinyComponentType.Characters, DestinyComponentType.CharacterActivities, DestinyComponentType.Transitory]),
        ctx.manifest.load(),
      ]);
      const c = resolveCharacter({ characters: buildCharacters(profile, defs) }, character);
      const activities = profile.characterActivities?.data?.[c.id];
      const current = buildCurrentActivity(activities, profile.profileTransitoryData?.data, defs);
      const q = query?.trim().toLowerCase();
      const list = (available ?? (query ?? offset ?? limit) !== undefined)
        ? availableActivities(activities, defs).filter((a) => !q || a.name.toLowerCase().includes(q) || a.modifiers.some((m) => m.toLowerCase().includes(q)))
        : undefined;
      return ok({ character: c.className, ...current, available: list && paginate(list, offset ?? 0, limit ?? 30) });
    }),
  );

  server.registerTool(
    'get_vendor',
    {
      title: 'Vendor inventory',
      description:
        'Shows what a vendor (Xûr, Banshee-44, Ada-1, Rahool, Eververse...) is selling right now, with costs and whether you already have each item in your collection or inventory. ' +
        'Fails when the vendor is not currently available (for example Xûr midweek).',
      inputSchema: {
        vendor: z.string().describe('Vendor name, e.g. "Xûr", or a vendor hash'),
        character: z.string().optional().describe('Character id or class name whose sales to show. Default: most recently played'),
        public: z.boolean().optional().describe('Use the public, character-independent stock: works when the personal lookup fails, but has no ownership info'),
        onlyNew: z.boolean().optional().describe('Hide items you already have collected (not available with public)'),
        query: z.string().optional().describe('Case-insensitive substring of the item name or type'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 50'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ vendor, character, onlyNew, query, offset, limit, public: publicStock }) => {
      const defs = await ctx.manifest.load();
      const account = await ctx.account.get();
      const inv = await ctx.profile.inventory();
      const char = resolveCharacter(inv, character);

      const candidates = vendorCandidates(defs, vendor);
      const q = query?.trim().toLowerCase();

      if (publicStock) {
        const pub = await unwrap(getPublicVendors(ctx.http, { components: [DestinyComponentType.Vendors, DestinyComponentType.VendorSales] }));
        const hash = candidates.find((h) => Object.keys(pub.sales?.data?.[h]?.saleItems ?? {}).length);
        if (hash === undefined) throw new UserError(`${defs.vendor(candidates[0])?.displayProperties.name ?? vendor} has no public stock right now.`);
        const items = Object.values(pub.sales?.data?.[hash]?.saleItems ?? {})
          .filter((s) => s.itemHash)
          .map((s) => {
            const def = defs.item(s.itemHash);
            return { name: def?.displayProperties.name ?? `#${s.itemHash}`, type: def?.itemTypeDisplayName, rarity: Rarity[def?.inventory?.tierType ?? 0], quantity: s.quantity > 1 ? s.quantity : undefined, cost: costText(defs, s.costs) };
          })
          .filter((i) => !q || i.name.toLowerCase().includes(q) || (i.type ?? '').toLowerCase().includes(q));
        return ok({ vendor: defs.vendor(hash)?.displayProperties.name ?? hash, public: true, nextRefresh: pub.vendors?.data?.[hash]?.nextRefreshDate, ...paginate(items, offset ?? 0, limit ?? 50) });
      }

      let response: DestinyVendorResponse | undefined;
      let vendorHash = candidates[0];
      let lastError: unknown;
      for (const hash of candidates) {
        try {
          const r = await unwrap(
            getVendor(ctx.http, {
              membershipType: account.membershipType,
              destinyMembershipId: account.membershipId,
              characterId: char.id,
              vendorHash: hash,
              components: [DestinyComponentType.Vendors, DestinyComponentType.VendorSales],
            }),
          );
          if (Object.keys(r.sales?.data ?? {}).length) {
            response = r;
            vendorHash = hash;
            break;
          }
        } catch (err) {
          lastError = err;
        }
      }
      if (!response) {
        throw new UserError(`${defs.vendor(candidates[0])?.displayProperties.name ?? vendor} has nothing for sale right now${lastError ? ` (${(lastError as Error).message})` : ''}.`);
      }
      // Personal sales often omit costs; the public stock (Xûr) has them.
      const publicCosts = new Map<number, { itemHash: number; quantity: number }[]>();
      if (Object.values(response.sales?.data ?? {}).some((s) => !s.costs.length)) {
        try {
          const pub = await unwrap(getPublicVendors(ctx.http, { components: [DestinyComponentType.Vendors, DestinyComponentType.VendorSales] }));
          for (const sale of Object.values(pub.sales?.data?.[vendorHash]?.saleItems ?? {})) if (sale.costs.length) publicCosts.set(sale.itemHash, sale.costs);
        } catch {
          // Costs are a nicety; the personal stock is still valid without them.
        }
      }
      const profile = await ctx.profile.components([DestinyComponentType.Collectibles]);
      const owned = new Set(inv.items.map((i) => i.hash));
      const charIds = inv.characters.map((c) => c.id);
      const items = Object.values(response.sales?.data ?? {})
        .filter((s) => s.itemHash)
        .map((s) => {
          const def = defs.item(s.itemHash);
          const collected = isCollected(profile, def?.collectibleHash, charIds);
          return {
            name: def?.displayProperties.name ?? `#${s.itemHash}`,
            type: def?.itemTypeDisplayName,
            rarity: Rarity[def?.inventory?.tierType ?? 0],
            quantity: s.quantity > 1 ? s.quantity : undefined,
            cost: costText(defs, s.costs.length ? s.costs : (publicCosts.get(s.itemHash) ?? [])),
            collected,
            inInventory: owned.has(s.itemHash) || undefined,
            available: s.saleStatus === 0 || undefined,
          };
        })
        .filter((i) => !onlyNew || i.collected !== true)
        .filter((i) => !q || i.name.toLowerCase().includes(q) || (i.type ?? '').toLowerCase().includes(q));

      const vendorDef = defs.vendor(vendorHash);
      return ok({
        vendor: vendorDef?.displayProperties.name ?? vendorHash,
        nextRefresh: response.vendor?.data?.nextRefreshDate,
        ...paginate(items, offset ?? 0, limit ?? 50),
      });
    }),
  );

  server.registerTool(
    'plan_activity',
    {
      title: 'Plan an activity',
      description:
        'Prepares a character for an activity (Nightfall, Grandmaster, Master dungeon/raid, Portal activity, Lost Sector...): reads its current modifiers (champion types, shield elements, surges, threats, overcharged weapons, ' +
        'equipment locks, fixed power) and recommended power, and checks the character against them: champion coverage from gear, subclass and artifact, weapons matching shields and surges, power gap. ' +
        'Gaps come with owned weapons that fill them. Matches the activity by name words (e.g. "grandmaster", "nightfall", "duality master").',
      inputSchema: {
        activity: z.string().describe('Words from the activity name or kind, e.g. "Nightfall", "Grandmaster", "Duality Master"'),
        character: z.string().optional().describe('Character id or class name; default is the most recently played'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ activity, character }) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character);
      const acts = await ctx.profile.components([DestinyComponentType.CharacterActivities]);
      const candidates: ActivityCandidate[] = (acts.characterActivities?.data?.[c.id]?.availableActivities ?? []).flatMap((a) => {
        const name = defs.activity(a.activityHash)?.displayProperties.name;
        return name && a.isVisible
          ? [{ activityHash: a.activityHash, name, recommendedLight: a.recommendedLight || undefined, modifierHashes: a.modifierHashes ?? [], source: 'available' as const, canLead: a.canLead }]
          : [];
      });
      try {
        const milestones = await unwrap(getPublicMilestones(ctx.http));
        for (const m of Object.values(milestones)) {
          for (const a of m.activities ?? []) {
            const name = defs.activity(a.activityHash)?.displayProperties.name;
            if (name) candidates.push({ activityHash: a.activityHash, name, modifierHashes: a.modifierHashes ?? [], source: 'weekly', recommendedLight: defs.activity(a.activityHash)?.activityLightLevel || undefined });
          }
        }
      } catch {
        // weekly data is a bonus; the character's own activity list usually has the featured ones
      }
      const matches = matchActivities(defs, candidates, activity);
      if (!matches.length) {
        throw new UserError(`No current activity matches "${activity}". Some available ones: ${[...new Set(candidates.filter((x) => x.modifierHashes.length > 1).map((x) => x.name))].slice(0, 25).join(', ')}`);
      }
      const pick = matches[0];
      const req = readModifiers(defs, pick.modifierHashes);
      const equipped = inv.items.filter((i) => i.equipped && i.location.type === 'character' && i.location.characterId === c.id);
      const weapons = equipped.filter((i) => i.kind === 'weapon');
      const extras = { extendedBreaker: await ctx.community.get<Record<string, number>>('extendedBreaker'), overrides: loadOverrides() };
      const coverage = championCoverage(inv, defs, { items: equipped, character: c, extras });
      const usable = (i: Item) =>
        i.kind === 'weapon' && !!i.instanceId && !i.equipped && i.location.type !== 'postmaster' && (i.power ?? 0) > 10;
      const byElement = (el: string) =>
        inv.items
          .filter((i) => usable(i) && i.weapon?.element === el)
          .sort((a, b) => Number(a.isExotic) - Number(b.isExotic) || (b.gearTier ?? 0) - (a.gearTier ?? 0) || (b.power ?? 0) - (a.power ?? 0))
          .slice(0, 3)
          .map((i) => `${i.name} [${i.instanceId}] (${i.typeName}, ${i.slot}${i.gearTier ? `, T${i.gearTier}` : ''})`);
      const subclass = equipped.find((i) => i.kind === 'subclass');
      const subclassElement = subclass ? describeSubclass(subclass, inv, defs, false).element : undefined;

      const championGaps = req.champions.filter((ch) => !coverage.champions[ch].covered);
      return ok({
        activity: pick.name,
        source: pick.source,
        owned: pick.canLead === false ? false : undefined,
        power: pick.recommendedLight ? { recommended: pick.recommendedLight, yours: c.light, gap: Math.max(0, pick.recommendedLight - c.light) || undefined } : { yours: c.light },
        champions: req.champions.length
          ? Object.fromEntries(
              req.champions.map((ch) => [
                CHAMPION_NAMES[ch],
                coverage.champions[ch].covered
                  ? { covered: true, by: coverage.champions[ch].by.slice(0, 4).map((b) => `${b.via} (${b.confidence})`) }
                  : { covered: false, ownedOptions: ownedChampionWeapons(inv, defs, c, ch, extras, 4).map(({ item, via }) => `${item.name} [${item.instanceId}] (${via!.via})`) },
              ]),
            )
          : undefined,
        championGaps: championGaps.map((g) => CHAMPION_NAMES[g]),
        shields: req.shields.length
          ? req.shields.map((el) => {
              const have = weapons.filter((w) => w.weapon?.element === el).map((w) => w.name);
              return { element: el, equippedWeapons: have, ownedOptions: have.length ? undefined : byElement(el) };
            })
          : undefined,
        surges: req.surges.length
          ? req.surges.map((el) => ({ element: el, equippedWeapons: weapons.filter((w) => w.weapon?.element === el).map((w) => w.name), subclassMatches: subclassElement === el || undefined }))
          : undefined,
        threats: req.threats.length ? req.threats.map((el) => `${el} damage hurts more: consider ${el} resistance mods and avoid standing in ${el} effects`) : undefined,
        overcharged: req.overcharged.length ? req.overcharged : undefined,
        restrictions: req.restrictions.length ? [...req.restrictions, 'Set up your loadout before launching.'] : undefined,
        otherModifiers: req.other,
        otherMatches: matches.length > 1 ? [...new Set(matches.slice(1, 8).map((m) => m.name))] : undefined,
      });
    }),
  );

}
