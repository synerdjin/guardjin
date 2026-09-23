import type { DestinyPublicMilestone } from 'bungie-api-ts/destiny2';
import type { Defs } from '../manifest/defs.js';

export interface WeeklyMilestone {
  name: string;
  description?: string;
  starts?: string;
  ends?: string;
  activities: { name: string; modifiers: string[]; challenges: string[] }[];
  /** Vendor names attached to this milestone. */
  vendors: string[];
}

interface Named {
  displayProperties?: { name?: string; description?: string };
}

const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))];
const name = (d: Named | undefined) => d?.displayProperties?.name?.trim() ?? '';

/** Turns the public milestone list into named, currently-relevant weekly/daily content. */
export function buildWeekly(milestones: Record<number, DestinyPublicMilestone>, defs: Defs): WeeklyMilestone[] {
  return Object.values(milestones)
    .sort((a, b) => a.order - b.order)
    .flatMap((m): WeeklyMilestone[] => {
      const def = defs.milestone(m.milestoneHash);
      const milestoneName = name(def) || name(defs.item(m.availableQuests[0]?.questItemHash));
      const activities = (m.activities ?? [])
        .map((a) => ({
          name: name(defs.activity(a.activityHash)),
          modifiers: unique((a.modifierHashes ?? []).map((h) => name(defs.get<Named>('DestinyActivityModifierDefinition', h)))),
          challenges: unique((a.challengeObjectiveHashes ?? []).map((h) => defs.objective(h)?.progressDescription?.trim() ?? '')),
        }))
        .filter((a) => a.name);
      const vendors = (m.vendorHashes ?? []).map((h) => name(defs.vendor(h))).filter(Boolean);
      if (!milestoneName || (!activities.length && !vendors.length)) return [];
      return [
        {
          name: milestoneName,
          description: def?.displayProperties?.description?.trim() || undefined,
          starts: m.startDate,
          ends: m.endDate,
          activities,
          vendors,
        },
      ];
    });
}
