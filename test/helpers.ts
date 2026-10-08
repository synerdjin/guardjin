import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ARMOR_STATS, Buckets } from '../src/inventory/constants.js';
import type { InventoryModel, Item, ItemLocation } from '../src/inventory/model.js';
import { buildItemIndex, Defs } from '../src/manifest/defs.js';

let cached: Defs | undefined;

const TABLES = [
  'DestinyInventoryItemDefinition', 'DestinyStatDefinition', 'DestinyInventoryBucketDefinition',
  'DestinyEquipableItemSetDefinition', 'DestinySandboxPerkDefinition', 'DestinyDamageTypeDefinition',
  'DestinyClassDefinition', 'DestinySocketCategoryDefinition', 'DestinyPlugSetDefinition', 'DestinyRaceDefinition',
  'DestinyObjectiveDefinition', 'DestinyActivityDefinition', 'DestinyDestinationDefinition',
  'DestinyMilestoneDefinition', 'DestinyVendorDefinition', 'DestinyCollectibleDefinition', 'DestinyRecordDefinition',
  'DestinyLoadoutNameDefinition', 'DestinyActivityModifierDefinition', 'DestinySocketTypeDefinition', 'DestinyLoadoutConstantsDefinition',
  'DestinyProgressionDefinition', 'DestinyFactionDefinition', 'DestinySeasonDefinition', 'DestinySeasonPassDefinition',
  'DestinyPresentationNodeDefinition', 'DestinySocialCommendationDefinition', 'DestinySocialCommendationNodeDefinition', 'DestinyActivityModeDefinition', 'DestinyActivityTypeDefinition',
];

/** Definitions from `{ table: { hash: def } }`, loaded into an in-memory SQLite DB shaped like Bungie's. */
export function defsFrom(data: Record<string, Record<string, unknown>>, version = 'fixture'): Defs {
  const db = new DatabaseSync(':memory:');
  for (const table of TABLES) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY NOT NULL, json BLOB)`);
    const insert = db.prepare(`INSERT INTO ${table} (id, json) VALUES (?, ?)`);
    for (const [hash, def] of Object.entries(data[table] ?? {})) insert.run(Number(hash) | 0, JSON.stringify(def));
  }
  buildItemIndex(db);
  return new Defs(db, version);
}

/** Adds each definition's own hash to it, as the manifest does. */
export const withHashes = (table: Record<number, object>) => Object.fromEntries(Object.entries(table).map(([hash, def]) => [hash, { hash: Number(hash), ...def }]));

/** A plug definition in a plug category such as hunter.void.aspects. */
export const plugDef = (name: string, plugCategoryIdentifier: string, plugCategoryHash?: number) => ({
  displayProperties: { name, description: '' },
  plug: { plugCategoryIdentifier, plugCategoryHash },
});

/** Real manifest definitions (a small extract) loaded into an in-memory SQLite DB shaped like Bungie's. */
export function fixtureDefs(): Defs {
  cached ??= defsFrom(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'manifest.json'), 'utf8')) as Record<string, Record<string, unknown>>);
  return cached;
}

/** The New Demotic Cover helmet in the fixture manifest and plugs that fit it. Sockets: 0 general mod, 1-3 head mods, 4 shader, 5 masterwork. */
export const helmetFixture = {
  HELMET: 2214884208,
  EMPTY_GENERAL: 1980618587,
  EMPTY_HEAD: 1078080765,
  DEFAULT_SHADER: 4248210736,
  UPGRADE_ARMOR: 788990507,
  GRENADE_MOD: 3896141096, // cost 1
  MINOR_GRENADE_MOD: 4021790309,
  ASHES_TO_ASSETS: 856936828, // cost 3
  HEAVY_AMMO_FINDER: 644105, // cost 1
  GENERAL_SET: 731468111,
  HEAD_SET: 2037229815,
} as const;

/** Socket states as the profile reports them, one visible and enabled socket per plug hash. */
export const socketStates = (plugs: number[]) => plugs.map((plugHash) => ({ plugHash, isEnabled: true, isVisible: true }));

export const WARLOCK = 'c-warlock';
export const HUNTER = 'c-hunter';

export const characters: InventoryModel['characters'] = [
  { id: WARLOCK, classType: 'warlock', className: 'Warlock', light: 450, lastPlayed: '2026-09-20T00:00:00Z' },
  { id: HUNTER, classType: 'hunter', className: 'Hunter', light: 440, lastPlayed: '2026-09-10T00:00:00Z' },
];

let nextId = 1;

/** Builds a normalized Item for analysis/action tests. `stats` are the masterworked armor stats. */
export function makeItem(p: Partial<Item> & { stats6?: number[]; set?: { hash: number; name: string } }): Item {
  const id = p.instanceId ?? String(nextId++);
  const kind = p.kind ?? 'armor';
  const item: Item = {
    instanceId: id,
    hash: p.hash ?? 1000,
    name: p.name ?? `Item ${id}`,
    typeName: p.typeName ?? (kind === 'weapon' ? 'Hand Cannon' : 'Helmet'),
    itemType: kind === 'weapon' ? 3 : 2,
    kind,
    slot: p.slot ?? (kind === 'weapon' ? 'Kinetic Weapons' : 'Helmet'),
    bucketHash: p.bucketHash ?? (kind === 'weapon' ? Buckets.Kinetic : Buckets.Helmet),
    classType: p.classType ?? (kind === 'weapon' ? 'any' : 'warlock'),
    rarity: p.isExotic ? 'exotic' : 'legendary',
    isExotic: p.isExotic ?? false,
    gearTier: p.gearTier,
    power: p.power ?? 450,
    quantity: 1,
    location: p.location ?? ({ type: 'vault' } as ItemLocation),
    equipped: p.equipped ?? false,
    locked: p.locked ?? false,
    lockable: true,
    masterworked: p.masterworked ?? true,
    crafted: false,
    transferable: p.transferable ?? true,
    stats: {},
    weapon: p.weapon,
  };
  if (kind === 'armor') {
    const s = p.stats6 ?? ARMOR_STATS.map(() => 10);
    item.armor = { base: [...s], noMods: [...s], masterworked: [...s], legacy: false, mods: [], set: p.set, archetype: 'Paragon' };
  }
  return item;
}

export function makeInventory(items: Item[]): InventoryModel {
  const byId = new Map<string, Item>();
  for (const it of items) if (it.instanceId) byId.set(it.instanceId, it);
  return { characters, items, byId, raw: {} as InventoryModel['raw'] };
}
