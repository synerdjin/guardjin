import type { DestinyCharacterActivitiesComponent, DestinyProfileTransitoryComponent } from 'bungie-api-ts/destiny2';
import type { Defs } from '../manifest/defs.js';

/** DestinyActivityModeType.Social */
const SOCIAL_MODE = 40;
/** DestinyPartyMemberStates flags. */
const PARTY_STATUS: [number, string][] = [[1, 'member'], [2, 'posse'], [4, 'groupable'], [8, 'created-player']];

export type PlayState = 'offline' | 'orbit-or-social' | 'in-activity';

export interface CurrentActivity {
  state: PlayState;
  /** Whether gear, mod and loadout changes are likely to be accepted right now. */
  gearChangesLikely: boolean;
  activity?: string;
  modes: string[];
  since?: string;
  fireteam: { name: string; status: string[] }[];
  openSlots?: number;
  score?: number;
  players?: number;
}

/**
 * Where a character is right now. Orbit and social spaces are recognized by activity mode or name;
 * an unknown activity is treated as "in an activity", which is the safe reading for write actions.
 */
export function buildCurrentActivity(
  activities: DestinyCharacterActivitiesComponent | undefined,
  transitory: DestinyProfileTransitoryComponent | undefined,
  defs: Defs,
): CurrentActivity {
  const hash = activities?.currentActivityHash ?? 0;
  const def = hash ? defs.activity(hash) : undefined;
  const name = def?.displayProperties.name || undefined;
  const modeTypes = activities?.currentActivityModeTypes ?? [];
  const social = modeTypes.includes(SOCIAL_MODE) || /^(orbit|social|(the )?tower|h\.e\.l\.m\.)/i.test(name ?? '');
  const state: PlayState = !hash ? 'offline' : social ? 'orbit-or-social' : 'in-activity';
  const current = transitory?.currentActivity;
  return {
    state,
    gearChangesLikely: state !== 'in-activity',
    activity: name,
    modes: (activities?.currentActivityModeHashes ?? []).map((h) => defs.activityMode(h)?.displayProperties?.name ?? '').filter(Boolean),
    since: hash ? activities?.dateActivityStarted : undefined,
    fireteam: (transitory?.partyMembers ?? []).map((m) => ({ name: m.displayName, status: PARTY_STATUS.filter(([bit]) => (m.status & bit) !== 0).map(([, n]) => n) })),
    openSlots: transitory?.joinability?.openSlots,
    score: current?.score || undefined,
    players: current?.numberOfPlayers || undefined,
  };
}

export interface AvailableActivity {
  name: string;
  recommendedLight?: number;
  completed: boolean;
  canJoin: boolean;
  modifiers: string[];
}

/** Activities the character can currently launch. */
export function availableActivities(activities: DestinyCharacterActivitiesComponent | undefined, defs: Defs): AvailableActivity[] {
  return (activities?.availableActivities ?? []).flatMap((a) => {
    const name = defs.activity(a.activityHash)?.displayProperties.name;
    if (!name || !a.isVisible) return [];
    const modifiers = [...new Set((a.modifierHashes ?? []).map((h) => defs.get<{ displayProperties?: { name?: string } }>('DestinyActivityModifierDefinition', h)?.displayProperties?.name ?? '').filter(Boolean))];
    return [{ name, recommendedLight: a.recommendedLight || undefined, completed: a.isCompleted, canJoin: a.canJoin, modifiers }];
  });
}
