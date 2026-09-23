import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DestinyComponentType, getPublicMilestones, getVendor, type DestinyVendorDefinition, type DestinyVendorResponse } from 'bungie-api-ts/destiny2';
import { z } from 'zod';
import type { Context } from '../context.js';
import { unwrap } from '../bungie/http.js';
import { Rarity } from '../inventory/constants.js';
import { isCollected } from '../progress/collections.js';
import { buildWeekly } from '../world/weekly.js';
import { READ_ONLY, UserError, ok, paginate, resolveCharacter, safe } from './util.js';

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
        limit: z.number().int().min(1).max(100).optional().describe('Default 30'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, limit }) => {
      const [milestones, defs] = await Promise.all([unwrap(getPublicMilestones(ctx.http)), ctx.manifest.load()]);
      const q = query?.trim().toLowerCase();
      const all = buildWeekly(milestones, defs).filter(
        (m) =>
          !q ||
          [m.name, ...m.vendors, ...m.activities.flatMap((a) => [a.name, ...a.modifiers, ...a.challenges])].some((t) => t.toLowerCase().includes(q)),
      );
      return ok(paginate(all, 0, limit ?? 30));
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
        onlyNew: z.boolean().optional().describe('Hide items you already have collected'),
        query: z.string().optional().describe('Case-insensitive substring of the item name or type'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 50'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ vendor, character, onlyNew, query, limit }) => {
      const defs = await ctx.manifest.load();
      const account = await ctx.account.get();
      const inv = await ctx.profile.inventory();
      const char = resolveCharacter(inv, character);

      // Vendors often have several definitions under one name; only the live one answers with sales.
      let candidates: number[];
      if (/^\d+$/.test(vendor.trim())) {
        candidates = [Number(vendor.trim())];
      } else {
        const found = defs.searchTable<DestinyVendorDefinition>('DestinyVendorDefinition', vendor.trim(), 25).filter((v) => v.displayProperties.name);
        const exact = found.filter((v) => v.displayProperties.name.toLowerCase() === vendor.trim().toLowerCase());
        const pool = (exact.length ? exact : found).sort((a, b) => Number(b.enabled) - Number(a.enabled));
        if (!pool.length) throw new UserError(`No vendor matches "${vendor}".`);
        if (new Set(pool.map((v) => v.displayProperties.name)).size > 1) {
          throw new UserError(`"${vendor}" matches several vendors: ${[...new Set(pool.map((v) => v.displayProperties.name))].join(', ')}. Use the full name.`);
        }
        candidates = pool.map((v) => v.hash);
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
      const profile = await ctx.profile.components([DestinyComponentType.Collectibles]);
      const owned = new Set(inv.items.map((i) => i.hash));
      const charIds = inv.characters.map((c) => c.id);
      const q = query?.trim().toLowerCase();

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
            cost: s.costs.length ? s.costs.map((c) => `${defs.item(c.itemHash)?.displayProperties.name ?? `#${c.itemHash}`}${c.quantity > 1 ? ` x${c.quantity}` : ''}`) : undefined,
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
        ...paginate(items, 0, limit ?? 50),
      });
    }),
  );
}
