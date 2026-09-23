import { describe, expect, it } from 'vitest';
import { assignMods, optimizeArmor, paretoPrune, type ArmorCandidate } from '../src/builds/optimizer.js';

// Stat order: weapons, health, class, grenade, super, melee
let n = 0;
const piece = (slot: number, stats: number[], extra: Partial<ArmorCandidate> = {}): ArmorCandidate => ({
  id: `p${n++}`,
  slot,
  stats,
  ...extra,
});

const flat = (v: number) => [v, v, v, v, v, v];

describe('paretoPrune', () => {
  it('drops dominated pieces but keeps different sets and exotics', () => {
    const strong = piece(0, [30, 30, 30, 30, 30, 30]);
    const weak = piece(0, [20, 20, 20, 20, 20, 20]);
    const weakWithSet = piece(0, [20, 20, 20, 20, 20, 20], { setHash: 7 });
    const exotic = piece(0, [5, 5, 5, 5, 5, 5], { exoticHash: 99 });
    const duplicate = piece(0, [30, 30, 30, 30, 30, 30]);
    const kept = paretoPrune([strong, weak, weakWithSet, exotic, duplicate]);
    expect(kept).toContain(strong);
    expect(kept).not.toContain(weak);
    expect(kept).toContain(weakWithSet);
    expect(kept).toContain(exotic);
    expect(kept.filter((k) => k.stats[0] === 30 && !k.setHash && !k.exoticHash)).toHaveLength(1);
  });
});

describe('assignMods', () => {
  it('fills minimums first, then spends leftovers on the highest weight', () => {
    const r = assignMods([100, 50, 50, 85, 50, 50], [0, 0, 0, 100, 0, 0], [1, 1, 1, 1, 3, 1], 10)!;
    expect(r.mods.filter((m) => m === 3)).toHaveLength(2); // 85 → 105 needs two +10s
    expect(r.mods.filter((m) => m === 4)).toHaveLength(3); // leftovers to super (weight 3)
    expect(r.final[3]).toBe(105);
  });

  it('fails when minimums need more than five mods', () => {
    expect(assignMods(flat(0), [60, 0, 0, 0, 0, 0], flat(1), 10)).toBeUndefined();
  });

  it('does not waste mods past the 200 cap', () => {
    const r = assignMods([195, 0, 0, 0, 0, 0], flat(0), [10, 1, 1, 1, 1, 1], 10)!;
    expect(r.final[0]).toBe(205); // one mod still gains 5 points
    expect(r.mods.filter((m) => m === 0)).toHaveLength(1);
  });
});

describe('optimizeArmor', () => {
  const legendary = (slot: number, stats: number[], setHash?: number) => piece(slot, stats, { setHash });

  const pool = [
    // Grenade-heavy pieces, one per slot
    ...[0, 1, 2, 3, 4].map((s) => legendary(s, [0, 5, 5, 30, 5, 20])),
    // Health-heavy pieces from set 42
    ...[0, 1, 2, 3, 4].map((s) => legendary(s, [5, 30, 20, 0, 5, 5], 42)),
    // Two exotics
    piece(1, [0, 10, 0, 25, 10, 20], { exoticHash: 1001 }),
    piece(2, [20, 20, 20, 0, 0, 0], { exoticHash: 2002 }),
  ];

  it('maximizes the priority stat and uses at most one exotic', () => {
    const [best] = optimizeArmor(pool, { weights: [0.25, 0.25, 0.25, 3, 0.25, 0.25], modValue: 10 });
    expect(best.pieces.filter((p) => p.exoticHash)).toHaveLength(best.pieces.some((p) => p.exoticHash) ? 1 : 0);
    expect(best.armorStats[3]).toBe(150);
    expect(best.finalStats[3]).toBe(200); // five +10 grenade mods
  });

  it('forces the requested exotic', () => {
    const results = optimizeArmor(pool, { exotic: 2002, weights: [0, 0, 0, 1, 0, 0] });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.pieces.find((p) => p.slot === 2)?.exoticHash).toBe(2002);
      expect(r.pieces.filter((p) => p.exoticHash)).toHaveLength(1);
    }
  });

  it('excludes exotics with "none"', () => {
    const results = optimizeArmor(pool, { exotic: 'none' });
    for (const r of results) expect(r.pieces.every((p) => !p.exoticHash)).toBe(true);
  });

  it('honors set requirements', () => {
    const [best] = optimizeArmor(pool, { setRequirements: [{ setHash: 42, pieces: 4 }], weights: [0, 0, 0, 1, 0, 0] });
    expect(best.pieces.filter((p) => p.setHash === 42).length).toBeGreaterThanOrEqual(4);
  });

  it('meets stat minimums with mods, or returns nothing when impossible', () => {
    const [best] = optimizeArmor(pool, { minimums: [0, 100, 0, 100, 0, 0], exotic: 'none' });
    expect(best.finalStats[1]).toBeGreaterThanOrEqual(100);
    expect(best.finalStats[3]).toBeGreaterThanOrEqual(100);
    expect(optimizeArmor(pool, { minimums: [200, 200, 0, 0, 0, 0] })).toEqual([]);
  });

  it('adds the subclass bonus', () => {
    const [withBonus] = optimizeArmor(pool, { bonus: [0, 0, 0, 20, 0, 0], weights: [0, 0, 0, 1, 0, 0], modValue: 0 });
    expect(withBonus.armorStats[3]).toBe(170);
  });

  it('returns nothing when a slot has no armor', () => {
    expect(optimizeArmor(pool.filter((p) => p.slot !== 4))).toEqual([]);
  });

  it('handles a large inventory quickly', () => {
    const rand = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const r = rand(42);
    const big: ArmorCandidate[] = [];
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 80; i++) big.push(piece(s, Array.from({ length: 6 }, () => Math.floor(r() * 30)), { setHash: i % 4 ? undefined : 100 + (i % 3) }));
      for (let e = 0; e < 6; e++) big.push(piece(s, Array.from({ length: 6 }, () => Math.floor(r() * 30)), { exoticHash: 5000 + s * 10 + e }));
    }
    const started = Date.now();
    const results = optimizeArmor(big, { minimums: [0, 50, 0, 80, 0, 0], weights: [1, 2, 1, 3, 1, 1], topN: 5 });
    expect(results.length).toBe(5);
    expect(Date.now() - started).toBeLessThan(15000);
  });
});
