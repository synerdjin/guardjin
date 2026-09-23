import type {
  DestinyHistoricalStatsPeriodGroup,
  DestinyHistoricalStatsValue,
  DestinyPostGameCarnageReportData,
  DestinyPostGameCarnageReportEntry,
} from 'bungie-api-ts/destiny2';
import type { Defs } from '../manifest/defs.js';

type Values = Record<string, DestinyHistoricalStatsValue>;

/** Numeric value of a historical stat, when present. */
export const statValue = (values: Values | undefined, id: string): number | undefined => values?.[id]?.basic?.value;
const display = (values: Values | undefined, id: string): string | undefined => values?.[id]?.basic?.displayValue || undefined;

export interface ActivitySummary {
  /** Pass to get_activity_report. */
  instanceId: string;
  when: string;
  name: string;
  completed: boolean;
  /** PvP result, e.g. "Victory". */
  standing?: string;
  duration?: string;
  kills?: number;
  deaths?: number;
  assists?: number;
  efficiency?: number;
}

export function summarizeActivity(a: DestinyHistoricalStatsPeriodGroup, defs: Defs): ActivitySummary {
  const v = a.values;
  return {
    instanceId: a.activityDetails.instanceId,
    when: a.period,
    name: defs.activity(a.activityDetails.directorActivityHash)?.displayProperties.name || `Activity ${a.activityDetails.directorActivityHash}`,
    completed: statValue(v, 'completed') === 1,
    standing: statValue(v, 'standing') !== undefined ? display(v, 'standing') : undefined,
    duration: display(v, 'activityDurationSeconds'),
    kills: statValue(v, 'kills'),
    deaths: statValue(v, 'deaths'),
    assists: statValue(v, 'assists'),
    efficiency: round(statValue(v, 'efficiency')),
  };
}

const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100);

export interface PlayerReport {
  name: string;
  class: string;
  you: boolean;
  completed: boolean;
  kills?: number;
  deaths?: number;
  assists?: number;
  efficiency?: number;
  /** Weapons by kills, highest first. */
  weapons: { name: string; kills: number; precisionKills?: number }[];
}

export interface ActivityReport {
  activity: string;
  when: string;
  difficultyTier?: number;
  players: PlayerReport[];
}

function playerName(e: DestinyPostGameCarnageReportEntry): string {
  const info = e.player.destinyUserInfo;
  return info.bungieGlobalDisplayName
    ? `${info.bungieGlobalDisplayName}#${String(info.bungieGlobalDisplayNameCode ?? '').padStart(4, '0')}`
    : info.displayName || 'Unknown';
}

/** Compact post-game report; `membershipId` marks which entry is the current user. */
export function summarizeReport(data: DestinyPostGameCarnageReportData, defs: Defs, membershipId: string): ActivityReport {
  return {
    activity: defs.activity(data.activityDetails.directorActivityHash)?.displayProperties.name || `Activity ${data.activityDetails.directorActivityHash}`,
    when: data.period,
    difficultyTier: data.activityDifficultyTier,
    players: data.entries.map((e) => ({
      name: playerName(e),
      class: e.player.characterClass,
      you: e.player.destinyUserInfo.membershipId === membershipId,
      completed: statValue(e.values, 'completed') === 1,
      kills: statValue(e.values, 'kills'),
      deaths: statValue(e.values, 'deaths'),
      assists: statValue(e.values, 'assists'),
      efficiency: round(statValue(e.values, 'efficiency')),
      weapons: (e.extended?.weapons ?? [])
        .map((w) => ({
          name: defs.item(w.referenceId)?.displayProperties.name ?? `#${w.referenceId}`,
          kills: statValue(w.values, 'uniqueWeaponKills') ?? 0,
          precisionKills: statValue(w.values, 'uniqueWeaponPrecisionKills'),
        }))
        .sort((a, b) => b.kills - a.kills),
    })),
  };
}
