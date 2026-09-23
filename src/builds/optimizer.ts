import { ARMOR_STATS, STAT_CAP } from '../inventory/constants.js';
import type { StatVector } from '../inventory/model.js';

/** One armor piece as the optimizer sees it. */
export interface ArmorCandidate {
  id: string;
  /** 0..4 = helmet, gauntlets, chest, legs, class item */
  slot: number;
  stats: StatVector;
  exoticHash?: number;
  setHash?: number;
  gearTier?: number;
}

export interface OptimizerOptions {
  /** 'any' (at most one exotic), 'none', or a specific exotic item hash that must be included. */
  exotic: 'any' | 'none' | number;
  /** Minimum totals per stat (indexed like ARMOR_STATS; 0 = no minimum). */
  minimums: StatVector;
  /** Priority weights per stat; higher = more valuable. */
  weights: StatVector;
  /** Armor sets that must reach at least `pieces` equipped pieces. */
  setRequirements: { setHash: number; pieces: number }[];
  /** Flat bonus added to every combination (e.g. subclass fragments). */
  bonus: StatVector;
  /** Value of the one stat mod each piece can hold (10 = major, 5 = minor, 0 = no mods). */
  modValue: number;
  /** Number of results to return. */
  topN: number;
  /** Max candidates kept per slot after pruning. */
  perSlotLimit: number;
}

export interface OptimizerResult {
  pieces: ArmorCandidate[];
  /** Stats from armor + bonus, before mods. */
  armorStats: StatVector;
  /** Final stats with the chosen stat mods applied. */
  finalStats: StatVector;
  /** Stat index for each of the mods used (length ≤ 5). */
  mods: number[];
  score: number;
}

export const SLOT_COUNT = 5;
const STAT_COUNT = ARMOR_STATS.length;

export function defaultOptions(partial: Partial<OptimizerOptions> = {}): OptimizerOptions {
  return {
    exotic: 'any',
    minimums: new Array(STAT_COUNT).fill(0),
    weights: new Array(STAT_COUNT).fill(1),
    setRequirements: [],
    bonus: new Array(STAT_COUNT).fill(0),
    modValue: 10,
    topN: 5,
    perSlotLimit: 15,
    ...partial,
  };
}

function dominates(a: ArmorCandidate, b: ArmorCandidate): boolean {
  let strictly = false;
  for (let i = 0; i < STAT_COUNT; i++) {
    if (a.stats[i] < b.stats[i]) return false;
    if (a.stats[i] > b.stats[i]) strictly = true;
  }
  return strictly || (a.gearTier ?? 0) > (b.gearTier ?? 0);
}

/**
 * Removes pieces that are stat-dominated by another piece in the same slot with the same exotic
 * and set identity (so set bonuses and exotic choices are never pruned away).
 */
export function paretoPrune(items: ArmorCandidate[]): ArmorCandidate[] {
  const groups = new Map<string, ArmorCandidate[]>();
  for (const it of items) {
    const key = `${it.slot}:${it.exoticHash ?? 0}:${it.setHash ?? 0}`;
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }
  const kept: ArmorCandidate[] = [];
  for (const g of groups.values()) {
    const survivors: ArmorCandidate[] = [];
    for (const it of g) {
      if (g.some((other) => other !== it && dominates(other, it))) continue;
      // Drop exact duplicates of a survivor.
      if (survivors.some((s) => s.stats.every((v, i) => v === it.stats[i]))) continue;
      survivors.push(it);
    }
    kept.push(...survivors);
  }
  return kept;
}

function weightedScore(stats: StatVector, weights: StatVector): number {
  let score = 0;
  for (let i = 0; i < STAT_COUNT; i++) score += weights[i] * Math.min(stats[i], STAT_CAP);
  return score;
}

/**
 * Picks the candidates for one slot: up to `perSlotLimit` legendaries by weighted score (plus the
 * best few pieces of each required set, so set constraints stay satisfiable) and up to
 * `perSlotLimit` exotics (the best copy of each distinct exotic, or copies of the required one).
 */
function selectCandidates(items: ArmorCandidate[], opts: OptimizerOptions): ArmorCandidate[] {
  const byScore = [...items].sort((a, b) => weightedScore(b.stats, opts.weights) - weightedScore(a.stats, opts.weights));
  const chosen = new Set<ArmorCandidate>();
  const legendary = byScore.filter((i) => i.exoticHash === undefined);
  const exotics = byScore.filter((i) => i.exoticHash !== undefined);

  if (typeof opts.exotic === 'number') {
    for (const e of exotics.filter((e) => e.exoticHash === opts.exotic).slice(0, opts.perSlotLimit)) chosen.add(e);
  } else if (opts.exotic === 'any') {
    // Keep the best copy of each distinct exotic so every exotic gets a fair chance.
    const seen = new Set<number>();
    for (const e of exotics) {
      if (seen.has(e.exoticHash!) || seen.size >= opts.perSlotLimit) continue;
      seen.add(e.exoticHash!);
      chosen.add(e);
    }
  }
  const legendaryChosen = new Set<ArmorCandidate>();
  for (const req of opts.setRequirements) {
    for (const it of legendary.filter((i) => i.setHash === req.setHash).slice(0, 5)) legendaryChosen.add(it);
  }
  for (const it of legendary) {
    if (legendaryChosen.size >= opts.perSlotLimit) break;
    legendaryChosen.add(it);
  }
  return [...chosen, ...legendaryChosen];
}

/** Assigns stat mods: first to reach minimums, then leftovers to the highest-weight stats. */
export function assignMods(
  stats: StatVector,
  minimums: StatVector,
  weights: StatVector,
  modValue: number,
  modSlots = SLOT_COUNT,
): { final: StatVector; mods: number[] } | undefined {
  const final = [...stats];
  const mods: number[] = [];
  if (modValue <= 0) {
    return final.every((v, i) => v >= minimums[i]) ? { final, mods } : undefined;
  }
  for (let i = 0; i < STAT_COUNT; i++) {
    while (final[i] < minimums[i]) {
      if (mods.length >= modSlots) return undefined;
      final[i] += modValue;
      mods.push(i);
    }
  }
  while (mods.length < modSlots) {
    let best = -1;
    let bestGain = 0;
    for (let i = 0; i < STAT_COUNT; i++) {
      const gain = weights[i] * (Math.min(final[i] + modValue, STAT_CAP) - Math.min(final[i], STAT_CAP));
      if (gain > bestGain) {
        bestGain = gain;
        best = i;
      }
    }
    if (best < 0) break;
    final[best] += modValue;
    mods.push(best);
  }
  return { final, mods };
}

/**
 * Finds the best armor combinations for the given constraints. Candidates are pruned per slot, then
 * every combination is enumerated with branch-and-bound on the stat minimums.
 */
export function optimizeArmor(items: ArmorCandidate[], options: Partial<OptimizerOptions> = {}): OptimizerResult[] {
  const opts = defaultOptions(options);
  let pool = items;
  if (opts.exotic === 'none') pool = pool.filter((i) => i.exoticHash === undefined);
  if (typeof opts.exotic === 'number') {
    const exoticSlot = pool.find((i) => i.exoticHash === opts.exotic)?.slot;
    if (exoticSlot === undefined) return [];
    // The required exotic fills its slot; every other slot must be legendary.
    pool = pool.filter((i) => (i.slot === exoticSlot ? i.exoticHash === opts.exotic : i.exoticHash === undefined));
  }

  const pruned = paretoPrune(pool);
  const slots: ArmorCandidate[][] = [];
  for (let s = 0; s < SLOT_COUNT; s++) {
    const candidates = selectCandidates(
      pruned.filter((i) => i.slot === s),
      opts,
    );
    if (!candidates.length) return [];
    slots.push(candidates);
  }

  // Upper bound of each stat reachable from slots s..4 (for pruning partial combinations).
  const suffixMax: StatVector[] = Array.from({ length: SLOT_COUNT + 1 }, () => new Array(STAT_COUNT).fill(0));
  for (let s = SLOT_COUNT - 1; s >= 0; s--) {
    for (let i = 0; i < STAT_COUNT; i++) {
      suffixMax[s][i] = suffixMax[s + 1][i] + Math.max(...slots[s].map((c) => c.stats[i]));
    }
  }

  const results: OptimizerResult[] = [];
  const chosen: ArmorCandidate[] = [];
  const running = [...opts.bonus];
  const setCounts = new Map<number, number>();
  const requireExotic = typeof opts.exotic === 'number';

  const feasible = (slot: number): boolean => {
    if (opts.modValue <= 0) {
      for (let i = 0; i < STAT_COUNT; i++) if (running[i] + suffixMax[slot][i] < opts.minimums[i]) return false;
      return true;
    }
    let modsNeeded = 0;
    for (let i = 0; i < STAT_COUNT; i++) {
      const gap = opts.minimums[i] - (running[i] + suffixMax[slot][i]);
      if (gap > 0) modsNeeded += Math.ceil(gap / opts.modValue);
    }
    if (modsNeeded > SLOT_COUNT) return false;
    const remaining = SLOT_COUNT - slot;
    for (const req of opts.setRequirements) {
      if ((setCounts.get(req.setHash) ?? 0) + remaining < req.pieces) return false;
    }
    return true;
  };

  const consider = () => {
    for (const req of opts.setRequirements) if ((setCounts.get(req.setHash) ?? 0) < req.pieces) return;
    if (requireExotic && !chosen.some((c) => c.exoticHash === opts.exotic)) return;
    const assigned = assignMods(running, opts.minimums, opts.weights, opts.modValue);
    if (!assigned) return;
    const score = weightedScore(assigned.final, opts.weights);
    if (results.length >= opts.topN && score <= results[results.length - 1].score) return;
    results.push({ pieces: [...chosen], armorStats: [...running], finalStats: assigned.final, mods: assigned.mods, score });
    results.sort((a, b) => b.score - a.score || tierSum(b.pieces) - tierSum(a.pieces));
    if (results.length > opts.topN) results.pop();
  };

  const walk = (slot: number, exoticUsed: boolean) => {
    if (slot === SLOT_COUNT) {
      consider();
      return;
    }
    if (!feasible(slot)) return;
    for (const c of slots[slot]) {
      const isExotic = c.exoticHash !== undefined;
      if (isExotic && exoticUsed) continue;
      chosen.push(c);
      for (let i = 0; i < STAT_COUNT; i++) running[i] += c.stats[i];
      if (c.setHash) setCounts.set(c.setHash, (setCounts.get(c.setHash) ?? 0) + 1);
      walk(slot + 1, exoticUsed || isExotic);
      if (c.setHash) setCounts.set(c.setHash, setCounts.get(c.setHash)! - 1);
      for (let i = 0; i < STAT_COUNT; i++) running[i] -= c.stats[i];
      chosen.pop();
    }
  };
  walk(0, false);
  return results;
}

function tierSum(pieces: ArmorCandidate[]): number {
  return pieces.reduce((a, p) => a + (p.gearTier ?? 0), 0);
}
