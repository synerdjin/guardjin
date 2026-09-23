import type { DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import type { Defs } from '../manifest/defs.js';

export interface Craftable {
  /** The weapon this pattern crafts. */
  name: string;
  type?: string;
  /** Every requirement is met on at least one character. */
  unlocked: boolean;
  /** Why it can't be crafted, when it can't. */
  reasons: string[];
}

/**
 * Weapon patterns and whether each can be crafted. Needs the Craftables component. A pattern
 * counts as unlocked if any character can craft it.
 */
export function buildCraftables(profile: DestinyProfileResponse, defs: Defs): Craftable[] {
  const best = new Map<number, Craftable>();
  for (const component of Object.values(profile.characterCraftables?.data ?? {})) {
    for (const [hashText, c] of Object.entries(component.craftables ?? {})) {
      if (!c.visible) continue;
      const hash = Number(hashText);
      const recipe = defs.item(hash);
      const output = defs.item(recipe?.crafting?.outputItemHash) ?? recipe;
      const name = output?.displayProperties.name;
      if (!name) continue;
      const unlocked = c.failedRequirementIndexes.length === 0;
      const previous = best.get(hash);
      if (previous?.unlocked && !unlocked) continue;
      best.set(hash, {
        name,
        type: output?.itemTypeDisplayName || undefined,
        unlocked,
        reasons: c.failedRequirementIndexes.map((i) => recipe?.crafting?.failedRequirementStrings?.[i] ?? `requirement ${i}`),
      });
    }
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}
