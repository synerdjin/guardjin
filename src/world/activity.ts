import type { DestinyCharacterActivitiesComponent, DestinyProfileTransitoryComponent } from 'bungie-api-ts/destiny2';
import type { Defs } from '../manifest/defs.js';

/** DestinyActivityModeType.Social */
const SOCIAL_MODE = 40;
/** The activity Bungie reports while a character is in orbit; it has no name and no modes. */
const ORBIT_ACTIVITY_HASH = 82913930;
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
  const modeHashes = (activities?.currentActivityModeHashes ?? []).filter((h) => defs.activityMode(h)?.displayProperties?.name);
  // Orbit is a known activity, or (in case Bungie renumbers it) any activity with no name and no modes.
  const orbit = hash === ORBIT_ACTIVITY_HASH || (!!hash && !name && !modeTypes.length && !modeHashes.length);
  const social = orbit || modeTypes.includes(SOCIAL_MODE) || /^(orbit|social|(the )?tower|h\.e\.l\.m\.)/i.test(name ?? '');
  const state: PlayState = !hash ? 'offline' : social ? 'orbit-or-social' : 'in-activity';
  const current = transitory?.currentActivity;
  return {
    state,
    gearChangesLikely: state !== 'in-activity',
    activity: name ?? (orbit ? 'Orbit' : undefined),
    modes: (activities?.currentActivityModeHashes ?? []).map((h) => defs.activityMode(h)?.displayProperties?.name ?? '').filter(Boolean),
    since: hash ? activities?.dateActivityStarted : undefined,
    fireteam: (transitory?.partyMembers ?? []).map((m) => ({ name: m.displayName, status: PARTY_STATUS.filter(([bit]) => (m.status & bit) !== 0).map(([, n]) => n) })),
    openSlots: transitory?.joinability?.openSlots,
    score: current?.score || undefined,
    players: current?.numberOfPlayers || undefined,
  };
}

export interface AvailableActivity {
  /** Stable across calls; several activities can share a name. */
  activityHash: number;
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
    return [{ activityHash: a.activityHash, name, recommendedLight: a.recommendedLight || undefined, completed: a.isCompleted, canJoin: a.canJoin, modifiers }];
  });
}

/** Activity kinds get_activity_clears can filter on. */
export const ACTIVITY_KINDS = ['raid', 'dungeon', 'strike', 'nightfall', 'lostSector', 'exoticMission'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

const TYPE_NAMES: Record<string, ActivityKind> = {
  raid: 'raid',
  dungeon: 'dungeon',
  strike: 'strike',
  'vanguard op': 'strike',
  nightfall: 'nightfall',
  'lost sector': 'lostSector',
  'exotic mission': 'exoticMission',
};
/** DestinyActivityModeType fallbacks for activities without a named type. */
const MODE_KINDS: Record<number, ActivityKind> = { 4: 'raid', 82: 'dungeon', 18: 'strike', 3: 'strike', 46: 'nightfall', 16: 'nightfall', 87: 'lostSector' };

/**
 * What kind of activity a hash is. Newer raids and dungeons have no direct mode, so the activity
 * type's name decides first and the mode is the fallback.
 */
export function activityKind(defs: Defs, activityHash: number): ActivityKind | undefined {
  const def = defs.activity(activityHash);
  if (!def) return undefined;
  const typeName = defs.activityType(def.activityTypeHash)?.displayProperties?.name?.trim().toLowerCase();
  return (typeName && TYPE_NAMES[typeName]) || (def.directActivityModeType !== undefined ? MODE_KINDS[def.directActivityModeType] : undefined);
}

/** "Duality: Master" → "Duality"; difficulty variants share one base name. */
export function baseActivityName(name: string): string {
  return name.replace(/:\s*(Standard|Normal|Master|Legend|Contest|Customize|Expert|Grandmaster|Hero|Adept|Epic)$/i, '').replace(/\s*\((Epic|Legend|Master)\)$/i, '').trim();
}

/**
 * Raids and dungeons you can launch yourself. A dungeon you don't own shows up with canLead false
 * (you can only join someone who owns it).
 */
export function launchableActivities(perCharacter: (DestinyCharacterActivitiesComponent | undefined)[], defs: Defs, kind: ActivityKind): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const acts of perCharacter) {
    for (const a of acts?.availableActivities ?? []) {
      if (activityKind(defs, a.activityHash) !== kind) continue;
      const name = defs.activity(a.activityHash)?.displayProperties.name;
      if (!name) continue;
      const base = baseActivityName(name);
      out.set(base, (out.get(base) ?? false) || a.canLead);
    }
  }
  return out;
}
