import type { InventoryModel, Item } from '../inventory/model.js';
import type { ProfileService } from '../inventory/profile.js';
import { SUBCLASS_STAT_PLUG } from '../inventory/subclass.js';
import type { Defs } from '../manifest/defs.js';
import { subclassOwnership } from '../world/subclassVendors.js';
import { planPlugChanges, touchesSubclassPlugs, type OwnershipByItem, type PlugChange, type PlugPlan, type PlugRequest, type PlugResult } from './plugs.js';

/** How often to re-read Bungie's data while waiting for it to catch up. */
export const POLL_SECONDS = 15;

/** A plug change as the caller names it (item by id or name). */
export interface PlugChangeRequest {
  item: string;
  plug?: string;
  socket?: number;
  remove?: boolean;
}

export interface PreparedPlugs {
  inv: InventoryModel;
  defs: Defs;
  requests: PlugRequest[];
  ownership?: OwnershipByItem;
}

export interface ApplyDeps {
  /** Reads current data, resolves the requests' items and loads vendor ownership for subclasses. `retry` marks a re-plan of rejected requests after a wait. */
  prepare(requests: PlugChangeRequest[], retry: boolean): Promise<PreparedPlugs>;
  /** Inserts the planned plugs, remembering the confirmed ones. */
  execute(plan: PlugPlan): Promise<PlugResult[]>;
  sleep(ms: number): Promise<void>;
  /** Called before each wait with the seconds waited so far and the most it will wait. */
  onWait?(waitedSeconds: number, totalSeconds: number): void | Promise<void>;
}

export interface ApplyOutcome {
  /** The latest planned change for each request that got one. */
  changes: PlugChange[];
  unchanged: string[];
  /** Requests the plan refused (nothing to retry: not owned, doesn't fit, not enough energy...). */
  errors: string[];
  /** The latest insert result of each change that was executed. */
  results: PlugResult[];
  waitedSeconds: number;
  /** Inserts the game rejected at first and accepted after waiting, as "item ← plug". */
  resolvedAfterWait: string[];
}

/**
 * Whether waiting can help a rejected insert: an aspect or fragment only when a vendor shows it bought
 * (an unbought or unconfirmed one won't start working), anything else (mods, perks, cosmetics) yes.
 */
function worthRetrying(prepared: PreparedPlugs, change: PlugChange): boolean {
  const own = prepared.ownership?.get(change.item)?.get(change.plug.hash);
  if (own) return own.owned === true;
  return !SUBCLASS_STAT_PLUG.test(prepared.defs.item(change.plug.hash)?.plug?.plugCategoryIdentifier ?? '');
}

/** Adds what the vendors say to a rejected insert of a plug they show bought. */
function explainFailure(prepared: PreparedPlugs, change: PlugChange, message: string, waited: number): string {
  if (prepared.ownership?.get(change.item)?.get(change.plug.hash)?.owned !== true) return message;
  return waited
    ? `${message} (the vendor says it is bought, but the game still refused it after ${waited}s; loading into the game on that character usually brings Bungie's data up to date)`
    : `${message} (the vendor says it is bought, so Bungie's data may still be catching up; retry shortly or pass waitSeconds)`;
}

/**
 * Ownership for listing one socket's options, or undefined when the socket isn't a visible aspect or
 * fragment socket (checked on the profile already read, so a hidden fragment slot costs no vendor call).
 * Read fresh, so the options agree with what apply_plugs would do (see subclassOwnership).
 */
export function socketOwnership(profile: Pick<ProfileService, 'characterVendorSales'>, inv: InventoryModel, defs: Defs, item: Item, socket: number) {
  const state = item.instanceId ? inv.raw.itemComponents?.sockets?.data?.[item.instanceId]?.sockets?.[socket] : undefined;
  const visible = !!state && state.isVisible !== false && state.isEnabled !== false;
  return visible && touchesSubclassPlugs(defs, item, { socket }) ? subclassOwnership(profile, inv, defs, item, { fresh: true }) : Promise.resolve(undefined);
}

/**
 * ApplyDeps.prepare for the live account: plans against the items' live state (the cached profile can lag
 * recent writes) and reads ownership fresh for requests that touch aspects or fragments (see
 * subclassOwnership). A retry only re-reads the rejected items, reusing the profile read before.
 */
export function livePreparer(
  profile: Pick<ProfileService, 'inventory' | 'refreshItem' | 'characterVendorSales'>,
  manifest: { load(): Promise<Defs> },
  resolve: (inv: InventoryModel, ref: string) => Item,
): ApplyDeps['prepare'] {
  let last: InventoryModel | undefined;
  return async (requests, retry) => {
    const [inv, defs] = await Promise.all([retry && last ? last : profile.inventory(true), manifest.load()]);
    last = inv;
    const resolved = requests.map((c) => ({ ...c, item: resolve(inv, c.item) }));
    const ownership: OwnershipByItem = new Map();
    await Promise.all(
      [...new Set(resolved.map((r) => r.item))].map(async (item) => {
        const touches = resolved.some((r) => r.item === item && touchesSubclassPlugs(defs, item, r));
        const [own] = await Promise.all([touches ? subclassOwnership(profile, inv, defs, item, { fresh: true }) : undefined, profile.refreshItem(inv, item)]);
        if (own) ownership.set(item, own);
      }),
    );
    return { inv, defs, requests: resolved, ownership };
  };
}

/**
 * Plans and inserts plug changes. An insert the game rejects is retried every POLL_SECONDS against
 * freshly read data until it goes through or `waitSeconds` runs out, which covers the minute or two
 * Bungie's data takes to catch up after an equip or a purchase. Requests the plan refuses (not owned,
 * doesn't fit, not enough energy), and rejected aspects or fragments no vendor shows bought, can't be
 * fixed by waiting and are only reported.
 */
export async function applyPlugChanges(deps: ApplyDeps, requests: PlugChangeRequest[], opts: { dryRun?: boolean; waitSeconds?: number } = {}): Promise<ApplyOutcome> {
  const waitSeconds = opts.waitSeconds ?? 0;
  // Per original request; later rounds overwrite the entries of the requests they retry.
  const changes: PlugChange[] = [];
  const results: PlugResult[] = [];
  const errors: string[] = [];
  const unchanged: string[] = [];
  const retried = new Set<number>();
  let active = requests.map((_, i) => i);
  let waited = 0;

  for (let round = 0; ; round++) {
    const prepared = await deps.prepare(active.map((i) => requests[i]), round > 0);
    const plan = planPlugChanges(prepared.inv, prepared.defs, prepared.requests, prepared.ownership);
    errors.push(...plan.errors);
    unchanged.push(...plan.unchanged);
    for (const i of active) delete changes[i], delete results[i];
    for (const c of plan.changes) changes[active[c.request]] = c;

    const rejected: number[] = [];
    if (!opts.dryRun && plan.changes.length) {
      // One result per planned change, in order.
      (await deps.execute(plan)).forEach((r, k) => {
        const change = plan.changes[k];
        const i = active[change.request];
        results[i] = r.ok ? r : { ...r, error: explainFailure(prepared, change, r.error ?? 'failed', waited) };
        if (!r.ok && worthRetrying(prepared, change)) rejected.push(i);
      });
    }

    if (!rejected.length || waited >= waitSeconds) {
      return {
        changes: changes.filter(Boolean),
        unchanged,
        errors,
        results: results.filter(Boolean),
        waitedSeconds: waited,
        resolvedAfterWait: results.filter((r, i) => r?.ok && retried.has(i)).map((r) => `${r.item} ← ${r.plug}`),
      };
    }
    for (const i of rejected) retried.add(i);
    const pause = Math.min(POLL_SECONDS, waitSeconds - waited);
    await deps.onWait?.(waited, waitSeconds);
    await deps.sleep(pause * 1000);
    waited += pause;
    active = rejected;
  }
}
