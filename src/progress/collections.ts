import type { DestinyObjectiveProgress, DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import type { Defs } from '../manifest/defs.js';

/** DestinyCollectibleState flags. */
export const CollectibleState = { NotAcquired: 1, Obscured: 2, Invisible: 4 } as const;
/** DestinyRecordState flags. */
export const RecordState = { Redeemed: 1, ObjectiveNotCompleted: 4, Obscured: 8, Invisible: 16 } as const;

/** Collection state for a collectible; character-scoped collectibles are read from `characterIds` in order. */
export function collectibleState(profile: DestinyProfileResponse, hash: number, characterIds: string[] = []): number | undefined {
  const fromProfile = profile.profileCollectibles?.data?.collectibles?.[hash];
  if (fromProfile) return fromProfile.state;
  for (const id of characterIds) {
    const c = profile.characterCollectibles?.data?.[id]?.collectibles?.[hash];
    if (c) return c.state;
  }
  return undefined;
}

/** True/false when known, undefined when the item has no collectible entry or the state isn't in the response. */
export function isCollected(profile: DestinyProfileResponse, collectibleHash: number | undefined, characterIds: string[] = []): boolean | undefined {
  if (!collectibleHash) return undefined;
  const state = collectibleState(profile, collectibleHash, characterIds);
  return state === undefined ? undefined : (state & CollectibleState.NotAcquired) === 0;
}

export interface RecordProgress {
  state: number;
  objectives: DestinyObjectiveProgress[];
}

/**
 * Record state and objectives, from the profile first and then the given characters. Interval
 * records (multi-tier titles) report progress in `intervalObjectives` instead of `objectives`.
 */
export function recordProgress(profile: DestinyProfileResponse, hash: number, characterIds: string[] = []): RecordProgress | undefined {
  let r = profile.profileRecords?.data?.records?.[hash];
  for (const id of characterIds) {
    if (r) break;
    r = profile.characterRecords?.data?.[id]?.records?.[hash];
  }
  if (!r) return undefined;
  return { state: r.state, objectives: r.objectives?.length ? r.objectives : (r.intervalObjectives ?? []) };
}

/** Overall completion in [0, 1] across a record's objectives. */
export function recordFraction(objectives: DestinyObjectiveProgress[]): number {
  const total = objectives.reduce((n, o) => n + o.completionValue, 0);
  if (!total) return 0;
  const done = objectives.reduce((n, o) => n + Math.min(o.progress ?? 0, o.completionValue), 0);
  return done / total;
}

export function describeRecordObjectives(objectives: DestinyObjectiveProgress[], defs: Defs) {
  return objectives.map((o) => ({
    description: (defs.objective(o.objectiveHash)?.progressDescription ?? '').trim(),
    progress: `${o.progress ?? 0}/${o.completionValue}`,
    ...(o.complete ? { complete: true } : {}),
  }));
}
