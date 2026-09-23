import type { DestinyItemComponent, DestinyObjectiveProgress, DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import { Buckets, ItemStateFlags, ItemType } from '../inventory/constants.js';
import type { Defs } from '../manifest/defs.js';

export type PursuitKind = 'quest' | 'bounty' | 'other';

export interface PursuitObjective {
  description: string;
  progress: number;
  completionValue: number;
  complete: boolean;
  /** Where the objective must be done, when the API says. */
  activity?: string;
  destination?: string;
}

export interface Pursuit {
  hash: number;
  name: string;
  type: string;
  kind: PursuitKind;
  description?: string;
  /** Position in a multi-step quest. */
  questline?: { name: string; step: number; totalSteps: number; summary?: string };
  objectives: PursuitObjective[];
  /** Every visible objective is done (bounties are ready to turn in). */
  complete: boolean;
  tracked: boolean;
  expires?: string;
  expired: boolean;
  rewards: { name: string; quantity: number }[];
  /** Characters holding this pursuit with the same progress, most recently played first. */
  characterIds: string[];
  /** Per-character item instances. Only instanced pursuits can be tracked or untracked. */
  instances: { characterId: string; instanceId: string }[];
}

const QUEST_TYPES: number[] = [ItemType.Quest, ItemType.QuestStep, ItemType.QuestStepComplete];

export function pursuitKind(itemType: number): PursuitKind {
  if (QUEST_TYPES.includes(itemType)) return 'quest';
  if (itemType === ItemType.Bounty) return 'bounty';
  return 'other';
}

/**
 * Reads quests, bounties and other pursuits from each character's Quests bucket. Needs the
 * Characters, CharacterInventories and ItemObjectives components. A pursuit that several
 * characters hold with identical progress (common for account-wide quests) is listed once.
 */
export function buildPursuits(profile: DestinyProfileResponse, defs: Defs, now = Date.now()): Pursuit[] {
  const characterOrder = Object.values(profile.characters?.data ?? {})
    .sort((a, b) => b.dateLastPlayed.localeCompare(a.dateLastPlayed))
    .map((c) => c.characterId);

  const merged = new Map<string, Pursuit>();
  for (const characterId of characterOrder) {
    for (const component of profile.characterInventories?.data?.[characterId]?.items ?? []) {
      if (component.bucketHash !== Buckets.Quests) continue;
      const pursuit = buildPursuit(component, characterId, profile, defs, now);
      if (!pursuit) continue;
      const key = `${pursuit.hash}|${pursuit.objectives.map((o) => `${o.progress}/${o.completionValue}`).join(',')}`;
      const existing = merged.get(key);
      if (existing) {
        existing.characterIds.push(characterId);
        existing.instances.push(...pursuit.instances);
        existing.tracked ||= pursuit.tracked;
      } else {
        merged.set(key, pursuit);
      }
    }
  }
  return [...merged.values()];
}

function buildPursuit(
  c: DestinyItemComponent,
  characterId: string,
  profile: DestinyProfileResponse,
  defs: Defs,
  now: number,
): Pursuit | undefined {
  const def = defs.item(c.itemHash);
  if (!def?.displayProperties.name) return undefined;

  // Instanced pursuits keep objectives per instance; uninstanced ones per character and item hash.
  const progress: DestinyObjectiveProgress[] =
    (c.itemInstanceId
      ? profile.itemComponents?.objectives?.data?.[c.itemInstanceId]?.objectives
      : profile.characterUninstancedItemComponents?.[characterId]?.objectives?.data?.[c.itemHash]?.objectives) ?? [];

  const objectives = progress
    .filter((o) => o.visible !== false)
    .map((o): PursuitObjective => {
      const od = defs.objective(o.objectiveHash);
      const out: PursuitObjective = {
        description: (od?.progressDescription || od?.displayProperties?.name || '').trim(),
        progress: o.progress ?? 0,
        completionValue: o.completionValue,
        complete: o.complete,
      };
      const activity = o.activityHash ? defs.activity(o.activityHash)?.displayProperties.name : undefined;
      const destination = o.destinationHash ? defs.destination(o.destinationHash)?.displayProperties.name : undefined;
      if (activity) out.activity = activity;
      if (destination) out.destination = destination;
      return out;
    });

  const expires = c.expirationDate || undefined;
  const pursuit: Pursuit = {
    hash: c.itemHash,
    name: def.displayProperties.name,
    type: def.itemTypeDisplayName,
    kind: pursuitKind(def.itemType),
    objectives,
    complete: objectives.length > 0 && objectives.every((o) => o.complete),
    tracked: (c.state & ItemStateFlags.Tracked) !== 0,
    expires,
    expired: expires ? Date.parse(expires) <= now : false,
    rewards: (def.value?.itemValue ?? [])
      .filter((r) => r.itemHash)
      .map((r) => ({ name: defs.item(r.itemHash)?.displayProperties.name ?? '', quantity: r.quantity }))
      .filter((r) => r.name),
    characterIds: [characterId],
    instances: c.itemInstanceId ? [{ characterId, instanceId: c.itemInstanceId }] : [],
  };

  const description = def.displayProperties.description?.trim();
  if (description) pursuit.description = description;

  const steps = def.setData?.itemList ?? [];
  const step = steps.findIndex((s) => s.itemHash === c.itemHash);
  if (step >= 0 && steps.length > 1) {
    const questline = defs.item(def.objectives?.questlineItemHash);
    pursuit.questline = {
      name: def.setData?.questLineName || questline?.displayProperties.name || pursuit.name,
      step: step + 1,
      totalSteps: steps.length,
      summary: def.setData?.questStepSummary || undefined,
    };
  }
  return pursuit;
}
