import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import type { InventoryModel, Item } from '../inventory/model.js';
import { buildLoadouts } from '../loadouts/loadouts.js';
import { buildWallet } from '../progress/currencies.js';
import { newerThan, type SnapshotStore } from '../store/snapshots.js';
import { loadRules, triage } from '../vault/triage.js';
import { READ_ONLY, UserError, briefItem, ok, safe } from './util.js';

const iso = (t: number | undefined) => (t ? new Date(t).toISOString() : undefined);

function parseSince(since: string | undefined): number | undefined {
  if (!since) return undefined;
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new UserError(`"${since}" is not a date; use e.g. "2026-09-24" or "2026-09-24T17:00:00Z".`);
  return t;
}

function requireStore(ctx: Context): SnapshotStore {
  if (!ctx.store) throw new UserError('Local history is unavailable (the database in the guardjin home folder could not be opened).');
  return ctx.store;
}

/** What changed between a snapshot and now: lock, masterwork, tier and power changes; character power; currencies. */
function diffAgainstSnapshot(store: SnapshotStore, snapshotId: number, inv: InventoryModel, currencies: { name: string; quantity: number }[]) {
  const before = store.snapshotItems(snapshotId);
  const changed: { name: string; id: string; changes: string[] }[] = [];
  for (const i of inv.items) {
    const b = i.instanceId ? before.get(i.instanceId) : undefined;
    if (!b) continue;
    const changes: string[] = [];
    if (b.locked !== i.locked) changes.push(i.locked ? 'locked' : 'unlocked');
    if (!b.masterworked && i.masterworked) changes.push('masterworked');
    if ((b.tier ?? 0) !== (i.gearTier ?? 0)) changes.push(`tier ${b.tier ?? '-'} → ${i.gearTier ?? '-'}`);
    if (b.power !== undefined && i.power !== undefined && i.power > b.power) changes.push(`power ${b.power} → ${i.power}`);
    if (changes.length) changed.push({ name: i.name, id: i.instanceId!, changes });
  }
  const chars = store.snapshotCharacters(snapshotId);
  const power = inv.characters.flatMap((c) => {
    const b = chars.find((x) => x.characterId === c.id);
    return b && b.light !== c.light ? [`${c.className} ${b.light} → ${c.light}`] : [];
  });
  const oldCurrencies = store.snapshotCurrencies(snapshotId);
  const currencyChanges = currencies.flatMap((c) => {
    const was = oldCurrencies.get(c.name);
    return was !== undefined && was !== c.quantity ? [`${c.name} ${was} → ${c.quantity} (${c.quantity > was ? '+' : ''}${c.quantity - was})`] : [];
  });
  return { changed, power, currencies: currencyChanges };
}

export function registerTrackingTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'whats_new',
    {
      title: "What's new",
      description:
        'What changed in your inventory over time, from guardjin\'s local history (Bungie\'s API has no acquisition dates): new weapons and armor since a date, items that are gone (dismantled), ' +
        'lock/masterwork/tier/power changes, character power and currency changes. History starts the first time guardjin reads your inventory; for older drops use `afterItem` ' +
        '(instance ids grow over time, so anything with a larger id dropped later) or `newest`. Without arguments it reports changes since the last whats_new call.',
      inputSchema: {
        since: z.string().optional().describe('Date or date-time, e.g. "2026-09-24"'),
        afterItem: z.string().optional().describe('Instance id of an item; lists items that dropped after it'),
        newest: z.number().int().min(1).max(100).optional().describe('Just list your N most recently dropped weapons/armor (by instance id)'),
        kind: z.enum(['weapon', 'armor', 'all']).optional().describe('Default all'),
        snapshotNow: z.boolean().optional().describe('Also save a full snapshot now, as a checkpoint for later comparisons'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ since, afterItem, newest, kind, snapshotNow }) => {
      const store = requireStore(ctx);
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const wallet = buildWallet(inv.raw, defs).currencies;
      if (snapshotNow) store.maybeSnapshot(inv, { force: true, manifestVersion: defs.version, currencies: wallet });
      const wanted = (i: Item) => !!i.instanceId && (i.kind === 'weapon' || i.kind === 'armor') && (!kind || kind === 'all' || i.kind === kind);
      const trackingSince = store.trackingSince();

      if (afterItem || newest) {
        const items = inv.items.filter(wanted).sort((a, b) => (newerThan(a.instanceId!, b.instanceId!) ? -1 : 1));
        const list = afterItem ? items.filter((i) => newerThan(i.instanceId!, afterItem)) : items.slice(0, newest);
        return ok({ basis: afterItem ? `dropped after item ${afterItem}` : `your ${newest} newest drops`, count: list.length, items: list.map((i) => briefItem(i, inv, defs)) });
      }

      const from = parseSince(since) ?? Number(store.getMeta('last_whats_new') ?? trackingSince ?? Date.now());
      store.setMeta('last_whats_new', String(Date.now()));
      const { added, gone } = store.changesSince(from);
      const snap = store.snapshotAt(from);
      const diff = snap ? diffAgainstSnapshot(store, snap.id, inv, wallet) : undefined;
      const beforeTracking = trackingSince !== undefined && from < trackingSince;
      return ok({
        since: iso(from),
        trackingSince: iso(trackingSince),
        note: beforeTracking
          ? `Local history starts ${iso(trackingSince)}; items you already had then aren't dated. Use afterItem (an item you know dropped around that time) or newest to find older drops.`
          : undefined,
        new: added.map((a) => inv.byId.get(a.instanceId)).filter((i): i is Item => !!i && wanted(i)).map((i) => ({ ...briefItem(i, inv, defs), firstSeen: iso(added.find((a) => a.instanceId === i.instanceId)!.firstSeenAt) })),
        gone: gone.filter((g) => !kind || kind === 'all' || g.kind === kind).map((g) => ({ name: g.name, id: g.instanceId, kind: g.kind, goneSince: iso(g.goneAt) })),
        comparedTo: snap ? `snapshot from ${iso(snap.takenAt)}` : undefined,
        changed: diff?.changed.length ? diff.changed : undefined,
        power: diff?.power.length ? diff.power : undefined,
        currencies: diff?.currencies.length ? diff.currencies : undefined,
      });
    }),
  );

  server.registerTool(
    'triage_drops',
    {
      title: 'Triage drops',
      description:
        'Applies your keep rules (~/.guardjin/keep-rules.json; created with defaults on first use) to unlocked gear and says what to keep (lock), dismantle, or review, with the rule and reason for each. ' +
        'Default rules: one copy of each exotic (new-gen over legacy); T4–T5 legendary armor unless a higher tier of the same set and archetype exists; T3 only as the only piece of its set in a slot; legacy armor out; ' +
        'one copy per legendary weapon (highest tier, then preferred perks, wishlist, power); power-10 legacy weapons out; top-2 power per slot and loadout items kept. ' +
        'Nothing is changed: lock the keeps with set_lock_state (lockIds), then dismantle in game.',
      inputSchema: {
        scope: z.enum(['unlocked', 'new', 'all']).optional().describe('unlocked (default), new = unlocked and first seen since the last triage, all = include locked items (to audit old locks)'),
        kind: z.enum(['weapon', 'armor', 'all']).optional(),
        useWishlist: z.boolean().optional().describe('Use wishlist verdicts to rank weapon copies (default true)'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ scope, kind, useWishlist }) => {
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const { rules, file, created } = loadRules(ctx.config.homeDir);
      let wishlist;
      try {
        wishlist = useWishlist === false ? undefined : await ctx.wishlist.get();
      } catch {
        wishlist = undefined;
      }
      const lastTriage = ctx.store?.getMeta('last_triage');
      const newIds =
        scope === 'new' && ctx.store && lastTriage ? new Set(ctx.store.changesSince(Number(lastTriage)).added.map((a) => a.instanceId)) : undefined;
      if (scope === 'new' && !newIds) throw new UserError('No earlier triage is recorded yet; run with scope "unlocked" first.');
      const candidates = inv.items.filter(
        (i) =>
          (scope === 'all' || !i.locked) &&
          (!newIds || newIds.has(i.instanceId ?? '')) &&
          (!kind || kind === 'all' || i.kind === kind),
      );
      const loadoutItemIds = new Set(buildLoadouts(inv, defs).flatMap((l) => l.items.map((i) => i.id)));
      const decisions = triage(inv, defs, candidates, rules, { wishlist, loadoutItemIds });
      ctx.store?.setMeta('last_triage', String(Date.now()));
      const view = (action: string) =>
        decisions.filter((d) => d.action === action).map((d) => ({ ...briefItem(d.item, inv, defs), rule: d.rule, reason: d.reason }));
      const keep = decisions.filter((d) => d.action === 'keep');
      return ok({
        rulesFile: file,
        rulesCreated: created || undefined,
        checked: decisions.length,
        keep: view('keep'),
        dismantle: view('dismantle'),
        review: view('review'),
        lockIds: keep.filter((d) => !d.item.locked).map((d) => d.item.instanceId),
      });
    }),
  );
}
