import { describe, expect, it } from 'vitest';
import type { DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import { Buckets } from '../src/inventory/constants.js';
import { buildPursuits } from '../src/quests/pursuits.js';
import { fixtureDefs } from './helpers.js';

const defs = fixtureDefs();
const MAGNUM_OPUS_STEP_4 = 2163065961; // quest step 4 of 6, objective "Xûr visited", rewards Forerunner
const XUR_VISITED = 2951255754;
const DECIMATION = 2192699203; // daily bounty, objective "Enemies defeated" 0/100
const ENEMIES_DEFEATED = 1334717226;
const NOW = Date.parse('2026-09-23T12:00:00Z');

const quest = (state = 0) => ({ itemHash: MAGNUM_OPUS_STEP_4, quantity: 1, bucketHash: Buckets.Quests, state, lockable: false, transferStatus: 2 });
const xurObjective = (progress: number) => ({
  objectives: { data: { [MAGNUM_OPUS_STEP_4]: { objectives: [{ objectiveHash: XUR_VISITED, progress, completionValue: 1, complete: progress >= 1, visible: true }] } } },
});

function profile(): DestinyProfileResponse {
  return {
    characters: {
      data: {
        w1: { characterId: 'w1', dateLastPlayed: '2026-09-20T00:00:00Z' },
        h1: { characterId: 'h1', dateLastPlayed: '2026-09-10T00:00:00Z' },
        t1: { characterId: 't1', dateLastPlayed: '2026-09-01T00:00:00Z' },
      },
    },
    characterInventories: {
      data: {
        w1: {
          items: [
            quest(2),
            { itemHash: DECIMATION, itemInstanceId: 'b1', quantity: 1, bucketHash: Buckets.Quests, state: 0, expirationDate: '2026-09-24T17:00:00Z' },
            { itemHash: DECIMATION, itemInstanceId: 'b2', quantity: 1, bucketHash: Buckets.Quests, state: 0, expirationDate: '2026-09-22T17:00:00Z' },
          ],
        },
        h1: { items: [quest()] },
        t1: { items: [quest()] },
      },
    },
    characterUninstancedItemComponents: { w1: xurObjective(0), h1: xurObjective(0), t1: xurObjective(1) },
    itemComponents: {
      objectives: {
        data: {
          b1: { objectives: [{ objectiveHash: ENEMIES_DEFEATED, progress: 100, completionValue: 100, complete: true, visible: true }] },
          b2: { objectives: [{ objectiveHash: ENEMIES_DEFEATED, progress: 40, completionValue: 100, complete: false, visible: true }] },
        },
      },
    },
  } as unknown as DestinyProfileResponse;
}

describe('buildPursuits', () => {
  const pursuits = buildPursuits(profile(), defs, NOW);

  it('reads quest steps with questline position, objectives from uninstanced components, and rewards', () => {
    const q = pursuits.find((p) => p.hash === MAGNUM_OPUS_STEP_4 && !p.complete)!;
    expect(q).toMatchObject({
      name: 'Magnum Opus',
      kind: 'quest',
      tracked: true,
      questline: { name: 'Magnum Opus', step: 4, totalSteps: 6 },
      objectives: [{ description: 'Xûr visited', progress: 0, completionValue: 1, complete: false }],
      rewards: [{ name: 'Forerunner' }],
    });
  });

  it('lists a pursuit once per distinct progress, with every character holding it', () => {
    const copies = pursuits.filter((p) => p.hash === MAGNUM_OPUS_STEP_4);
    expect(copies.map((p) => [p.characterIds, p.complete])).toEqual([
      [['w1', 'h1'], false],
      [['t1'], true],
    ]);
  });

  it('reads bounties with instanced objectives, completion and expiry', () => {
    const bounties = pursuits.filter((p) => p.kind === 'bounty');
    expect(bounties.map((b) => ({ progress: b.objectives[0].progress, complete: b.complete, expired: b.expired }))).toEqual([
      { progress: 100, complete: true, expired: false },
      { progress: 40, complete: false, expired: true },
    ]);
    expect(bounties[0].objectives[0].description).toBe('Enemies defeated');
    expect(bounties[0].rewards.map((r) => r.name)).toEqual(['XP+', 'Dark Fragment']);
  });

  it('ignores items outside the Quests bucket', () => {
    const p = profile();
    p.characterInventories!.data!.w1.items.push({ itemHash: DECIMATION, quantity: 1, bucketHash: Buckets.Kinetic, state: 0 } as never);
    expect(buildPursuits(p, defs, NOW)).toHaveLength(pursuits.length);
  });
});
