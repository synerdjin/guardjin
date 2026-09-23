import type { DestinyInventoryItemDefinition } from 'bungie-api-ts/destiny2';
import type { Defs } from '../manifest/defs.js';
import { ARMOR_STAT_INDEX, ARMOR_STATS } from './constants.js';
import type { InventoryModel, Item } from './model.js';

export interface SubclassPlug {
  hash: number;
  name: string;
  description: string;
  /** Armor-stat changes the plug grants (e.g. fragments with +10 Grenade). */
  statBonuses?: Record<string, number>;
}

export interface SubclassSection {
  /** Socket category name as shown in game: SUPER, ABILITIES, ASPECTS, FRAGMENTS, ... */
  category: string;
  equipped: SubclassPlug[];
  /** Unlocked options for this category (only when requested). */
  available?: SubclassPlug[];
}

export interface SubclassSummary {
  instanceId?: string;
  hash: number;
  name: string;
  element?: string;
  characterId: string;
  equipped: boolean;
  sections: SubclassSection[];
}

function toSubclassPlug(def: DestinyInventoryItemDefinition, defs: Defs): SubclassPlug {
  const statBonuses: Record<string, number> = {};
  for (const s of def.investmentStats ?? []) {
    if (s.isConditionallyActive || !s.value || !ARMOR_STAT_INDEX.has(s.statTypeHash)) continue;
    const name = defs.stat(s.statTypeHash)?.displayProperties.name ?? String(s.statTypeHash);
    statBonuses[name] = (statBonuses[name] ?? 0) + s.value;
  }
  return {
    hash: def.hash,
    name: def.displayProperties.name,
    description: defs.describePlug(def),
    statBonuses: Object.keys(statBonuses).length ? statBonuses : undefined,
  };
}

const isEmptyPlug = (def: DestinyInventoryItemDefinition | undefined) =>
  !def || !def.displayProperties.name || def.displayProperties.name.startsWith('Empty ');

/** Describes a subclass item: equipped super/abilities/aspects/fragments and, optionally, every unlocked option. */
export function describeSubclass(item: Item, inv: InventoryModel, defs: Defs, includeOptions: boolean): SubclassSummary {
  const def = defs.item(item.hash);
  const raw = inv.raw;
  const characterId = item.location.type === 'character' || item.location.type === 'postmaster' ? item.location.characterId : '';
  const sockets = item.instanceId ? raw.itemComponents?.sockets?.data?.[item.instanceId]?.sockets ?? [] : [];
  const reusable = item.instanceId ? raw.itemComponents?.reusablePlugs?.data?.[item.instanceId]?.plugs ?? {} : {};
  const profilePlugSets = raw.profilePlugSets?.data?.plugs ?? {};
  const characterPlugSets = raw.characterPlugSets?.data?.[characterId]?.plugs ?? {};

  const sections: SubclassSection[] = [];
  for (const cat of def?.sockets?.socketCategories ?? []) {
    const category = defs.socketCategory(cat.socketCategoryHash)?.displayProperties.name || String(cat.socketCategoryHash);
    const equipped: SubclassPlug[] = [];
    const available = new Map<number, SubclassPlug>();
    for (const socketIndex of cat.socketIndexes) {
      const plugHash = sockets[socketIndex]?.plugHash;
      const plugDef = plugHash ? defs.item(plugHash) : undefined;
      if (plugDef && !isEmptyPlug(plugDef)) equipped.push(toSubclassPlug(plugDef, defs));

      if (!includeOptions) continue;
      const entry = def?.sockets?.socketEntries[socketIndex];
      const candidates: number[] = [];
      for (const r of reusable[socketIndex] ?? []) if (r.canInsert || r.enabled) candidates.push(r.plugItemHash);
      const plugSetHash = entry?.reusablePlugSetHash || entry?.randomizedPlugSetHash;
      if (plugSetHash) {
        const owned = characterPlugSets[plugSetHash] ?? profilePlugSets[plugSetHash];
        if (owned) {
          for (const p of owned) if (p.canInsert && p.enabled) candidates.push(p.plugItemHash);
        } else if (!candidates.length) {
          for (const p of defs.plugSet(plugSetHash)?.reusablePlugItems ?? []) candidates.push(p.plugItemHash);
        }
      }
      for (const h of candidates) {
        if (available.has(h)) continue;
        const d = defs.item(h);
        if (!isEmptyPlug(d)) available.set(h, toSubclassPlug(d!, defs));
      }
    }
    if (!equipped.length && !available.size) continue;
    sections.push({ category, equipped, available: includeOptions ? [...available.values()] : undefined });
  }

  return {
    instanceId: item.instanceId,
    hash: item.hash,
    name: item.name,
    element: def?.talentGrid?.hudDamageType !== undefined ? elementName(def.talentGrid.hudDamageType) : undefined,
    characterId,
    equipped: item.equipped,
    sections,
  };
}

function elementName(damageType: number): string | undefined {
  return ({ 1: 'Kinetic/Prismatic', 2: 'Arc', 3: 'Solar', 4: 'Void', 6: 'Stasis', 7: 'Strand' } as Record<number, string>)[damageType];
}

/** Sum of armor-stat bonuses from the equipped subclass's fragments/aspects, indexed like ARMOR_STATS. */
export function subclassStatBonus(summary: SubclassSummary | undefined, defs: Defs): number[] {
  const bonus = ARMOR_STATS.map(() => 0);
  if (!summary) return bonus;
  for (const section of summary.sections) {
    for (const p of section.equipped) {
      const d = defs.item(p.hash);
      for (const s of d?.investmentStats ?? []) {
        const i = ARMOR_STAT_INDEX.get(s.statTypeHash);
        if (i !== undefined && !s.isConditionallyActive) bonus[i] += s.value;
      }
    }
  }
  return bonus;
}
