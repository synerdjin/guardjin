import { describe, expect, it } from 'vitest';
import { Buckets } from '../src/inventory/constants.js';
import { findDominatedArmor, findDuplicates, suggestCleanup, vaultSummary } from '../src/vault/analysis.js';
import { parseWishlist } from '../src/vault/wishlist.js';
import { WARLOCK, fixtureDefs, makeInventory, makeItem } from './helpers.js';

const defs = fixtureDefs();
const SET_A = { hash: 1, name: 'Set A' };

describe('findDominatedArmor', () => {
  it('flags armor beaten in every stat by a comparable piece', () => {
    const good = makeItem({ stats6: [30, 20, 10, 10, 10, 10], gearTier: 4 });
    const bad = makeItem({ stats6: [25, 20, 5, 10, 10, 10], gearTier: 4 });
    const other = makeItem({ stats6: [5, 5, 5, 40, 30, 10], gearTier: 4 }); // better grenade/super, not dominated
    const result = findDominatedArmor(makeInventory([good, bad, other]));
    expect(result.map((r) => r.item)).toEqual([bad]);
    expect(result[0].betterThanIt).toBe(good);
  });

  it('never lets a setless piece dominate a set piece, or a lower tier beat a higher tier', () => {
    const setPiece = makeItem({ stats6: [10, 10, 10, 10, 10, 10], set: SET_A, gearTier: 3 });
    const bigger = makeItem({ stats6: [20, 20, 20, 20, 20, 20], gearTier: 3 });
    const highTier = makeItem({ stats6: [10, 10, 10, 10, 10, 10], gearTier: 5 });
    const lowTierBig = makeItem({ stats6: [20, 20, 20, 20, 20, 20], gearTier: 2 });
    const flagged = findDominatedArmor(makeInventory([setPiece, bigger, highTier, lowTierBig])).map((r) => r.item);
    expect(flagged).not.toContain(setPiece);
    expect(flagged).not.toContain(highTier);
  });

  it('only compares pieces of the same class and slot, and ignores exotic class items', () => {
    const helm = makeItem({ stats6: [30, 30, 30, 30, 30, 30] });
    const hunterHelm = makeItem({ stats6: [1, 1, 1, 1, 1, 1], classType: 'hunter' });
    const arms = makeItem({ stats6: [1, 1, 1, 1, 1, 1], bucketHash: Buckets.Gauntlets, slot: 'Gauntlets' });
    const exoticCloak1 = makeItem({ stats6: [30, 30, 30, 30, 30, 30], isExotic: true, hash: 77, bucketHash: Buckets.ClassItem });
    const exoticCloak2 = makeItem({ stats6: [1, 1, 1, 1, 1, 1], isExotic: true, hash: 77, bucketHash: Buckets.ClassItem });
    expect(findDominatedArmor(makeInventory([helm, hunterHelm, arms, exoticCloak1, exoticCloak2]))).toEqual([]);
  });

  it('flags exactly one of two identical pieces', () => {
    const a = makeItem({ stats6: [10, 10, 10, 10, 10, 10] });
    const b = makeItem({ stats6: [10, 10, 10, 10, 10, 10] });
    expect(findDominatedArmor(makeInventory([a, b]))).toHaveLength(1);
  });
});

describe('suggestCleanup', () => {
  it('skips locked and equipped items unless asked', () => {
    const good = makeItem({ stats6: [30, 30, 30, 30, 30, 30] });
    const lockedBad = makeItem({ stats6: [1, 1, 1, 1, 1, 1], locked: true });
    const equippedBad = makeItem({ stats6: [1, 1, 1, 1, 1, 1], equipped: true, location: { type: 'character', characterId: WARLOCK } });
    const bad = makeItem({ stats6: [2, 2, 2, 2, 2, 2] });
    const inv = makeInventory([good, lockedBad, equippedBad, bad]);
    expect(suggestCleanup(inv, defs, {}).map((c) => c.item)).toEqual([bad]);
    expect(suggestCleanup(inv, defs, { includeLocked: true }).map((c) => c.item)).toContain(lockedBad);
  });

  it('ranks weapon duplicates by wishlist verdict', () => {
    const perk = (hash: number) => ({ hash, name: defs.item(hash)!.displayProperties.name });
    const weapon = (killPerk: number, locked = false) =>
      makeItem({
        kind: 'weapon',
        name: 'Fatebringer',
        hash: 2171478765,
        locked,
        weapon: { perks: [{ socketIndex: 4, equipped: perk(killPerk), options: [perk(killPerk)] }] },
      });
    const god = weapon(1015611457, true); // Kill Clip
    const meh = weapon(47981717); // Opening Shot
    const wl = parseWishlist(`dimwishlist:item=2171478765&perks=1015611457\ndimwishlist:item=-2171478765&perks=47981717`);
    const inv = makeInventory([god, meh]);
    const dupes = findDuplicates(inv, defs, wl);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].items.map((i) => i.wishlist?.verdict).sort()).toEqual(['trash', 'wishlist']);
    const cleanup = suggestCleanup(inv, defs, { wishlist: wl });
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toMatchObject({ item: meh, reason: 'wishlist-trash', confidence: 3 });
  });

  it('ranks weapon duplicates by tier before the wishlist verdict', () => {
    const perk = (hash: number) => ({ hash, name: defs.item(hash)!.displayProperties.name });
    const weapon = (killPerk: number, gearTier: number) =>
      makeItem({
        kind: 'weapon',
        name: 'Fatebringer',
        hash: 2171478765,
        gearTier,
        weapon: { perks: [{ socketIndex: 4, equipped: perk(killPerk), options: [perk(killPerk)] }] },
      });
    const t5 = weapon(47981717, 5); // Opening Shot: trash on this wishlist
    const t2 = weapon(1015611457, 2); // Kill Clip: wishlist roll
    const wl = parseWishlist(`dimwishlist:item=2171478765&perks=1015611457\ndimwishlist:item=-2171478765&perks=47981717`);
    const cleanup = suggestCleanup(makeInventory([t5, t2]), defs, { wishlist: wl });
    expect(cleanup.find((c) => c.item === t2)).toMatchObject({ reason: 'worse-duplicate', confidence: 2 });
    expect(cleanup.find((c) => c.item === t5)).toMatchObject({ reason: 'wishlist-trash', confidence: 1 });
  });
});

describe('vaultSummary', () => {
  it('counts vault use and full character buckets', () => {
    const items = [
      ...Array.from({ length: 3 }, () => makeItem({})),
      ...Array.from({ length: 9 }, () => makeItem({ location: { type: 'character', characterId: WARLOCK } })),
      makeItem({ location: { type: 'character', characterId: WARLOCK }, equipped: true }),
    ];
    const summary = vaultSummary(makeInventory(items), defs);
    expect(summary.vault.used).toBe(3);
    expect(summary.vault.capacity).toBe(defs.bucket(Buckets.Vault)!.itemCount);
    const warlock = summary.characters.find((c) => c.characterId === WARLOCK)!;
    expect(warlock.full).toEqual(['Helmet']);
    expect(warlock.buckets.Helmet).toBe('9/9');
  });
});
