import type {
  DestinyAggregateActivityStats,
  DestinyHistoricalStatsValue,
  DestinyHistoricalWeaponStats,
} from 'bungie-api-ts/destiny2';
import type { Defs } from '../manifest/defs.js';
import { activityKind, type ActivityKind } from '../world/activity.js';

type Stats = Record<string, DestinyHistoricalStatsValue>;
const num = (s: Stats | undefined, id: string) => s?.[id]?.basic?.value;
const shown = (s: Stats | undefined, id: string) => s?.[id]?.basic?.displayValue;

const HEADLINE = [
  'kills', 'deaths', 'assists', 'killsDeathsRatio', 'killsDeathsAssists', 'efficiency', 'precisionKills',
  'activitiesEntered', 'activitiesCleared', 'activitiesWon', 'winLossRatio', 'secondsPlayed',
  'bestSingleGameKills', 'longestKillSpree', 'averageLifespan', 'suicides',
] as const;

/** Headline stats (or every stat with `all`), as display strings. Stats the mode doesn't report are left out. */
export function summarizeStats(allTime: Stats | undefined, all = false): Record<string, string> {
  const ids = all ? Object.keys(allTime ?? {}).sort() : HEADLINE.filter((id) => allTime?.[id]);
  return Object.fromEntries(ids.flatMap((id) => (shown(allTime, id) ? [[id, shown(allTime, id)!]] : [])));
}

export interface Clear {
  name: string;
  /** raid, dungeon, strike, nightfall, lostSector, exoticMission */
  kind?: ActivityKind;
  completions: number;
  kills?: number;
  /** Fastest clear time as the game displays it. */
  fastest?: string;
  fastestMs?: number;
}

/** Sums per-character activity stats, so one activity appears once with combined completions. */
export function mergeClears(perCharacter: DestinyAggregateActivityStats[][], defs: Defs): Clear[] {
  const byHash = new Map<number, { completions: number; kills: number; fastest?: DestinyHistoricalStatsValue }>();
  for (const list of perCharacter) {
    for (const a of list) {
      const cur = byHash.get(a.activityHash) ?? { completions: 0, kills: 0 };
      cur.completions += num(a.values, 'activityCompletions') ?? 0;
      cur.kills += num(a.values, 'activityKills') ?? 0;
      const f = a.values.fastestCompletionMsForActivity;
      if (f && f.basic.value > 0 && (!cur.fastest || f.basic.value < cur.fastest.basic.value)) cur.fastest = f;
      byHash.set(a.activityHash, cur);
    }
  }
  return [...byHash].flatMap(([hash, v]) => {
    const name = defs.activity(hash)?.displayProperties.name;
    if (!name) return [];
    return [{ name, kind: activityKind(defs, hash), completions: v.completions, kills: v.kills || undefined, fastest: v.fastest?.basic.displayValue, fastestMs: v.fastest?.basic.value }];
  });
}

export interface WeaponStat {
  name: string;
  type?: string;
  kills: number;
  precisionKills: number;
  /** Share of kills that were precision hits, 0-100. */
  precisionPercent: number;
}

/** Sums per-character unique weapon stats. */
export function mergeWeapons(perCharacter: DestinyHistoricalWeaponStats[][], defs: Defs): WeaponStat[] {
  const byHash = new Map<number, { kills: number; precision: number }>();
  for (const list of perCharacter) {
    for (const w of list) {
      const cur = byHash.get(w.referenceId) ?? { kills: 0, precision: 0 };
      cur.kills += num(w.values, 'uniqueWeaponKills') ?? 0;
      cur.precision += num(w.values, 'uniqueWeaponPrecisionKills') ?? 0;
      byHash.set(w.referenceId, cur);
    }
  }
  return [...byHash].flatMap(([hash, v]) => {
    const def = defs.item(hash);
    if (!def?.displayProperties.name) return [];
    return [
      {
        name: def.displayProperties.name,
        type: def.itemTypeDisplayName || undefined,
        kills: v.kills,
        precisionKills: v.precision,
        precisionPercent: v.kills ? Math.round((v.precision / v.kills) * 1000) / 10 : 0,
      },
    ];
  });
}
