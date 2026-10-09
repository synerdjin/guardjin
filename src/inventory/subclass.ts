import type { DestinyInventoryItemDefinition } from 'bungie-api-ts/destiny2';
import { UserError } from '../errors.js';
import type { Defs } from '../manifest/defs.js';
import { matchByName, normName } from '../names.js';
import type { PlugOwnership } from '../world/subclassVendors.js';
import { ARMOR_STAT_INDEX, ARMOR_STATS } from './constants.js';
import { actingCharacter, namedStats, type InventoryModel, type Item } from './model.js';

/** Stat on an aspect that grants fragment slots (2 or 3). */
export const FRAGMENT_CAPACITY_STAT = 2223994109;

/** How many fragment slots an aspect opens, or undefined for any other plug. */
export const fragmentCapacity = (def: DestinyInventoryItemDefinition | undefined) =>
  def?.investmentStats?.find((s) => s.statTypeHash === FRAGMENT_CAPACITY_STAT)?.value || undefined;

/** Plug categories of aspects and fragments (Stasis calls them "totems" and "trinkets"), e.g. hunter.void.aspects, shared.prism.fragments. */
export const SUBCLASS_STAT_PLUG = /\.(aspects|totems|fragments|trinkets)$/;

/** Aspect and fragment plug categories a socket type accepts (e.g. hunter.void.aspects). */
export function acceptedCategories(defs: Defs, socketTypeHash: number | undefined): string[] {
  return (defs.socketType(socketTypeHash)?.plugWhitelist ?? []).map((w) => w.categoryIdentifier).filter((c) => SUBCLASS_STAT_PLUG.test(c));
}

/** Which of Weapons, Health and Class (ARMOR_STATS indexes 0-2) is each class's class-ability stat. */
const CLASS_ABILITY_STAT: Record<string, number> = { hunter: 0, titan: 1, warlock: 2 };

/**
 * Armor-stat change a subclass plug (aspect or fragment) grants, indexed like ARMOR_STATS.
 * Fragments mark most of their stats as conditionally active in the manifest, but they always apply,
 * so those count. The exception is a plug whose conditional entries give the same change to Weapons,
 * Health and Class (Echo of Persistence, Spark of Focus): only the stat of the character's class
 * applies, and all three are kept when the class is unknown.
 */
export function plugStatBonus(def: DestinyInventoryItemDefinition | undefined, classType: string): number[] {
  const always = ARMOR_STATS.map(() => 0);
  const conditional = ARMOR_STATS.map(() => 0);
  for (const s of def?.investmentStats ?? []) {
    const i = ARMOR_STAT_INDEX.get(s.statTypeHash);
    if (i !== undefined && s.value) (s.isConditionallyActive ? conditional : always)[i] += s.value;
  }
  const [weapons, health, cls] = conditional;
  const own = CLASS_ABILITY_STAT[classType];
  if (weapons !== 0 && weapons === health && health === cls && own !== undefined) for (const i of [0, 1, 2]) if (i !== own) conditional[i] = 0;
  return always.map((v, i) => v + conditional[i]);
}

/**
 * Named stat changes of an aspect or fragment for display. Without a known class, a plug whose
 * change depends on the class (Echo of Persistence) is shown per class instead of as one list.
 */
export function subclassPlugStats(
  def: DestinyInventoryItemDefinition,
  defs: Defs,
  classType?: string,
): { stats?: Record<string, number>; statsByClass?: Record<string, Record<string, number>> } {
  const named = (cls: string) => Object.fromEntries(Object.entries(namedStats(plugStatBonus(def, cls), defs)).filter(([, v]) => v));
  if (classType && classType in CLASS_ABILITY_STAT) {
    const stats = named(classType);
    return Object.keys(stats).length ? { stats } : {};
  }
  const perClass = Object.fromEntries(Object.keys(CLASS_ABILITY_STAT).map((c) => [c, named(c)]));
  const variants = new Set(Object.values(perClass).map((v) => JSON.stringify(v)));
  if (variants.size > 1) return { statsByClass: perClass };
  const stats = named('');
  return Object.keys(stats).length ? { stats } : {};
}

export interface SubclassPlug extends Partial<PlugOwnership> {
  hash: number;
  name: string;
  description: string;
  /** Armor-stat changes the plug grants (e.g. fragments with +10 Grenade). */
  statBonuses?: Record<string, number>;
  /** Aspects: how many fragment slots this aspect opens. */
  fragmentSlots?: number;
}

export interface SubclassSection {
  /** Socket category name as shown in game: SUPER, ABILITIES, ASPECTS, FRAGMENTS, ... */
  category: string;
  equipped: SubclassPlug[];
  /** Options for this category (only when requested); `owned` says which of them are unlocked when known. */
  available?: SubclassPlug[];
  /** Aspects/fragments with ownership requested: how many options are owned, e.g. "12/16" or "3/3 (1 unknown)", or "unknown" when the vendor check gave nothing. */
  owned?: string;
}

export interface SubclassSummary {
  instanceId?: string;
  hash: number;
  name: string;
  element?: string;
  characterId: string;
  equipped: boolean;
  sections: SubclassSection[];
  /** Set when ownership was requested but couldn't be determined for this subclass's aspects and fragments. */
  ownershipNote?: string;
}

function toSubclassPlug(def: DestinyInventoryItemDefinition, defs: Defs, classType: string, ownership?: Map<number, PlugOwnership>): SubclassPlug {
  return {
    hash: def.hash,
    name: def.displayProperties.name,
    description: defs.describePlug(def),
    statBonuses: subclassPlugStats(def, defs, classType).stats,
    fragmentSlots: fragmentCapacity(def),
    ...ownership?.get(def.hash),
  };
}

/** No plug, or an "Empty …" placeholder. */
export const isEmptyPlug = (def: DestinyInventoryItemDefinition | undefined) =>
  !def || !def.displayProperties.name || def.displayProperties.name.startsWith('Empty ');

/**
 * Describes a subclass item: equipped super/abilities/aspects/fragments and, optionally, every unlocked
 * option (all categories, or only the listed ones, e.g. ["ASPECTS", "FRAGMENTS"]).
 * With `ownership` (see subclassOwnership), aspects and fragments say whether they are owned, and
 * the aspects and fragments the vendors sell are listed as options even when the profile omits them:
 * Bungie's plug sets list every fragment as insertable and leave most aspects out.
 */
export function describeSubclass(
  item: Item,
  inv: InventoryModel,
  defs: Defs,
  includeOptions: boolean | string[],
  ownership?: Map<number, PlugOwnership>,
): SubclassSummary {
  const def = defs.item(item.hash);
  const raw = inv.raw;
  const characterId = actingCharacter(inv, item) ?? '';
  const sockets = item.instanceId ? raw.itemComponents?.sockets?.data?.[item.instanceId]?.sockets ?? [] : [];
  const reusable = item.instanceId ? raw.itemComponents?.reusablePlugs?.data?.[item.instanceId]?.plugs ?? {} : {};
  const profilePlugSets = raw.profilePlugSets?.data?.plugs ?? {};
  const characterPlugSets = raw.characterPlugSets?.data?.[characterId]?.plugs ?? {};

  const ownedByCategory = new Map<string, number[]>();
  for (const hash of ownership?.keys() ?? []) {
    const category = defs.item(hash)?.plug?.plugCategoryIdentifier;
    if (category) ownedByCategory.set(category, [...(ownedByCategory.get(category) ?? []), hash]);
  }

  const sections: SubclassSection[] = [];
  let plugSections = 0;
  let unknownSections = 0;
  for (const cat of def?.sockets?.socketCategories ?? []) {
    const category = defs.socketCategory(cat.socketCategoryHash)?.displayProperties.name || String(cat.socketCategoryHash);
    const equipped: SubclassPlug[] = [];
    const available = new Map<number, SubclassPlug>();
    const withOptions = Array.isArray(includeOptions) ? includeOptions.includes(category.toUpperCase()) : includeOptions;
    for (const socketIndex of cat.socketIndexes) {
      const plugHash = sockets[socketIndex]?.plugHash;
      const plugDef = plugHash ? defs.item(plugHash) : undefined;
      if (plugDef && !isEmptyPlug(plugDef)) equipped.push(toSubclassPlug(plugDef, defs, item.classType, ownership));

      if (!withOptions) continue;
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
      for (const category of acceptedCategories(defs, entry?.socketTypeHash)) candidates.push(...(ownedByCategory.get(category) ?? []));
      for (const h of candidates) {
        if (available.has(h)) continue;
        const d = defs.item(h);
        if (!isEmptyPlug(d)) available.set(h, toSubclassPlug(d!, defs, item.classType, ownership));
      }
    }
    if (!equipped.length && !available.size) continue;
    const options = withOptions ? [...available.values()] : undefined;
    const plugOptions = ownership && options?.some((p) => SUBCLASS_STAT_PLUG.test(defs.item(p.hash)?.plug?.plugCategoryIdentifier ?? ''));
    const owned = plugOptions ? (ownedCount(options) ?? 'unknown') : undefined;
    if (owned === 'unknown') unknownSections++;
    if (plugOptions) plugSections++;
    sections.push({ category, equipped, available: options, owned });
  }

  return {
    instanceId: item.instanceId,
    hash: item.hash,
    name: item.name,
    element: def?.talentGrid?.hudDamageType !== undefined ? elementName(def.talentGrid.hudDamageType) : undefined,
    characterId,
    equipped: item.equipped,
    sections,
    ownershipNote:
      plugSections > 0 && unknownSections === plugSections
        ? "ownership unknown for this subclass (no vendor sells its aspects and fragments, or the vendor check failed); options come from profile data and may include ones you haven't unlocked"
        : undefined,
  };
}

/** "owned/known" over options whose ownership is known, noting any the vendors don't list; undefined when none is known. */
function ownedCount(options: SubclassPlug[] | undefined): string | undefined {
  const known = options?.filter((p) => p.owned !== undefined) ?? [];
  if (!known.length) return undefined;
  const unknown = options!.length - known.length;
  return `${known.filter((p) => p.owned).length}/${known.length}${unknown ? ` (${unknown} unknown)` : ''}`;
}

function elementName(damageType: number): string | undefined {
  return ({ 1: 'Kinetic/Prismatic', 2: 'Arc', 3: 'Solar', 4: 'Void', 6: 'Stasis', 7: 'Strand' } as Record<number, string>)[damageType];
}

/** Every plug in a category (ASPECTS, FRAGMENTS, ...), equipped or listed as available. */
export function sectionPlugs(summary: Pick<SubclassSummary, 'sections'>, category: string, which: 'equipped' | 'available'): SubclassPlug[] {
  return summary.sections.filter((s) => s.category.toUpperCase() === category).flatMap((s) => s[which] ?? []);
}

/**
 * The character's subclass whose name or element contains `query` ("Nightstalker", "Void", "Prismatic"),
 * preferring the equipped one; without a query, the equipped subclass.
 */
export function findSubclass(inv: InventoryModel, defs: Defs, characterId: string, query?: string): Item | undefined {
  const mine = characterSubclasses(inv, defs, characterId, query);
  return mine.find((i) => i.equipped) ?? (query?.trim() ? mine[0] : undefined);
}

/** The character's subclasses, optionally only those whose name or element contains `query`. */
export function characterSubclasses(inv: InventoryModel, defs: Defs, characterId: string, query?: string): Item[] {
  const mine = inv.items.filter((i) => i.kind === 'subclass' && i.location.type === 'character' && i.location.characterId === characterId);
  if (!query?.trim()) return mine;
  const q = normName(query);
  const element = (i: Item) => {
    const damageType = defs.item(i.hash)?.talentGrid?.hudDamageType;
    return damageType !== undefined ? normName(elementName(damageType) ?? '') : '';
  };
  return mine.filter((i) => normName(i.name).includes(q) || element(i).includes(q));
}

/** Fragments vs the slots the aspects open (available is undefined when none of the aspects says). */
export function fragmentSlotUse(aspects: Pick<SubclassPlug, 'fragmentSlots'>[], fragments: unknown[]): { used: number; available?: number } {
  const unknown = aspects.length > 0 && aspects.every((a) => a.fragmentSlots === undefined);
  return { used: fragments.length, available: unknown ? undefined : aspects.reduce((sum, a) => sum + (a.fragmentSlots ?? 0), 0) };
}

export interface PlannedSubclassSetup {
  aspects: SubclassPlug[];
  fragments: SubclassPlug[];
  /** Armor-stat bonus of the aspects and fragments, indexed like ARMOR_STATS. */
  bonus: number[];
  /** Fragments vs the slots the aspects open (available is undefined when none of the aspects says). */
  fragmentSlots: { used: number; available?: number };
  /** Chosen aspects and fragments the character has not bought yet, or that the vendor doesn't offer yet (needs ownership in the summary). */
  unowned?: { name: string; price?: string; locked?: string }[];
  warning?: string;
}

/** Finds one named plug in a deduplicated pool; exact name first, then a unique substring. */
function pickNamed(pool: SubclassPlug[], name: string, kind: string): SubclassPlug {
  const hits = matchByName(pool, (p) => p.name, name);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new UserError(`"${name}" matches several ${kind}s: ${hits.map((p) => p.name).join(', ')}`);
  const words = normName(name).split(/\s+/).filter((w) => w.length > 2 && w !== 'of' && w !== 'the');
  const close = pool.filter((p) => words.some((w) => normName(p.name).includes(w))).map((p) => p.name);
  throw new UserError(`This subclass has no ${kind} "${name}"${close.length ? `. Close: ${close.slice(0, 8).join(', ')}` : ''}`);
}

/**
 * The aspects and fragments a build would use: the named ones (resolved against the subclass's
 * equipped and unlocked options) or, for a list that is not given, the equipped ones.
 */
export function planSubclassSetup(
  summary: SubclassSummary,
  defs: Defs,
  classType: string,
  wanted: { aspects?: string[]; fragments?: string[] } = {},
): PlannedSubclassSetup {
  const resolve = (category: 'ASPECTS' | 'FRAGMENTS', names: string[] | undefined): SubclassPlug[] => {
    const equipped = sectionPlugs(summary, category, 'equipped');
    if (!names) return equipped;
    const pool = [...new Map([...equipped, ...sectionPlugs(summary, category, 'available')].map((p) => [p.hash, p])).values()];
    const picked = names.map((n) => pickNamed(pool, n, category.slice(0, -1).toLowerCase()));
    return [...new Set(picked)];
  };
  const aspects = resolve('ASPECTS', wanted.aspects);
  const fragments = resolve('FRAGMENTS', wanted.fragments);

  const bonus = ARMOR_STATS.map(() => 0);
  for (const p of [...aspects, ...fragments]) plugStatBonus(defs.item(p.hash), classType).forEach((v, i) => (bonus[i] += v));
  const { used, available } = fragmentSlotUse(aspects, fragments);
  const unowned = [...aspects, ...fragments].filter((p) => p.owned === false || p.locked).map((p) => ({ name: p.name, price: p.price, locked: p.locked }));
  return {
    aspects,
    fragments,
    bonus,
    fragmentSlots: { used, available },
    unowned: unowned.length ? unowned : undefined,
    warning:
      available !== undefined && used > available
        ? `${used} fragments need ${used} slots but the aspects open ${available}; ${available ? `drop ${used - available} or change aspects` : 'pick aspects that open fragment slots'}`
        : undefined,
  };
}
