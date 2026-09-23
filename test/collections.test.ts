import { describe, expect, it } from 'vitest';
import type { DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import { CollectibleState, describeRecordObjectives, isCollected, recordFraction, recordProgress } from '../src/progress/collections.js';
import { fixtureDefs } from './helpers.js';

const defs = fixtureDefs();
const RISKRUNNER_CATALYST = 373671280;

const obj = (objectiveHash: number, progress: number, completionValue: number) => ({ objectiveHash, progress, completionValue, complete: progress >= completionValue, visible: true });

const profile = {
  profileCollectibles: { data: { collectibles: { 1: { state: 0 }, 2: { state: CollectibleState.NotAcquired } } } },
  characterCollectibles: { data: { w1: { collectibles: { 3: { state: 0 } } }, h1: { collectibles: { 4: { state: CollectibleState.NotAcquired } } } } },
  profileRecords: { data: { records: { 10: { state: 4, objectives: [obj(1, 1, 2)], intervalObjectives: [] } } } },
  characterRecords: {
    data: { w1: { records: { 11: { state: 4, objectives: [], intervalObjectives: [obj(1, 3, 10)] } } } },
  },
} as unknown as DestinyProfileResponse;

describe('isCollected', () => {
  it('reads profile-scoped collectibles', () => {
    expect(isCollected(profile, 1)).toBe(true);
    expect(isCollected(profile, 2)).toBe(false);
  });
  it('falls back to character-scoped collectibles in the given order', () => {
    expect(isCollected(profile, 3, ['h1', 'w1'])).toBe(true);
    expect(isCollected(profile, 4, ['w1', 'h1'])).toBe(false);
  });
  it('is unknown without a collectible or without state', () => {
    expect(isCollected(profile, undefined)).toBeUndefined();
    expect(isCollected(profile, 999, ['w1'])).toBeUndefined();
  });
});

describe('recordProgress', () => {
  it('prefers profile records and falls back to characters', () => {
    expect(recordProgress(profile, 10, ['w1'])?.objectives).toHaveLength(1);
    expect(recordProgress(profile, 11, ['w1'])).toBeDefined();
    expect(recordProgress(profile, 11, [])).toBeUndefined();
  });
  it('uses interval objectives for interval records', () => {
    expect(recordProgress(profile, 11, ['w1'])?.objectives[0]).toMatchObject({ progress: 3, completionValue: 10 });
  });
  it('does not crash on records without objective arrays', () => {
    const bare = { profileRecords: { data: { records: { 5: { state: 0 } } } } } as unknown as DestinyProfileResponse;
    expect(recordProgress(bare, 5)?.objectives).toEqual([]);
  });
});

describe('recordFraction', () => {
  it('averages across objectives weighted by completion value and caps overshoot', () => {
    expect(recordFraction([obj(1, 2, 2), obj(2, 371, 500), obj(3, 16, 50)])).toBeCloseTo((2 + 371 + 16) / 552);
    expect(recordFraction([obj(1, 9, 4)])).toBe(1);
    expect(recordFraction([])).toBe(0);
  });
});

describe('describeRecordObjectives', () => {
  it('names objectives from the manifest', () => {
    const catalyst = defs.record(RISKRUNNER_CATALYST)!;
    const out = describeRecordObjectives(catalyst.objectiveHashes.map((h) => obj(h, 1, 2)), defs);
    expect(out).toHaveLength(3);
    expect(out.every((o) => o.progress === '1/2')).toBe(true);
    expect(out.some((o) => o.description === 'Enemies Defeated')).toBe(true);
  });
});
