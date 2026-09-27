import { describe, expect, it } from 'vitest';
import type { DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import { buildCraftables } from '../src/progress/craftables.js';
import { buildWallet } from '../src/progress/currencies.js';
import { buildProgression } from '../src/progress/progression.js';
import { buildCommendations, buildKiosks, buildReceipts } from '../src/progress/social.js';
import { availableActivities, buildCurrentActivity } from '../src/world/activity.js';
import { mergeClears, mergeWeapons, summarizeStats } from '../src/history/career.js';
import { Buckets } from '../src/inventory/constants.js';
import { fixtureDefs } from './helpers.js';

const defs = fixtureDefs();
const asProfile = (p: unknown) => p as DestinyProfileResponse;
const hashOf = (name: string) => defs.searchItems({ query: name, limit: 5 }).find((r) => r.name === name)!.hash;

const SEASON = 2758726560;
const PASS = 1649015899;
const PASS_REWARD_PROGRESSION = 255193376;
const PASS_PRESTIGE_PROGRESSION = 2565871344;
const VANGUARD_TACTICAL = 611314723;
const VANGUARD_PROGRESSION = 457612306;
const ETERNITY_BECKONS = 2351139753;
const SUPREMACY_PATTERN = 2177480113; // crafts "The Supremacy"
const XUR = 2190858386;
const FUN_NODE = 1341823550;
const FUN_CHILD = 357212819;
const TOWER = 2728138991;
const DESERT_PERPETUAL = 1044919065;
const FATEBRINGER = 2171478765;

const progress = (progressToNextLevel: number, nextLevelAt: number, level = 4) => ({ level, levelCap: 16, progressToNextLevel, nextLevelAt, weeklyProgress: 0, weeklyLimit: 0, dailyProgress: 0, dailyLimit: 0, currentProgress: 0 });

describe('buildProgression', () => {
  const profile = asProfile({
    profile: { data: { currentSeasonHash: SEASON, currentSeasonPassHash: PASS, currentSeasonRewardPowerCap: 550, currentGuardianRank: 4, lifetimeHighestGuardianRank: 6, renewedGuardianRank: 4 } },
    profileProgression: { data: { seasonalArtifact: { artifactHash: 0, powerBonus: 12, pointsAcquired: 9, powerBonusProgression: { level: 12 } } } },
    characterProgressions: {
      data: {
        w1: {
          progressions: {
            [PASS_REWARD_PROGRESSION]: progress(15858, 100000, 13),
            [PASS_PRESTIGE_PROGRESSION]: progress(0, 0, 0),
          },
          factions: {
            [VANGUARD_TACTICAL]: { factionHash: VANGUARD_TACTICAL, progressionHash: VANGUARD_PROGRESSION, ...progress(200, 450), weeklyProgress: 30, weeklyLimit: 100 },
            1: { factionHash: 1, progressionHash: 2, ...progress(0, 0, 0) },
          },
          milestones: {
            [ETERNITY_BECKONS]: {
              milestoneHash: ETERNITY_BECKONS,
              availableQuests: [{ questItemHash: 0, status: { completed: false, stepObjectives: [{ objectiveHash: 1334717226, progress: 0, completionValue: 1, complete: false, visible: true }] } }],
            },
          },
        },
      },
    },
  });

  it('reads season, season pass, guardian rank and artifact', () => {
    const p = buildProgression(profile, defs, 'w1');
    expect(p.guardianRank).toEqual({ current: 4, lifetimeHighest: 6, renewed: 4 });
    expect(p.season).toMatchObject({ number: 28, powerCap: 550 });
    expect(p.seasonPass).toEqual({ level: 13, toNext: '15858/100000', prestigeLevel: undefined });
    expect(p.artifact).toMatchObject({ powerBonus: 12, pointsUnlocked: 9 });
  });

  it('names factions, formats progress, and skips ones with no progress or no name', () => {
    const { factions } = buildProgression(profile, defs, 'w1');
    expect(factions).toEqual([{ name: 'Vanguard Tactical', level: 4, levelCap: 16, toNext: '200/450', weekly: '30/100', daily: undefined }]);
  });

  it('names milestones and marks completion from their quests', () => {
    const { milestones } = buildProgression(profile, defs, 'w1');
    expect(milestones).toHaveLength(1);
    expect(milestones[0]).toMatchObject({ name: 'Eternity Beckons', completed: undefined });
    expect(milestones[0].quests[0].objectives[0]).toMatchObject({ progress: '0/1' });
  });
});

describe('buildWallet', () => {
  const glimmer = hashOf('Glimmer');
  const shards = hashOf('Legendary Shards');
  it('sums split stacks, sorts by quantity, and reads materials from the right buckets', () => {
    const wallet = buildWallet(
      asProfile({
        profileCurrencies: { data: { items: [{ itemHash: glimmer, quantity: 100 }, { itemHash: glimmer, quantity: 50 }, { itemHash: shards, quantity: 400 }, { itemHash: 999999, quantity: 5 }] } },
        platformSilver: { data: { platformSilver: { 3: { itemHash: hashOf('Glimmer'), quantity: 1800 } } } },
        profileInventory: { data: { items: [{ itemHash: shards, quantity: 7, bucketHash: Buckets.Materials }, { itemHash: glimmer, quantity: 3, bucketHash: Buckets.Vault }] } },
      }),
      defs,
    );
    expect(wallet.currencies).toEqual([{ name: 'Legendary Shards', quantity: 400 }, { name: 'Glimmer', quantity: 150 }]);
    expect(wallet.silver).toEqual([{ name: 'Glimmer', quantity: 1800 }]);
    expect(wallet.materials).toEqual([{ name: 'Legendary Shards', quantity: 7 }]);
  });
});

describe('buildCraftables', () => {
  const component = (failed: number[], visible = true) => ({ visible, failedRequirementIndexes: failed, sockets: [] });
  it('names patterns by the weapon they craft and explains locked ones', () => {
    const [c] = buildCraftables(asProfile({ characterCraftables: { data: { w1: { craftables: { [SUPREMACY_PATTERN]: component([0]) } } } } }), defs);
    expect(c).toEqual({ name: 'The Supremacy', type: 'Sniper Rifle', unlocked: false, reasons: ['Pattern has not been unlocked.'] });
  });
  it('counts a pattern as unlocked when any character can craft it, and hides invisible ones', () => {
    const profile = asProfile({
      characterCraftables: { data: { w1: { craftables: { [SUPREMACY_PATTERN]: component([0]) } }, h1: { craftables: { [SUPREMACY_PATTERN]: component([]) } } } },
    });
    expect(buildCraftables(profile, defs)[0].unlocked).toBe(true);
    const hidden = asProfile({ characterCraftables: { data: { w1: { craftables: { [SUPREMACY_PATTERN]: component([], false) } } } } });
    expect(buildCraftables(hidden, defs)).toEqual([]);
  });
});

describe('kiosks, receipts and commendations', () => {
  const xur = defs.vendor(XUR)!;
  it('merges profile and character kiosks per vendor and explains failures from the vendor definition', () => {
    const kiosks = buildKiosks(
      asProfile({
        profileKiosks: { data: { kioskItems: { [XUR]: [{ index: 0, canAcquire: false, failureIndexes: [0] }] } } },
        characterKiosks: { data: { w1: { kioskItems: { [XUR]: [{ index: 0, canAcquire: false, failureIndexes: [10] }, { index: 1, canAcquire: true, failureIndexes: [] }] } } } },
      }),
      defs,
    );
    expect(kiosks).toHaveLength(1);
    expect(kiosks[0]).toMatchObject({ vendor: 'Xûr', total: 2, acquirable: 1 });
    expect(kiosks[0].items[0].reasons).toEqual([xur.failureStrings[0]]);
    expect(kiosks[0].items[1].canAcquire).toBe(true);
  });

  it('describes refundable purchases', () => {
    const [r] = buildReceipts(
      asProfile({ vendorReceipts: { data: { receipts: [{ itemReceived: { itemHash: FATEBRINGER, quantity: 1 }, currencyPaid: [{ itemHash: hashOf('Glimmer'), quantity: 500 }], refundPolicy: 1, expiresOn: '2026-10-01T00:00:00Z', purchasedByCharacterId: 'w1' }] } } }),
      defs,
      (id) => (id === 'w1' ? 'Warlock' : undefined),
    );
    expect(r).toEqual({ item: 'Fatebringer', quantity: 1, paid: ['Glimmer x500'], refund: 'refundable', expires: '2026-10-01T00:00:00Z', character: 'Warlock' });
  });

  it('groups commendation scores by category and ignores unnamed groups', () => {
    const c = buildCommendations(
      asProfile({
        profileCommendations: { data: { totalScore: 217, commendationNodeScoresByHash: { [FUN_NODE]: 35, 1: 4 }, commendationNodePercentagesByHash: { [FUN_NODE]: 54 }, commendationScoresByHash: { [FUN_CHILD]: 2 } } },
      }),
      defs,
    )!;
    expect(c.totalScore).toBe(217);
    expect(c.nodes).toHaveLength(1);
    expect(c.nodes[0]).toMatchObject({ name: 'Fun', score: 35, percent: 54 });
    expect(c.nodes[0].commendations.find((x) => x.score === 2)).toBeDefined();
  });
});

describe('buildCurrentActivity', () => {
  it('recognizes social spaces, activities and offline', () => {
    const social = buildCurrentActivity({ currentActivityHash: TOWER, currentActivityModeTypes: [40], currentActivityModeHashes: [], dateActivityStarted: '2026-09-23T22:00:00Z' } as never, undefined, defs);
    expect(social).toMatchObject({ state: 'orbit-or-social', gearChangesLikely: true, activity: 'Tower' });

    const raid = buildCurrentActivity({ currentActivityHash: DESERT_PERPETUAL, currentActivityModeTypes: [4], currentActivityModeHashes: [] } as never, undefined, defs);
    expect(raid).toMatchObject({ state: 'in-activity', gearChangesLikely: false });

    const offline = buildCurrentActivity({ currentActivityHash: 0, currentActivityModeTypes: [], currentActivityModeHashes: [] } as never, undefined, defs);
    expect(offline).toMatchObject({ state: 'offline', gearChangesLikely: true, since: undefined });
  });

  it('recognizes orbit: a nameless activity with no modes', () => {
    // Shape observed live: hash 82913930, no mode types, mode hash is the "none" sentinel.
    const orbit = buildCurrentActivity({ currentActivityHash: 82913930, currentActivityModeHash: 2166136261, currentActivityModeTypes: undefined, currentActivityModeHashes: undefined } as never, undefined, defs);
    expect(orbit).toMatchObject({ state: 'orbit-or-social', gearChangesLikely: true, activity: 'Orbit', modes: [] });
    // An unknown hash with the same shape (Bungie renumbering) is still treated as orbit.
    expect(buildCurrentActivity({ currentActivityHash: 123, currentActivityModeTypes: [], currentActivityModeHashes: [] } as never, undefined, defs).state).toBe('orbit-or-social');
  });

  it('decodes fireteam status flags and lists launchable activities', () => {
    const current = buildCurrentActivity(
      { currentActivityHash: TOWER, currentActivityModeTypes: [40], currentActivityModeHashes: [] } as never,
      { partyMembers: [{ displayName: 'Me', status: 1 | 2 }], joinability: { openSlots: 2 }, currentActivity: { numberOfPlayers: 3, score: 0 } } as never,
      defs,
    );
    expect(current.fireteam).toEqual([{ name: 'Me', status: ['member', 'posse'] }]);
    expect(current).toMatchObject({ openSlots: 2, players: 3 });

    const list = availableActivities(
      { availableActivities: [{ activityHash: DESERT_PERPETUAL, isVisible: true, isCompleted: true, canJoin: true, recommendedLight: 10, modifierHashes: [] }, { activityHash: TOWER, isVisible: false, modifierHashes: [] }] } as never,
      defs,
    );
    expect(list).toEqual([{ name: 'The Desert Perpetual: Standard', recommendedLight: 10, completed: true, canJoin: true, modifiers: [] }]);
  });
});

const v = (value: number, displayValue = String(value)) => ({ statId: '', basic: { value, displayValue }, pga: { value, displayValue }, weighted: { value, displayValue } });

describe('career stats', () => {
  it('summarizes headline stats, leaving out ones a mode does not report', () => {
    const out = summarizeStats({ kills: v(100, '100'), deaths: v(4, '4'), obscure: v(1, '1') });
    expect(out).toEqual({ kills: '100', deaths: '4' });
    expect(Object.keys(summarizeStats({ kills: v(1), zzz: v(2), aaa: v(3) }, true))).toEqual(['aaa', 'kills', 'zzz']);
  });

  it('merges clears across characters, keeping the fastest time and skipping unnamed activities', () => {
    const clears = mergeClears(
      [
        [{ activityHash: DESERT_PERPETUAL, values: { activityCompletions: v(3), activityKills: v(100), fastestCompletionMsForActivity: v(900000, '15:00') } }],
        [{ activityHash: DESERT_PERPETUAL, values: { activityCompletions: v(2), activityKills: v(50), fastestCompletionMsForActivity: v(600000, '10:00') } }, { activityHash: 12345, values: { activityCompletions: v(9) } }],
      ],
      defs,
    );
    expect(clears).toEqual([{ name: 'The Desert Perpetual: Standard', kind: 'raid', completions: 5, kills: 150, fastest: '10:00', fastestMs: 600000 }]);
  });

  it('merges weapon stats across characters and computes precision share', () => {
    const [w] = mergeWeapons(
      [
        [{ referenceId: FATEBRINGER, values: { uniqueWeaponKills: v(80), uniqueWeaponPrecisionKills: v(20) } }],
        [{ referenceId: FATEBRINGER, values: { uniqueWeaponKills: v(20), uniqueWeaponPrecisionKills: v(5) } }, { referenceId: 1, values: { uniqueWeaponKills: v(9) } }],
      ],
      defs,
    );
    expect(w).toMatchObject({ name: 'Fatebringer', kills: 100, precisionKills: 25, precisionPercent: 25 });
  });
});
