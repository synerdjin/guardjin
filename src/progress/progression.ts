import type { DestinyObjectiveProgress, DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import type { Defs } from '../manifest/defs.js';

export interface ProgressionEntry {
  name: string;
  level: number;
  /** Maximum level; absent when the progression is uncapped. */
  levelCap?: number;
  /** Progress within the current level, e.g. "340/1000". */
  toNext?: string;
  weekly?: string;
  daily?: string;
}

export interface MilestoneEntry {
  name: string;
  description?: string;
  ends?: string;
  /** Every tracked quest step is done. */
  completed?: boolean;
  quests: { name: string; completed: boolean; objectives: { description: string; progress: string; complete?: boolean }[] }[];
}

export interface ProgressionSummary {
  guardianRank?: { current: number; lifetimeHighest: number; renewed: number };
  season?: { name: string; number: number; ends?: string; powerCap?: number };
  seasonPass?: { level: number; toNext?: string; prestigeLevel?: number };
  artifact?: { name?: string; powerBonus: number; pointsUnlocked: number; level?: number };
  factions: ProgressionEntry[];
  milestones: MilestoneEntry[];
}

const label = (p: { progressToNextLevel: number; nextLevelAt: number }): string | undefined => (p.nextLevelAt ? `${p.progressToNextLevel}/${p.nextLevelAt}` : undefined);
const capped = (progress: number, limit: number): string | undefined => (limit > 0 ? `${progress}/${limit}` : undefined);

function objectives(list: DestinyObjectiveProgress[] | undefined, defs: Defs) {
  return (list ?? [])
    .filter((o) => o.visible !== false)
    .map((o) => ({
      description: (defs.objective(o.objectiveHash)?.progressDescription ?? '').trim(),
      progress: `${o.progress ?? 0}/${o.completionValue}`,
      ...(o.complete ? { complete: true } : {}),
    }));
}

/**
 * Season, Guardian Rank, faction ranks and milestone progress for one character. Needs Profiles,
 * ProfileProgression and CharacterProgressions.
 */
export function buildProgression(profile: DestinyProfileResponse, defs: Defs, characterId: string): ProgressionSummary {
  const prof = profile.profile?.data;
  const character = profile.characterProgressions?.data?.[characterId];
  const out: ProgressionSummary = { factions: [], milestones: [] };

  if (prof) {
    out.guardianRank = { current: prof.currentGuardianRank, lifetimeHighest: prof.lifetimeHighestGuardianRank, renewed: prof.renewedGuardianRank };
    const season = defs.season(prof.currentSeasonHash);
    if (season) {
      out.season = { name: season.displayProperties.name, number: season.seasonNumber, ends: season.endDate, powerCap: prof.currentSeasonRewardPowerCap };
    }
    const pass = defs.seasonPass(prof.currentSeasonPassHash);
    const reward = pass && character?.progressions?.[pass.rewardProgressionHash];
    if (reward) {
      out.seasonPass = {
        level: reward.level,
        toNext: label(reward),
        prestigeLevel: character?.progressions?.[pass.prestigeProgressionHash]?.level || undefined,
      };
    }
  }

  const artifact = profile.profileProgression?.data?.seasonalArtifact;
  if (artifact) {
    out.artifact = {
      name: defs.item(artifact.artifactHash)?.displayProperties.name,
      powerBonus: artifact.powerBonus,
      pointsUnlocked: artifact.pointsAcquired,
      level: artifact.powerBonusProgression?.level,
    };
  }

  for (const f of Object.values(character?.factions ?? {})) {
    const name = defs.faction(f.factionHash)?.displayProperties.name || defs.progression(f.progressionHash)?.displayProperties.name;
    if (!name || (!f.level && !f.currentProgress)) continue;
    out.factions.push({ name, level: f.level, levelCap: f.levelCap > 0 ? f.levelCap : undefined, toNext: label(f), weekly: capped(f.weeklyProgress, f.weeklyLimit), daily: capped(f.dailyProgress, f.dailyLimit) });
  }
  out.factions.sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));

  for (const m of Object.values(character?.milestones ?? {})) {
    const def = defs.milestone(m.milestoneHash);
    const quests = (m.availableQuests ?? []).map((q) => ({
      name: defs.item(q.questItemHash)?.displayProperties.name || def?.displayProperties?.name || '',
      completed: q.status.completed,
      objectives: objectives(q.status.stepObjectives, defs),
    }));
    const name = def?.displayProperties?.name?.trim() || quests[0]?.name;
    if (!name || !quests.length) continue;
    out.milestones.push({
      name,
      description: def?.displayProperties?.description?.trim() || undefined,
      ends: m.endDate,
      completed: quests.every((q) => q.completed) || undefined,
      quests,
    });
  }
  out.milestones.sort((a, b) => Number(!!a.completed) - Number(!!b.completed) || a.name.localeCompare(b.name));
  return out;
}
