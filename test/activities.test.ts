import { describe, expect, it } from 'vitest';
import type { DestinyHistoricalStatsPeriodGroup, DestinyPostGameCarnageReportData } from 'bungie-api-ts/destiny2';
import { summarizeActivity, summarizeReport } from '../src/history/activities.js';
import { fixtureDefs } from './helpers.js';

const defs = fixtureDefs();
const DESERT_PERPETUAL = 1044919065;
const FATEBRINGER = 2171478765;

const v = (value: number, displayValue = String(value)) => ({ statId: '', basic: { value, displayValue }, pga: { value, displayValue }, weighted: { value, displayValue } });

describe('summarizeActivity', () => {
  const group = {
    period: '2026-09-23T20:51:43Z',
    activityDetails: { instanceId: '77', directorActivityHash: DESERT_PERPETUAL },
    values: {
      completed: v(1),
      kills: v(143),
      deaths: v(4),
      assists: v(26),
      efficiency: v(42.254),
      activityDurationSeconds: v(947, '15m 47s'),
    },
  } as unknown as DestinyHistoricalStatsPeriodGroup;

  it('names the activity and reads core stats', () => {
    expect(summarizeActivity(group, defs)).toEqual({
      instanceId: '77',
      when: '2026-09-23T20:51:43Z',
      name: 'The Desert Perpetual: Standard',
      completed: true,
      standing: undefined,
      duration: '15m 47s',
      kills: 143,
      deaths: 4,
      assists: 26,
      efficiency: 42.25,
    });
  });

  it('shows PvP standing only when the activity reports one, and falls back for unknown activities', () => {
    const pvp = { ...group, activityDetails: { ...group.activityDetails, instanceId: '78', directorActivityHash: 1 }, values: { ...group.values, standing: v(0, 'Victory') } };
    expect(summarizeActivity(pvp, defs)).toMatchObject({ standing: 'Victory', name: 'Activity 1' });
  });
});

describe('summarizeReport', () => {
  const entry = (membershipId: string, name: string, kills: number, weapons: { referenceId: number; kills: number }[]) => ({
    player: { destinyUserInfo: { membershipId, displayName: name, bungieGlobalDisplayName: name, bungieGlobalDisplayNameCode: 42 }, characterClass: 'Warlock' },
    values: { completed: v(1), kills: v(kills), deaths: v(1), assists: v(2), efficiency: v(3) },
    extended: { weapons: weapons.map((w) => ({ referenceId: w.referenceId, values: { uniqueWeaponKills: v(w.kills), uniqueWeaponPrecisionKills: v(1) } })) },
  });
  const report = {
    period: '2026-09-23T20:51:43Z',
    activityDifficultyTier: 2,
    activityDetails: { directorActivityHash: DESERT_PERPETUAL },
    entries: [entry('1', 'Me', 10, [{ referenceId: 999, kills: 2 }, { referenceId: FATEBRINGER, kills: 8 }]), entry('2', 'Friend', 5, [])],
  } as unknown as DestinyPostGameCarnageReportData;

  it('marks the current player, formats names, and sorts weapons by kills', () => {
    const r = summarizeReport(report, defs, '1');
    expect(r).toMatchObject({ activity: 'The Desert Perpetual: Standard', difficultyTier: 2 });
    expect(r.players.map((p) => [p.name, p.you])).toEqual([['Me#0042', true], ['Friend#0042', false]]);
    expect(r.players[0].weapons.map((w) => [w.name, w.kills])).toEqual([['Fatebringer', 8], ['#999', 2]]);
  });
});
