import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { findDuplicates, suggestCleanup, vaultSummary } from '../vault/analysis.js';
import { evaluateRoll, type Wishlist } from '../vault/wishlist.js';
import { READ_ONLY, briefItem, ok, paginate, resolveItem, safe } from './util.js';

export function registerVaultTools(server: McpServer, ctx: Context): void {
  const loadWishlist = async (use: boolean | undefined): Promise<{ wishlist?: Wishlist; warning?: string }> => {
    if (use === false) return {};
    try {
      return { wishlist: await ctx.wishlist.get() };
    } catch (err) {
      return { warning: `Wishlist unavailable: ${(err as Error).message}` };
    }
  };

  server.registerTool(
    'vault_summary',
    {
      title: 'Vault summary',
      description: 'Vault space used vs capacity with a breakdown by slot, how full each character’s weapon/armor buckets are, and postmaster counts.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      return ok(vaultSummary(inv, defs));
    }),
  );

  server.registerTool(
    'find_duplicates',
    {
      title: 'Find duplicates',
      description:
        'Groups weapons you own more than one of (by name, so reissues are grouped) and duplicate exotic armor, comparing each copy: perks, power, tier, lock state, and the community wishlist verdict for weapon rolls.',
      inputSchema: {
        kind: z.enum(['weapon', 'armor', 'all']).optional().describe('Default: all'),
        useWishlist: z.boolean().optional().describe('Rate weapon rolls with the wishlist (default true)'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Groups per page (default 25)'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ kind = 'all', useWishlist, offset, limit }) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const { wishlist, warning } = await loadWishlist(useWishlist);
      const groups = findDuplicates(inv, defs, wishlist).filter((g) => kind === 'all' || g.kind === kind);
      const page = paginate(groups, offset ?? 0, limit ?? 25);
      return ok({
        warning,
        ...page,
        items: page.items.map((g) => ({
          name: g.name,
          kind: g.kind,
          copies: g.items.map(({ item, wishlist: w }) => ({
            ...briefItem(item, inv, defs),
            wishlist: w ? { verdict: w.verdict, matchedPerks: w.matchedPerks, notes: w.notes?.[0] } : undefined,
          })),
        })),
      });
    }),
  );

  server.registerTool(
    'suggest_cleanup',
    {
      title: 'Suggest vault cleanup',
      description:
        'Ranks items that are probably safe to dismantle, each with a reason: armor beaten in every stat by another piece of the same slot/set/tier (dominated-armor), rolls the wishlist marks as trash, worse copies of duplicated weapons, and low-tier armor when you own Tier 4+ pieces. ' +
        'Locked and equipped items are skipped unless includeLocked is set. confidence 3 = strong, 1 = worth a look. Nothing is changed; the API cannot dismantle items.',
      inputSchema: {
        kinds: z.array(z.enum(['weapon', 'armor'])).optional().describe('Default: both'),
        includeLocked: z.boolean().optional(),
        minConfidence: z.number().int().min(1).max(3).optional().describe('Default 1'),
        useWishlist: z.boolean().optional().describe('Default true'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ kinds, includeLocked, minConfidence = 1, useWishlist, offset, limit }) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const { wishlist, warning } = await loadWishlist(useWishlist);
      const candidates = suggestCleanup(inv, defs, { wishlist, includeLocked, kinds }).filter((c) => c.confidence >= minConfidence);
      const page = paginate(candidates, offset ?? 0, limit ?? 50);
      return ok({
        warning,
        ...page,
        items: page.items.map((c) => ({ reason: c.reason, confidence: c.confidence, detail: c.detail, item: briefItem(c.item, inv, defs, { masterworkedStats: true }) })),
        tip: 'To act on this: lock the items you want to keep (set_lock_state), then dismantle unlocked items in game.',
      });
    }),
  );

  server.registerTool(
    'check_wishlist',
    {
      title: 'Check wishlist',
      description:
        'Rates weapon rolls against the community wishlist (DIM format, voltron by default): "wishlist" (a recommended roll is available), "trash", "not-on-wishlist" (the weapon is listed but this roll is not), or "unknown" (weapon not covered). Checks one weapon, or all weapons with an optional verdict filter.',
      inputSchema: {
        item: z.string().optional().describe('Item id or unique name; omit to check all weapons'),
        verdict: z.enum(['wishlist', 'trash', 'not-on-wishlist', 'unknown']).optional().describe('Only return weapons with this verdict'),
        refresh: z.boolean().optional().describe('Re-download the wishlist now (otherwise cached for 24h)'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ item: ref, verdict, refresh, offset, limit }) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const wishlist = await ctx.wishlist.get(refresh ?? false);
      const weapons = ref ? [resolveItem(inv, ref)] : inv.items.filter((i) => i.kind === 'weapon' && i.instanceId);
      const rated = weapons
        .map((w) => ({ item: w, result: evaluateRoll(w, wishlist, defs) }))
        .filter((r) => !verdict || r.result.verdict === verdict)
        .sort((a, b) => a.item.name.localeCompare(b.item.name));
      const page = paginate(rated, offset ?? 0, limit ?? 50);
      return ok({
        wishlist: { title: wishlist.title, entries: wishlist.size },
        ...page,
        items: page.items.map(({ item, result }) => ({ ...briefItem(item, inv, defs), ...result })),
      });
    }),
  );
}
