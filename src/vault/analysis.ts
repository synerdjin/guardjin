import { Buckets } from '../inventory/constants.js';
import { statTotal, type InventoryModel, type Item } from '../inventory/model.js';
import type { Defs } from '../manifest/defs.js';
import { evaluateRoll, type Verdict, type Wishlist, type WishlistResult } from './wishlist.js';

export interface VaultSummary {
  vault: { used: number; capacity: number; bySlot: Record<string, number> };
  characters: { characterId: string; className: string; full: string[]; buckets: Record<string, string> }[];
  postmaster: { characterId: string; className: string; count: number; capacity: number }[];
}

export function vaultSummary(inv: InventoryModel, defs: Defs): VaultSummary {
  const vaultItems = inv.items.filter((i) => i.location.type === 'vault');
  const bySlot: Record<string, number> = {};
  for (const it of vaultItems) {
    const key = it.kind === 'other' ? 'Other' : it.slot;
    bySlot[key] = (bySlot[key] ?? 0) + 1;
  }
  const trackedBuckets = [
    Buckets.Kinetic, Buckets.Energy, Buckets.Power,
    Buckets.Helmet, Buckets.Gauntlets, Buckets.Chest, Buckets.Legs, Buckets.ClassItem,
  ];
  const characters = inv.characters.map((c) => {
    const buckets: Record<string, string> = {};
    const full: string[] = [];
    for (const b of trackedBuckets) {
      const def = defs.bucket(b);
      const capacity = (def?.itemCount ?? 10) - 1; // one slot is the equipped item
      const count = inv.items.filter(
        (i) => i.location.type === 'character' && i.location.characterId === c.id && !i.equipped && i.bucketHash === b,
      ).length;
      const name = def?.displayProperties.name ?? String(b);
      buckets[name] = `${count}/${capacity}`;
      if (count >= capacity) full.push(name);
    }
    return { characterId: c.id, className: c.className, full, buckets };
  });
  const postmasterCapacity = defs.bucket(Buckets.Postmaster)?.itemCount ?? 21;
  const postmaster = inv.characters.map((c) => ({
    characterId: c.id,
    className: c.className,
    count: inv.items.filter((i) => i.location.type === 'postmaster' && i.location.characterId === c.id).length,
    capacity: postmasterCapacity,
  }));
  return {
    vault: { used: vaultItems.length, capacity: defs.bucket(Buckets.Vault)?.itemCount ?? 700, bySlot },
    characters,
    postmaster,
  };
}

const isGear = (i: Item) => (i.kind === 'weapon' || i.kind === 'armor') && !!i.instanceId && i.location.type !== 'profile';

export interface DuplicateGroup {
  name: string;
  kind: 'weapon' | 'armor';
  items: { item: Item; wishlist?: WishlistResult }[];
}

/**
 * Weapons that share a name (reissues included), and exotic armor that shares a hash.
 * Legendary armor is handled by dominance instead, since same-name armor is normal.
 */
export function findDuplicates(inv: InventoryModel, defs: Defs, wishlist?: Wishlist): DuplicateGroup[] {
  const groups = new Map<string, Item[]>();
  for (const it of inv.items.filter(isGear)) {
    let key: string | undefined;
    if (it.kind === 'weapon') key = `w:${it.name}`;
    else if (it.kind === 'armor' && it.isExotic) key = `a:${it.hash}`;
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }
  const out: DuplicateGroup[] = [];
  for (const items of groups.values()) {
    if (items.length < 2) continue;
    const kind = items[0].kind as 'weapon' | 'armor';
    out.push({
      name: items[0].name,
      kind,
      items: items.map((item) => ({ item, wishlist: wishlist && kind === 'weapon' ? evaluateRoll(item, wishlist, defs) : undefined })),
    });
  }
  return out.sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
}

/**
 * Armor pieces that another piece strictly beats: same class and slot, same exotic (for exotics),
 * a set that is at least as good, gear tier at least as high, and every masterworked stat ≥.
 */
export function findDominatedArmor(inv: InventoryModel): { item: Item; betterThanIt: Item }[] {
  // Exotic class items roll random perks, so their stats alone say nothing about which copy is better.
  const armor = inv.items.filter(
    (i) => isGear(i) && i.kind === 'armor' && i.armor && !(i.isExotic && i.bucketHash === Buckets.ClassItem),
  );
  const buckets = new Map<string, Item[]>();
  for (const a of armor) {
    const key = `${a.classType}:${a.bucketHash}:${a.isExotic ? a.hash : 'L'}`;
    const g = buckets.get(key);
    if (g) g.push(a);
    else buckets.set(key, [a]);
  }
  const out: { item: Item; betterThanIt: Item }[] = [];
  for (const group of buckets.values()) {
    for (const it of group) {
      const better = group.find((other) => other !== it && beats(other, it));
      if (better) out.push({ item: it, betterThanIt: better });
    }
  }
  return out;
}

function beats(a: Item, b: Item): boolean {
  const as = a.armor!.masterworked;
  const bs = b.armor!.masterworked;
  if (b.armor!.set && a.armor!.set?.hash !== b.armor!.set.hash) return false;
  if ((a.gearTier ?? 0) < (b.gearTier ?? 0)) return false;
  let strictly = (a.gearTier ?? 0) > (b.gearTier ?? 0) || (!!a.armor!.set && !b.armor!.set);
  for (let i = 0; i < as.length; i++) {
    if (as[i] < bs[i]) return false;
    if (as[i] > bs[i]) strictly = true;
  }
  // Tie-break identical pieces deterministically so only one of a pair is flagged.
  return strictly || (a.instanceId ?? '') < (b.instanceId ?? '');
}

export type CleanupReason = 'dominated-armor' | 'wishlist-trash' | 'worse-duplicate' | 'low-tier';

export interface CleanupCandidate {
  item: Item;
  reason: CleanupReason;
  detail: string;
  /** 3 = strong recommendation, 1 = worth a look */
  confidence: 1 | 2 | 3;
}

const VERDICT_RANK: Record<Verdict, number> = { wishlist: 3, unknown: 2, 'not-on-wishlist': 1, trash: 0 };

export function suggestCleanup(
  inv: InventoryModel,
  defs: Defs,
  opts: { wishlist?: Wishlist; includeLocked?: boolean; kinds?: ('weapon' | 'armor')[] },
): CleanupCandidate[] {
  const kinds = opts.kinds ?? ['weapon', 'armor'];
  const eligible = (i: Item) =>
    isGear(i) && !i.equipped && (opts.includeLocked || !i.locked) && kinds.includes(i.kind as 'weapon' | 'armor');
  const out = new Map<string, CleanupCandidate>();
  const add = (c: CleanupCandidate) => {
    const id = c.item.instanceId!;
    const prev = out.get(id);
    if (!prev || prev.confidence < c.confidence) out.set(id, c);
  };

  if (kinds.includes('armor')) {
    for (const { item, betterThanIt } of findDominatedArmor(inv)) {
      if (!eligible(item)) continue;
      add({
        item,
        reason: 'dominated-armor',
        detail: `${betterThanIt.name}${betterThanIt.gearTier ? ` (T${betterThanIt.gearTier})` : ''} has equal or better stats in every stat (total ${statTotal(betterThanIt.armor!.masterworked)} vs ${statTotal(item.armor!.masterworked)} when masterworked)`,
        confidence: 3,
      });
    }
    // Low-tier Armor 3.0 legendaries when a higher-tier piece exists for the same class and slot.
    const armor = inv.items.filter((i) => isGear(i) && i.kind === 'armor' && !i.isExotic && i.gearTier);
    for (const it of armor) {
      if (!eligible(it) || (it.gearTier ?? 0) > 2) continue;
      const better = armor.find(
        (o) => o !== it && o.classType === it.classType && o.bucketHash === it.bucketHash && (o.gearTier ?? 0) >= 4,
      );
      if (better) {
        add({
          item: it,
          reason: 'low-tier',
          detail: `Tier ${it.gearTier}; you own Tier ${better.gearTier} ${it.slot.toLowerCase()} pieces for this class`,
          confidence: 1,
        });
      }
    }
  }

  if (kinds.includes('weapon') && opts.wishlist) {
    for (const group of findDuplicates(inv, defs, opts.wishlist)) {
      if (group.kind !== 'weapon') continue;
      const ranked = [...group.items].sort(
        (a, b) =>
          VERDICT_RANK[b.wishlist!.verdict] - VERDICT_RANK[a.wishlist!.verdict] ||
          Number(b.item.crafted) - Number(a.item.crafted) ||
          (b.item.power ?? 0) - (a.item.power ?? 0),
      );
      const best = ranked[0];
      for (const entry of ranked.slice(1)) {
        if (!eligible(entry.item)) continue;
        const worse = VERDICT_RANK[entry.wishlist!.verdict] < VERDICT_RANK[best.wishlist!.verdict];
        add({
          item: entry.item,
          reason: 'worse-duplicate',
          detail: `${group.items.length} copies; best copy is ${best.wishlist!.verdict}${best.item.locked ? ' and locked' : ''}, this one is ${entry.wishlist!.verdict}`,
          confidence: worse ? 2 : 1,
        });
      }
    }
    for (const it of inv.items.filter((i) => i.kind === 'weapon' && eligible(i))) {
      const r = evaluateRoll(it, opts.wishlist, defs);
      if (r.verdict === 'trash') {
        add({ item: it, reason: 'wishlist-trash', detail: `Wishlist marks this roll as trash${r.notes?.length ? `: ${r.notes[0]}` : ''}`, confidence: 3 });
      }
    }
  }

  return [...out.values()].sort((a, b) => b.confidence - a.confidence || a.item.name.localeCompare(b.item.name));
}
