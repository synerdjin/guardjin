import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DestinyComponentType, type DestinyCollectibleDefinition, type DestinyProfileResponse, type DestinyRecordDefinition } from 'bungie-api-ts/destiny2';
import { z } from 'zod';
import type { Context } from '../context.js';
import { Rarity } from '../inventory/constants.js';
import { buildCharacters } from '../inventory/model.js';
import { buildCraftables } from '../progress/craftables.js';
import { buildWallet } from '../progress/currencies.js';
import { characterArtifacts, describeArtifact } from '../progress/artifact.js';
import { buildProgression } from '../progress/progression.js';
import { buildCommendations, buildKiosks, buildReceipts } from '../progress/social.js';
import {
  CollectibleState,
  RecordState,
  collectibleState,
  describeRecordObjectives,
  recordFraction,
  recordProgress,
} from '../progress/collections.js';
import { READ_ONLY, ok, paginate, resolveCharacter, safe } from './util.js';

const CANDIDATE_CAP = 1000;

export function registerProgressTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'get_progression',
    {
      title: 'Progression',
      description:
        'Your season and season pass rank, Guardian Rank, the equipped artifact with its active perks (get_artifact lists the options), faction and vendor ranks (with weekly progress), and milestone progress (weekly and daily activities with objectives). ' +
        'Use it to answer "what do I still need to do this week" and "how close am I to the next rank".',
      inputSchema: {
        character: z.string().optional().describe('Character id or class name. Default: most recently played'),
        milestones: z.enum(['incomplete', 'all', 'none']).optional().describe('Default: incomplete'),
        query: z.string().optional().describe('Case-insensitive substring filter for faction and milestone names'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ character, milestones, query }) => {
      const [profile, defs] = await Promise.all([
        ctx.profile.components([DestinyComponentType.Profiles, DestinyComponentType.Characters, DestinyComponentType.ProfileProgression, DestinyComponentType.CharacterProgressions]),
        ctx.manifest.load(),
      ]);
      const c = resolveCharacter({ characters: buildCharacters(profile, defs) }, character);
      const summary = buildProgression(profile, defs, c.id);
      const inv = await ctx.profile.inventory();
      const equippedArtifact = characterArtifacts(inv, c.id).find((a) => a.equipped);
      const q = query?.trim().toLowerCase();
      const match = (name: string) => !q || name.toLowerCase().includes(q);
      const show = milestones ?? 'incomplete';
      return ok({
        character: c.className,
        ...summary,
        artifact: summary.artifact ? { powerBonus: summary.artifact.powerBonus } : undefined,
        equippedArtifact: equippedArtifact ? describeArtifact(inv, defs, equippedArtifact) : undefined,
        factions: summary.factions.filter((f) => match(f.name)),
        milestones: show === 'none' ? undefined : summary.milestones.filter((m) => match(m.name) && (show === 'all' || !m.completed)),
      });
    }),
  );

  server.registerTool(
    'get_currencies',
    {
      title: 'Currencies and materials',
      description: 'Glimmer, Legendary Shards, Bright Dust and other currencies, Silver on each platform, and crafting/upgrade materials with quantities.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring of the name'),
        materials: z.boolean().optional().describe('Include materials and consumables (default true)'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, materials }) => {
      const [profile, defs] = await Promise.all([
        ctx.profile.components([DestinyComponentType.ProfileCurrencies, DestinyComponentType.PlatformSilver, DestinyComponentType.ProfileInventories]),
        ctx.manifest.load(),
      ]);
      const q = query?.trim().toLowerCase();
      const keep = <T extends { name: string }>(list: T[]) => list.filter((h) => !q || h.name.toLowerCase().includes(q));
      const wallet = buildWallet(profile, defs);
      return ok({
        currencies: keep(wallet.currencies),
        silver: keep(wallet.silver),
        materials: materials === false ? undefined : keep(wallet.materials),
      });
    }),
  );

  server.registerTool(
    'get_craftables',
    {
      title: 'Weapon patterns',
      description:
        'Weapon patterns: which weapons you can craft, and why the others are locked ("Pattern has not been unlocked."). ' +
        'Pattern progress (weapon kills, Deepsight) is in search_triumphs.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring of the weapon name or type'),
        status: z.enum(['unlocked', 'locked', 'all']).optional().describe('Default: all'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 60'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, status, limit }) => {
      const [profile, defs] = await Promise.all([ctx.profile.components([DestinyComponentType.Craftables]), ctx.manifest.load()]);
      const q = query?.trim().toLowerCase();
      const all = buildCraftables(profile, defs);
      const rows = all.filter(
        (c) =>
          (!q || c.name.toLowerCase().includes(q) || (c.type ?? '').toLowerCase().includes(q)) &&
          (status === undefined || status === 'all' || (status === 'unlocked') === c.unlocked),
      );
      const page = paginate(rows, 0, limit ?? 60);
      return ok({ unlocked: all.filter((c) => c.unlocked).length, locked: all.filter((c) => !c.unlocked).length, ...page, items: page.items.map((c) => ({ ...c, reasons: c.reasons.length ? c.reasons : undefined })) });
    }),
  );

  server.registerTool(
    'get_kiosks',
    {
      title: 'Kiosks',
      description: 'Kiosk contents per vendor: items a vendor lets you acquire or re-acquire, whether you can right now, and why not.',
      inputSchema: {
        vendor: z.string().optional().describe('Case-insensitive substring of the vendor name'),
        query: z.string().optional().describe('Case-insensitive substring of the item name or type'),
        onlyAcquirable: z.boolean().optional().describe('Only items you can acquire right now'),
        limit: z.number().int().min(1).max(100).optional().describe('Items per vendor. Default 25'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ vendor, query, onlyAcquirable, limit }) => {
      const [profile, defs] = await Promise.all([ctx.profile.components([DestinyComponentType.Kiosks]), ctx.manifest.load()]);
      const v = vendor?.trim().toLowerCase();
      const q = query?.trim().toLowerCase();
      const rows = buildKiosks(profile, defs)
        .filter((k) => !v || k.vendor.toLowerCase().includes(v))
        .map((k) => {
          const items = k.items.filter((i) => (!onlyAcquirable || i.canAcquire) && (!q || i.name.toLowerCase().includes(q) || (i.type ?? '').toLowerCase().includes(q)));
          return { vendor: k.vendor, total: k.total, acquirable: k.acquirable, matching: items.length, items: items.slice(0, limit ?? 25).map((i) => ({ ...i, reasons: i.reasons.length ? i.reasons : undefined })) };
        })
        .filter((k) => k.matching > 0 || (!q && !onlyAcquirable));
      return ok(rows.length ? rows : { vendors: [], note: 'No kiosk data matches. Many accounts have no kiosks; the game returns none.' });
    }),
  );

  server.registerTool(
    'get_vendor_receipts',
    {
      title: 'Vendor receipts',
      description: 'Recent vendor purchases that are still refundable: what you bought, what you paid, and when the refund window ends.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const [profile, defs] = await Promise.all([
        ctx.profile.components([DestinyComponentType.VendorReceipts, DestinyComponentType.Characters]),
        ctx.manifest.load(),
      ]);
      const characters = buildCharacters(profile, defs);
      const receipts = buildReceipts(profile, defs, (id) => characters.find((c) => c.id === id)?.className);
      return ok(receipts.length ? receipts : { receipts: [], note: 'No refundable purchases right now.' });
    }),
  );

  server.registerTool(
    'get_commendations',
    {
      title: 'Commendations',
      description: 'Your commendation score and the breakdown by category (Mastery, Leadership, Resilience, Ingenuity and their commendations).',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const [profile, defs] = await Promise.all([ctx.profile.components([DestinyComponentType.SocialCommendations]), ctx.manifest.load()]);
      return ok(buildCommendations(profile, defs) ?? { totalScore: 0, nodes: [] });
    }),
  );

  server.registerTool(
    'search_collectibles',
    {
      title: 'Search collections',
      description:
        'Searches the Collections screen: which weapons, armor, exotics, ornaments, shaders and more you have or are missing, with where each one comes from. ' +
        'Defaults to items you have NOT collected. Use rarity "exotic" to find missing exotics.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring of the collectible name'),
        collected: z.enum(['yes', 'no', 'all']).optional().describe('Default: no (missing items)'),
        rarity: z.enum(['exotic', 'legendary', 'rare', 'uncommon', 'common']).optional(),
        type: z.string().optional().describe('Substring of the item type, e.g. "Hand Cannon", "Helmet", "Shader", "Ornament"'),
        source: z.string().optional().describe('Substring of the source text, e.g. "Vesper", "raid", "Trials"'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 40'),
      },
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const [defs, inv] = await Promise.all([ctx.manifest.load(), ctx.profile.inventory()]);
      const profile = await ctx.profile.components([DestinyComponentType.Collectibles]);
      const charIds = inv.characters.map((c) => c.id);
      const want = args.collected ?? 'no';
      const type = args.type?.toLowerCase();
      const source = args.source?.toLowerCase();

      // With a query the manifest narrows candidates in SQL; otherwise walk everything the profile lists.
      const candidates: DestinyCollectibleDefinition[] = args.query
        ? defs.searchTable<DestinyCollectibleDefinition>('DestinyCollectibleDefinition', args.query, CANDIDATE_CAP)
        : allCollectibleHashes(profile, charIds).flatMap((h) => defs.collectible(h) ?? []);

      const rows = candidates.flatMap((c) => {
        const state = collectibleState(profile, c.hash, charIds);
        if (state === undefined || (state & CollectibleState.Invisible) !== 0) return [];
        const collected = (state & CollectibleState.NotAcquired) === 0;
        if ((want === 'yes' && !collected) || (want === 'no' && collected)) return [];
        const item = defs.item(c.itemHash);
        const rarity = Rarity[item?.inventory?.tierType ?? 0];
        if (args.rarity && rarity !== args.rarity) return [];
        if (type && !(item?.itemTypeDisplayName ?? '').toLowerCase().includes(type)) return [];
        if (source && !(c.sourceString ?? '').toLowerCase().includes(source)) return [];
        if (!c.displayProperties.name) return [];
        return [{ name: c.displayProperties.name, type: item?.itemTypeDisplayName || undefined, rarity, collected, source: c.sourceString || undefined }];
      });
      rows.sort((a, b) => a.name.localeCompare(b.name));
      return ok(paginate(rows, args.offset ?? 0, args.limit ?? 40));
    }),
  );

  server.registerTool(
    'search_triumphs',
    {
      title: 'Search Triumphs',
      description:
        'Searches Triumphs (records): exotic catalysts, seals and titles, lore, activity and weapon challenges, with objective progress. ' +
        'Defaults to incomplete Triumphs sorted by how close you are to finishing. Includes your Triumph scores.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring of the Triumph name, e.g. "catalyst", "Rivensbane"'),
        status: z.enum(['incomplete', 'complete', 'all']).optional().describe('Default: incomplete'),
        titlesOnly: z.boolean().optional().describe('Only Triumphs that grant a title'),
        sort: z.enum(['progress', 'name']).optional().describe('Default: progress (closest to done first)'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
      },
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const [defs, inv] = await Promise.all([ctx.manifest.load(), ctx.profile.inventory()]);
      const profile = await ctx.profile.components([DestinyComponentType.Records]);
      const charIds = inv.characters.map((c) => c.id);
      const want = args.status ?? 'incomplete';

      const candidates: DestinyRecordDefinition[] = args.query
        ? defs.searchTable<DestinyRecordDefinition>('DestinyRecordDefinition', args.query, CANDIDATE_CAP)
        : allRecordHashes(profile, charIds).flatMap((h) => defs.record(h) ?? []);

      const rows = candidates.flatMap((def) => {
        const rec = recordProgress(profile, def.hash, charIds);
        if (!rec || (rec.state & RecordState.Invisible) !== 0 || !def.displayProperties.name) return [];
        const complete = (rec.state & RecordState.ObjectiveNotCompleted) === 0;
        if ((want === 'complete' && !complete) || (want === 'incomplete' && complete)) return [];
        if (args.titlesOnly && !def.titleInfo?.hasTitle) return [];
        const fraction = recordFraction(rec.objectives);
        return [
          {
            name: def.displayProperties.name,
            description: def.displayProperties.description?.trim() || undefined,
            complete,
            redeemed: (rec.state & RecordState.Redeemed) !== 0 || undefined,
            title: def.titleInfo?.hasTitle || undefined,
            percent: Math.round(fraction * 100),
            objectives: describeRecordObjectives(rec.objectives, defs),
            fraction,
          },
        ];
      });
      rows.sort((a, b) => (args.sort === 'name' ? a.name.localeCompare(b.name) : b.fraction - a.fraction || a.name.localeCompare(b.name)));
      const page = paginate(rows, args.offset ?? 0, args.limit ?? 25);
      const records = profile.profileRecords?.data;
      return ok({
        score: records && { active: records.activeScore, legacy: records.legacyScore, lifetime: records.lifetimeScore },
        ...page,
        items: page.items.map(({ fraction: _f, ...rest }) => rest),
      });
    }),
  );
}

function allCollectibleHashes(profile: DestinyProfileResponse, charIds: string[]): number[] {
  const hashes = new Set(Object.keys(profile.profileCollectibles?.data?.collectibles ?? {}).map(Number));
  for (const id of charIds) for (const h of Object.keys(profile.characterCollectibles?.data?.[id]?.collectibles ?? {})) hashes.add(Number(h));
  return [...hashes];
}

function allRecordHashes(profile: DestinyProfileResponse, charIds: string[]): number[] {
  const hashes = new Set(Object.keys(profile.profileRecords?.data?.records ?? {}).map(Number));
  for (const id of charIds) for (const h of Object.keys(profile.characterRecords?.data?.[id]?.records ?? {})) hashes.add(Number(h));
  return [...hashes];
}
