import type {
  DestinyCharacterComponent,
  DestinyInventoryItemDefinition,
  DestinyItemComponent,
  DestinyItemInstanceComponent,
  DestinyItemPlugBase,
  DestinyItemSocketState,
  DestinyProfileResponse,
} from 'bungie-api-ts/destiny2';
import type { Defs } from '../manifest/defs.js';
import {
  ARMOR_STATS,
  ARMOR_STAT_INDEX,
  Buckets,
  ClassNames,
  ItemStateFlags,
  ItemType,
  Rarity,
  SocketCategories,
  type ClassName,
} from './constants.js';

export type StatVector = number[]; // indexed like ARMOR_STATS

export interface Plug {
  hash: number;
  name: string;
}

export interface PerkColumn {
  socketIndex: number;
  equipped: Plug;
  /** Every perk that can be selected in this column (includes `equipped`). */
  options: Plug[];
}

export type ItemLocation =
  | { type: 'vault' }
  | { type: 'character'; characterId: string }
  | { type: 'postmaster'; characterId: string }
  | { type: 'profile' };

export interface ArmorDetails {
  archetype?: string;
  set?: { hash: number; name: string };
  /** Exotic armor perk, or other intrinsic perk. */
  intrinsic?: Plug;
  /** Rolled stats (no mods, no masterwork, no tuning), when the item exposes them. */
  base: StatVector;
  /** Current stats with armor mods removed (includes masterwork and tuning). */
  noMods: StatVector;
  /** Stats as they would be once fully masterworked, without mods. */
  masterworked: StatVector;
  /** Armor from before Armor 3.0 (no archetype/stat plugs). */
  legacy: boolean;
  tuning?: Plug;
  mods: Plug[];
  energy?: { capacity: number; used: number };
}

export interface WeaponDetails {
  element?: string;
  ammo?: 'primary' | 'special' | 'heavy';
  intrinsic?: Plug;
  perks: PerkColumn[];
  masterwork?: Plug;
  mod?: Plug;
}

export interface Item {
  instanceId?: string;
  hash: number;
  name: string;
  typeName: string;
  itemType: number;
  kind: 'weapon' | 'armor' | 'subclass' | 'ghost' | 'other';
  /** Slot/bucket name, e.g. "Helmet", "Energy Weapons". */
  slot: string;
  bucketHash: number;
  classType: ClassName;
  rarity: string;
  isExotic: boolean;
  gearTier?: number;
  power?: number;
  quantity: number;
  location: ItemLocation;
  equipped: boolean;
  locked: boolean;
  lockable: boolean;
  masterworked: boolean;
  crafted: boolean;
  transferable: boolean;
  /** Live stats keyed by stat name. */
  stats: Record<string, number>;
  armor?: ArmorDetails;
  weapon?: WeaponDetails;
}

export interface Character {
  id: string;
  classType: ClassName;
  className: string;
  race?: string;
  light: number;
  lastPlayed: string;
}

export interface InventoryModel {
  characters: Character[];
  items: Item[];
  byId: Map<string, Item>;
  raw: DestinyProfileResponse;
}

/** The character used for actions on an item: its holder, or the most recently played one for vault items. */
export function actingCharacter(inv: Pick<InventoryModel, 'characters'>, item: Item): string | undefined {
  return item.location.type === 'character' || item.location.type === 'postmaster' ? item.location.characterId : inv.characters[0]?.id;
}

export function className(classType: number): ClassName {
  return ClassNames[classType] ?? 'any';
}

export function locationLabel(loc: ItemLocation, characters: Character[]): string {
  const char = (id: string) => characters.find((c) => c.id === id)?.className ?? id;
  switch (loc.type) {
    case 'vault':
      return 'vault';
    case 'character':
      return char(loc.characterId);
    case 'postmaster':
      return `postmaster (${char(loc.characterId)})`;
    default:
      return 'account';
  }
}

/** Characters from a GetProfile response, most recently played first. */
export function buildCharacters(profile: DestinyProfileResponse, defs: Defs): Character[] {
  return Object.values(profile.characters?.data ?? {})
    .sort((a, b) => b.dateLastPlayed.localeCompare(a.dateLastPlayed))
    .map((c: DestinyCharacterComponent) => ({
      id: c.characterId,
      classType: className(c.classType),
      className: defs.characterClass(c.classHash)?.displayProperties.name ?? className(c.classType),
      race: defs.get<{ displayProperties: { name: string } }>('DestinyRaceDefinition', c.raceHash)?.displayProperties.name,
      light: c.light,
      lastPlayed: c.dateLastPlayed,
    }));
}

/** Turns a raw GetProfile response into a flat, name-resolved inventory. */
export function buildInventory(profile: DestinyProfileResponse, defs: Defs): InventoryModel {
  const characters = buildCharacters(profile, defs);
  const items: Item[] = [];
  const add = (component: DestinyItemComponent, location: ItemLocation, equipped: boolean) => {
    const item = buildItem(component, location, equipped, profile, defs);
    if (item) items.push(item);
  };

  for (const c of profile.profileInventory?.data?.items ?? []) {
    add(c, c.bucketHash === Buckets.Vault ? { type: 'vault' } : { type: 'profile' }, false);
  }
  for (const [characterId, inv] of Object.entries(profile.characterInventories?.data ?? {})) {
    for (const c of inv.items) {
      add(c, c.bucketHash === Buckets.Postmaster ? { type: 'postmaster', characterId } : { type: 'character', characterId }, false);
    }
  }
  for (const [characterId, inv] of Object.entries(profile.characterEquipment?.data ?? {})) {
    for (const c of inv.items) add(c, { type: 'character', characterId }, true);
  }

  const byId = new Map<string, Item>();
  for (const it of items) if (it.instanceId) byId.set(it.instanceId, it);
  return { characters, items, byId, raw: profile };
}

export function buildItem(
  c: DestinyItemComponent,
  location: ItemLocation,
  equipped: boolean,
  profile: DestinyProfileResponse,
  defs: Defs,
): Item | undefined {
  const def = defs.item(c.itemHash);
  if (!def) return undefined;
  const id = c.itemInstanceId;
  const instance = id ? profile.itemComponents?.instances?.data?.[id] : undefined;
  const liveStats = id ? profile.itemComponents?.stats?.data?.[id]?.stats : undefined;
  const sockets = id ? profile.itemComponents?.sockets?.data?.[id]?.sockets : undefined;
  const reusable = id ? profile.itemComponents?.reusablePlugs?.data?.[id]?.plugs : undefined;

  const kind: Item['kind'] =
    def.itemType === ItemType.Weapon
      ? 'weapon'
      : def.itemType === ItemType.Armor
        ? 'armor'
        : def.itemType === ItemType.Subclass
          ? 'subclass'
          : def.itemType === ItemType.Ghost
            ? 'ghost'
            : 'other';
  const tierType = def.inventory?.tierType ?? 0;

  const stats: Record<string, number> = {};
  for (const s of Object.values(liveStats ?? {})) {
    const name = defs.stat(s.statHash)?.displayProperties.name;
    if (name) stats[name] = s.value;
  }

  const item: Item = {
    instanceId: id,
    hash: c.itemHash,
    name: def.displayProperties.name,
    typeName: def.itemTypeDisplayName,
    itemType: def.itemType,
    kind,
    slot: defs.bucket(def.inventory?.bucketTypeHash)?.displayProperties.name ?? 'Unknown',
    bucketHash: def.inventory?.bucketTypeHash ?? 0,
    classType: className(def.classType),
    rarity: Rarity[tierType] ?? 'unknown',
    isExotic: tierType === 6,
    gearTier: instance?.gearTier || undefined,
    power: instance?.primaryStat?.value,
    quantity: c.quantity,
    location,
    equipped,
    locked: (c.state & ItemStateFlags.Locked) !== 0,
    lockable: c.lockable,
    masterworked: (c.state & ItemStateFlags.Masterwork) !== 0,
    crafted: (c.state & ItemStateFlags.Crafted) !== 0,
    // TransferStatuses: 0 = can transfer; 1 = equipped; 2 = not transferable; 4 = no room
    transferable: !def.nonTransferrable && (c.transferStatus & 2) === 0,
    stats,
  };

  if (kind === 'armor') item.armor = buildArmor(def, sockets ?? [], liveStats ?? {}, instance, defs);
  if (kind === 'weapon') item.weapon = buildWeapon(def, sockets ?? [], reusable ?? {}, instance, defs);
  return item;
}

function plug(defs: Defs, hash: number): Plug {
  return { hash, name: defs.item(hash)?.displayProperties.name || `#${hash}` };
}

function emptyVector(): StatVector {
  return ARMOR_STATS.map(() => 0);
}

/** Indexes of the three lowest values (ties resolved in stat order). */
export function threeLowest(v: StatVector): number[] {
  return v
    .map((value, i) => ({ value, i }))
    .sort((a, b) => a.value - b.value || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.i);
}

interface InvestmentStat {
  statTypeHash: number;
  value: number;
  isConditionallyActive: boolean;
}

/** Adds a plug's armor-stat investment to `target`. Conditional stats apply to the three lowest base stats. */
function applyInvestment(target: StatVector, stats: InvestmentStat[] | undefined, base: StatVector, sign = 1): void {
  const lowest = threeLowest(base);
  for (const s of stats ?? []) {
    const i = ARMOR_STAT_INDEX.get(s.statTypeHash);
    if (i === undefined) continue;
    if (s.isConditionallyActive && !lowest.includes(i)) continue;
    target[i] += sign * s.value;
  }
}

function buildArmor(
  def: DestinyInventoryItemDefinition,
  sockets: DestinyItemSocketState[],
  liveStats: Record<string, { statHash: number; value: number }>,
  instance: DestinyItemInstanceComponent | undefined,
  defs: Defs,
): ArmorDetails {
  const base = emptyVector();
  const live = emptyVector();
  for (const s of Object.values(liveStats)) {
    const i = ARMOR_STAT_INDEX.get(s.statHash);
    if (i !== undefined) live[i] = s.value;
  }

  let archetype: string | undefined;
  let intrinsic: Plug | undefined;
  let tuning: Plug | undefined;
  let hasStatPlugs = false;
  const mods: Plug[] = [];
  const modPlugs: DestinyInventoryItemDefinition[] = [];
  let tuningPlug: DestinyInventoryItemDefinition | undefined;

  for (const socket of sockets) {
    if (!socket.plugHash) continue;
    const p = defs.item(socket.plugHash);
    const cat = p?.plug?.plugCategoryIdentifier ?? '';
    if (!p) continue;
    if (cat === 'armor_stats') {
      hasStatPlugs = true;
      for (const s of p.investmentStats ?? []) {
        const i = ARMOR_STAT_INDEX.get(s.statTypeHash);
        if (i !== undefined && !s.isConditionallyActive) base[i] += s.value;
      }
    } else if (cat === 'armor_archetypes') {
      archetype = p.displayProperties.name;
    } else if (cat.includes('tuning')) {
      tuningPlug = p;
      if (!p.displayProperties.name.startsWith('Empty')) tuning = plug(defs, p.hash);
    } else if (cat.startsWith('enhancements.')) {
      modPlugs.push(p);
      if (!p.displayProperties.name.startsWith('Empty')) mods.push(plug(defs, p.hash));
    } else if (cat === 'intrinsics' && p.displayProperties.name) {
      intrinsic = plug(defs, p.hash);
    }
  }

  // Current stats with armor mods stripped (live data is the source of truth).
  const noMods = [...live];
  for (const m of modPlugs) applyInvestment(noMods, m.investmentStats, hasStatPlugs ? base : live, -1);

  let masterworked: StatVector;
  if (hasStatPlugs) {
    // Armor 3.0: a full masterwork adds +5 to the three lowest rolled stats.
    masterworked = [...base];
    if (tuningPlug) applyInvestment(masterworked, tuningPlug.investmentStats, base);
    for (const i of threeLowest(base)) masterworked[i] += 5;
  } else {
    // Legacy armor has no stat-roll plugs, so the mod-free live stats are the best base available.
    masterworked = [...noMods];
    for (let i = 0; i < base.length; i++) base[i] = noMods[i];
  }

  const setHash = def.equippingBlock?.equipableItemSetHash;
  const setDef = setHash ? defs.itemSet(setHash) : undefined;
  const energy = instance?.energy;

  return {
    archetype,
    set: setDef ? { hash: setDef.hash, name: setDef.displayProperties.name } : undefined,
    intrinsic,
    base,
    noMods,
    masterworked,
    legacy: !hasStatPlugs,
    tuning,
    mods,
    energy: energy ? { capacity: energy.energyCapacity, used: energy.energyUsed } : undefined,
  };
}

function buildWeapon(
  def: DestinyInventoryItemDefinition,
  sockets: DestinyItemSocketState[],
  reusable: Record<number, DestinyItemPlugBase[]>,
  instance: DestinyItemInstanceComponent | undefined,
  defs: Defs,
): WeaponDetails {
  const categories = def.sockets?.socketCategories ?? [];
  const indexesOf = (hash: number) => categories.find((c) => c.socketCategoryHash === hash)?.socketIndexes ?? [];

  const perks: PerkColumn[] = [];
  for (const socketIndex of indexesOf(SocketCategories.WeaponPerks)) {
    const s = sockets[socketIndex];
    if (!s?.plugHash || !s.isVisible) continue;
    const p = defs.item(s.plugHash);
    const cat = p?.plug?.plugCategoryIdentifier ?? '';
    if (!p || cat.includes('trackers') || cat.includes('shader')) continue;
    const optionHashes = (reusable[socketIndex] ?? []).map((r) => r.plugItemHash);
    if (!optionHashes.includes(s.plugHash)) optionHashes.unshift(s.plugHash);
    perks.push({ socketIndex, equipped: plug(defs, s.plugHash), options: optionHashes.map((h) => plug(defs, h)) });
  }

  const firstPlug = (hash: number) => {
    for (const i of indexesOf(hash)) {
      const h = sockets[i]?.plugHash;
      if (h) return h;
    }
    return undefined;
  };
  const intrinsicHash = firstPlug(SocketCategories.WeaponIntrinsic);

  let masterwork: Plug | undefined;
  let mod: Plug | undefined;
  for (const i of indexesOf(SocketCategories.WeaponMods)) {
    const h = sockets[i]?.plugHash;
    const p = h ? defs.item(h) : undefined;
    if (!p || !h) continue;
    const cat = p.plug?.plugCategoryIdentifier ?? '';
    if (cat.includes('masterworks')) masterwork = plug(defs, h);
    else if (!cat.includes('mod_empty') && !p.displayProperties.name.startsWith('Empty')) mod = plug(defs, h);
  }

  const ammoType = def.equippingBlock?.ammoType;
  return {
    element: defs.damageType(instance?.damageTypeHash ?? def.defaultDamageTypeHash)?.displayProperties.name,
    ammo: ammoType === 1 ? 'primary' : ammoType === 2 ? 'special' : ammoType === 3 ? 'heavy' : undefined,
    intrinsic: intrinsicHash ? plug(defs, intrinsicHash) : undefined,
    perks,
    masterwork,
    mod,
  };
}

/** Maps a stat vector to { statName: value } using manifest names. */
export function namedStats(v: StatVector, defs: Defs): Record<string, number> {
  const out: Record<string, number> = {};
  ARMOR_STATS.forEach((s, i) => {
    out[defs.stat(s.hash)?.displayProperties.name ?? s.key] = v[i];
  });
  return out;
}

export function statTotal(v: StatVector): number {
  return v.reduce((a, b) => a + b, 0);
}
