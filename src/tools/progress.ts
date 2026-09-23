import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DestinyComponentType, type DestinyCollectibleDefinition, type DestinyProfileResponse, type DestinyRecordDefinition } from 'bungie-api-ts/destiny2';
import { z } from 'zod';
import type { Context } from '../context.js';
import { Rarity } from '../inventory/constants.js';
import {
  CollectibleState,
  RecordState,
  collectibleState,
  describeRecordObjectives,
  recordFraction,
  recordProgress,
} from '../progress/collections.js';
import { READ_ONLY, ok, paginate, safe } from './util.js';

const CANDIDATE_CAP = 1000;

export function registerProgressTools(server: McpServer, ctx: Context): void {
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
