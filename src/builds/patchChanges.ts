import { locationLabel, type InventoryModel } from '../inventory/model.js';
import { buildLoadouts, isSavedPlug } from '../loadouts/loadouts.js';
import type { Defs } from '../manifest/defs.js';
import type { PatchChange } from '../manifest/diff.js';
import { itemSockets } from '../sockets/plugs.js';
import type { ManifestUpdate, SnapshotStore } from '../store/snapshots.js';

/** A change to a plug the player uses, and where. */
export interface GearPatchChange extends PatchChange {
  usedBy: string[];
}

export interface PatchReport {
  version: string;
  previousVersion: string;
  at: string;
  changedInYourGear: GearPatchChange[];
  /** Plugs the update changed that nothing of yours uses. */
  otherChanges: number;
}

const MAX_USES = 6;
const MAX_TEXT = 400;
/** Characters of shared text kept before the first difference, for context. */
const LEAD = 80;

/** Shortens long before/after texts to a window that starts just before they first differ, so the change stays visible. */
export function clipPair(before: string, after: string): [string, string] {
  let common = 0;
  while (common < before.length && before[common] === after[common]) common++;
  const start = Math.max(0, common - LEAD);
  const clip = (s: string) => {
    const head = start > 0 ? `…${s.slice(start)}` : s;
    return head.length > MAX_TEXT ? `${head.slice(0, MAX_TEXT - 1)}…` : head;
  };
  return [clip(before), clip(after)];
}

/**
 * Where each of the given plug hashes is in use: saved loadouts, worn gear, and exotics you own
 * (their intrinsic perks are what makes them worth keeping).
 */
function plugUses(inv: InventoryModel, defs: Defs, hashes: Set<number>): Map<number, Set<string>> {
  const uses = new Map<number, Set<string>>();
  const add = (hash: number | undefined, where: string) => {
    if (hash === undefined || !hashes.has(hash)) return;
    let set = uses.get(hash);
    if (!set) uses.set(hash, (set = new Set()));
    set.add(where);
  };

  for (const l of buildLoadouts(inv, defs)) {
    const label = `${locationLabel({ type: 'character', characterId: l.characterId }, inv.characters)} loadout ${l.index}: ${l.name}`;
    for (const item of l.items) for (const h of item.plugHashes.filter(isSavedPlug)) add(h, `${label} (${item.name ?? 'missing item'})`);
  }
  for (const item of inv.items) {
    if (!item.instanceId || (item.kind !== 'weapon' && item.kind !== 'armor' && item.kind !== 'subclass')) continue;
    if (!item.equipped && !item.isExotic) continue;
    const where = item.equipped ? `${item.name} (equipped on ${locationLabel(item.location, inv.characters)})` : `${item.name} (exotic you own)`;
    for (const s of itemSockets(inv, defs, item)) if (!s.cosmetic) add(s.current?.hash, where);
  }
  return uses;
}

/** Each update (newest first), reduced to the changes that touch something the player uses. */
export function patchReports(inv: InventoryModel, defs: Defs, updates: ManifestUpdate[]): PatchReport[] {
  if (!updates.length) return [];
  const uses = plugUses(inv, defs, new Set(updates.flatMap((u) => u.changes.map((c) => c.hash))));
  return updates.map((update) => {
    const mine = update.changes.flatMap((c): GearPatchChange[] => {
      const where = uses.get(c.hash);
      if (!where) return [];
      const [before, after] = clipPair(c.before, c.after);
      return [{ ...c, before, after, usedBy: [...where].slice(0, MAX_USES) }];
    });
    return {
      version: update.version,
      previousVersion: update.previousVersion,
      at: new Date(update.at).toISOString(),
      changedInYourGear: mine.sort((a, b) => a.name.localeCompare(b.name)),
      otherChanges: update.changes.length - mine.length,
    };
  });
}

/**
 * Game updates recorded after `since` that changed a plug the player uses, or undefined if none.
 * Best effort: a failure is logged, so the tool showing it still answers.
 */
export function yourGameUpdates(store: SnapshotStore, inv: InventoryModel, defs: Defs, since?: number): PatchReport[] | undefined {
  try {
    const reports = patchReports(inv, defs, store.manifestUpdates(since)).filter((r) => r.changedInYourGear.length);
    return reports.length ? reports : undefined;
  } catch (err) {
    console.error('[guardjin] could not check game updates against your gear:', (err as Error).message);
    return undefined;
  }
}
