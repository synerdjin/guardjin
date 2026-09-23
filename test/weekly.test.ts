import { describe, expect, it } from 'vitest';
import type { DestinyPublicMilestone } from 'bungie-api-ts/destiny2';
import { buildWeekly } from '../src/world/weekly.js';
import { fixtureDefs } from './helpers.js';

const defs = fixtureDefs();
const DESERT_PERPETUAL_MILESTONE = 3022338715;
const DESERT_PERPETUAL_ACTIVITY = 1044919065;
const MODIFIER = 2835296134; // "Exotic Drop Rate Boosts Gained"
const XUR = 2190858386;

const milestone = (p: Partial<DestinyPublicMilestone>): DestinyPublicMilestone =>
  ({ milestoneHash: DESERT_PERPETUAL_MILESTONE, availableQuests: [], activities: [], vendorHashes: [], vendors: [], order: 0, ...p }) as DestinyPublicMilestone;

describe('buildWeekly', () => {
  it('names milestones, activities and modifiers, and removes duplicate modifiers', () => {
    const out = buildWeekly(
      {
        1: milestone({
          endDate: '2026-09-29T17:00:00Z',
          activities: [{ activityHash: DESERT_PERPETUAL_ACTIVITY, modifierHashes: [MODIFIER, MODIFIER], challengeObjectiveHashes: [], phaseHashes: [], booleanActivityOptions: {} }],
          vendorHashes: [XUR],
        }),
      },
      defs,
    );
    expect(out).toEqual([
      {
        name: 'The Desert Perpetual',
        description: expect.any(String),
        starts: undefined,
        ends: '2026-09-29T17:00:00Z',
        activities: [{ name: 'The Desert Perpetual: Standard', modifiers: ['Exotic Drop Rate Boosts Gained'], challenges: [] }],
        vendors: ['Xûr'],
      },
    ]);
  });

  it('skips milestones with nothing to show and orders by the game-provided order', () => {
    const withActivity = (order: number) =>
      milestone({ order, activities: [{ activityHash: DESERT_PERPETUAL_ACTIVITY, modifierHashes: [], challengeObjectiveHashes: [], phaseHashes: [], booleanActivityOptions: {} }] });
    const out = buildWeekly({ 1: withActivity(5), 2: milestone({ order: 1 }), 3: withActivity(2) }, defs);
    expect(out).toHaveLength(2);
    expect(buildWeekly({ 1: milestone({ order: 1 }) }, defs)).toEqual([]);
  });
});
