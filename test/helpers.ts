import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ARMOR_STATS, Buckets } from '../src/inventory/constants.js';
import type { InventoryModel, Item, ItemLocation } from '../src/inventory/model.js';
import { buildItemIndex, Defs } from '../src/manifest/defs.js';

let cached: Defs | undefined;

/** Real manifest definitions (a small extract) loaded into an in-memory SQLite DB shaped like Bungie's. */
export function fixtureDefs(): Defs {
  if (cached) return cached;
  const data = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'manifest.json'), 'utf8')) as Record<string, Record<string, unknown>>;
  const db = new DatabaseSync(':memory:');
  for (const table of [
    'DestinyInventoryItemDefinition', 'DestinyStatDefinition', 'DestinyInventoryBucketDefinition',
    'DestinyEquipableItemSetDefinition', 'DestinySandboxPerkDefinition', 'DestinyDamageTypeDefinition',
    'DestinyClassDefinition', 'DestinySocketCategoryDefinition', 'DestinyPlugSetDefinition', 'DestinyRaceDefinition',
    'DestinyObjectiveDefinition', 'DestinyActivityDefinition', 'DestinyDestinationDefinition',
    'DestinyMilestoneDefinition', 'DestinyVendorDefinition', 'DestinyCollectibleDefinition', 'DestinyRecordDefinition',
    'DestinyLoadoutNameDefinition', 'DestinyActivityModifierDefinition', 'DestinySocketTypeDefinition', 'DestinyLoadoutConstantsDefinition',
  ]) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY NOT NULL, json BLOB)`);
    const insert = db.prepare(`INSERT INTO ${table} (id, json) VALUES (?, ?)`);
    for (const [hash, def] of Object.entries(data[table] ?? {})) insert.run(Number(hash) | 0, JSON.stringify(def));
  }
  buildItemIndex(db);
  cached = new Defs(db, 'fixture');
  return cached;
}

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
