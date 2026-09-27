import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  DestinyActivityDefinition,
  DestinyActivityModeDefinition,
  DestinySocialCommendationNodeDefinition,
  DestinySocialCommendationDefinition,
  DestinySeasonPassDefinition,
  DestinySeasonDefinition,
  DestinyProgressionDefinition,
  DestinyPresentationNodeDefinition,
  DestinyFactionDefinition,
  DestinyClassDefinition,
  DestinyCollectibleDefinition,
  DestinyDamageTypeDefinition,
  DestinyDestinationDefinition,
  DestinyEquipableItemSetDefinition,
  DestinyInventoryBucketDefinition,
  DestinyInventoryItemDefinition,
  DestinyLoadoutConstantsDefinition,
  DestinyLoadoutNameDefinition,
  DestinyMilestoneDefinition,
  DestinyObjectiveDefinition,
  DestinyPlugSetDefinition,
  DestinyRecordDefinition,
  DestinySandboxPerkDefinition,
  DestinySocketCategoryDefinition,
  DestinySocketTypeDefinition,
  DestinyStatDefinition,
  DestinyVendorDefinition,
} from 'bungie-api-ts/destiny2';

export const INDEX_TABLE = 'guardjin_item_index';

export interface ItemIndexRow {
  hash: number;
  name: string;
  typeName: string;
  itemType: number;
  tierType: number;
  classType: number;
}

const decoder = new TextDecoder();

/** Manifest tables store hashes as signed 32-bit ids. */
export function toSignedId(hash: number): number {
  return hash | 0;
}

/**
 * Read access to the Destiny world-content database. Rows are parsed lazily and memoized, so a
 * tool call only pays for the definitions it touches.
 */
export class Defs {
  private readonly cache = new Map<string, Map<number, unknown>>();
  private readonly statements = new Map<string, StatementSync>();

  constructor(
    readonly db: DatabaseSync,
    readonly version: string,
  ) {}

  get<T>(table: string, hash: number | undefined): T | undefined {
    if (hash === undefined || hash === null) return undefined;
    let tableCache = this.cache.get(table);
    if (!tableCache) {
      tableCache = new Map();
      this.cache.set(table, tableCache);
    }
    if (tableCache.has(hash)) return tableCache.get(hash) as T | undefined;
    let stmt = this.statements.get(table);
    if (!stmt) {
      stmt = this.db.prepare(`SELECT json FROM ${table} WHERE id = ?`);
      this.statements.set(table, stmt);
    }
    const row = stmt.get(toSignedId(hash)) as { json: string | Uint8Array } | undefined;
    const value = row ? (JSON.parse(typeof row.json === 'string' ? row.json : decoder.decode(row.json)) as T) : undefined;
    tableCache.set(hash, value);
    return value;
  }

  item(hash: number | undefined) {
    return this.get<DestinyInventoryItemDefinition>('DestinyInventoryItemDefinition', hash);
  }
  stat(hash: number | undefined) {
    return this.get<DestinyStatDefinition>('DestinyStatDefinition', hash);
  }
  sandboxPerk(hash: number | undefined) {
    return this.get<DestinySandboxPerkDefinition>('DestinySandboxPerkDefinition', hash);
  }
  plugSet(hash: number | undefined) {
    return this.get<DestinyPlugSetDefinition>('DestinyPlugSetDefinition', hash);
  }
  itemSet(hash: number | undefined) {
    return this.get<DestinyEquipableItemSetDefinition>('DestinyEquipableItemSetDefinition', hash);
  }
  bucket(hash: number | undefined) {
    return this.get<DestinyInventoryBucketDefinition>('DestinyInventoryBucketDefinition', hash);
  }
  damageType(hash: number | undefined) {
    return this.get<DestinyDamageTypeDefinition>('DestinyDamageTypeDefinition', hash);
  }
  characterClass(hash: number | undefined) {
    return this.get<DestinyClassDefinition>('DestinyClassDefinition', hash);
  }
  socketCategory(hash: number | undefined) {
    return this.get<DestinySocketCategoryDefinition>('DestinySocketCategoryDefinition', hash);
  }
  socketType(hash: number | undefined) {
    return this.get<DestinySocketTypeDefinition>('DestinySocketTypeDefinition', hash);
  }
  objective(hash: number | undefined) {
    return this.get<DestinyObjectiveDefinition>('DestinyObjectiveDefinition', hash);
  }
  activity(hash: number | undefined) {
    return this.get<DestinyActivityDefinition>('DestinyActivityDefinition', hash);
  }
  progression(hash: number | undefined) {
    return this.get<DestinyProgressionDefinition>('DestinyProgressionDefinition', hash);
  }
  faction(hash: number | undefined) {
    return this.get<DestinyFactionDefinition>('DestinyFactionDefinition', hash);
  }
  season(hash: number | undefined) {
    return this.get<DestinySeasonDefinition>('DestinySeasonDefinition', hash);
  }
  seasonPass(hash: number | undefined) {
    return this.get<DestinySeasonPassDefinition>('DestinySeasonPassDefinition', hash);
  }
  presentationNode(hash: number | undefined) {
    return this.get<DestinyPresentationNodeDefinition>('DestinyPresentationNodeDefinition', hash);
  }
  commendation(hash: number | undefined) {
    return this.get<DestinySocialCommendationDefinition>('DestinySocialCommendationDefinition', hash);
  }
  commendationNode(hash: number | undefined) {
    return this.get<DestinySocialCommendationNodeDefinition>('DestinySocialCommendationNodeDefinition', hash);
  }
  activityType(hash: number | undefined) {
    return this.get<{ displayProperties?: { name?: string } }>('DestinyActivityTypeDefinition', hash);
  }
  activityMode(hash: number | undefined) {
    return this.get<DestinyActivityModeDefinition>('DestinyActivityModeDefinition', hash);
  }
  milestone(hash: number | undefined) {
    return this.get<DestinyMilestoneDefinition>('DestinyMilestoneDefinition', hash);
  }
  vendor(hash: number | undefined) {
    return this.get<DestinyVendorDefinition>('DestinyVendorDefinition', hash);
  }
  collectible(hash: number | undefined) {
    return this.get<DestinyCollectibleDefinition>('DestinyCollectibleDefinition', hash);
  }
  record(hash: number | undefined) {
    return this.get<DestinyRecordDefinition>('DestinyRecordDefinition', hash);
  }
  loadoutName(hash: number | undefined) {
    return this.get<DestinyLoadoutNameDefinition>('DestinyLoadoutNameDefinition', hash);
  }
  /** The single row describing loadout slots and their preset names, icons and colors. */
  loadoutConstants(): DestinyLoadoutConstantsDefinition | undefined {
    const row = this.db.prepare('SELECT json FROM DestinyLoadoutConstantsDefinition LIMIT 1').get() as { json: string | Uint8Array } | undefined;
    return row ? (JSON.parse(typeof row.json === 'string' ? row.json : decoder.decode(row.json)) as DestinyLoadoutConstantsDefinition) : undefined;
  }
  destination(hash: number | undefined) {
    return this.get<DestinyDestinationDefinition>('DestinyDestinationDefinition', hash);
  }

  /** Human-readable description for a plug: its own description, else its displayable sandbox perks. */
  describePlug(def: DestinyInventoryItemDefinition | undefined): string {
    if (!def) return '';
    const own = def.displayProperties?.description?.trim();
    if (own) return own;
    const parts: string[] = [];
    for (const p of def.perks ?? []) {
      const perk = this.sandboxPerk(p.perkHash);
      const text = perk?.isDisplayable ? perk.displayProperties?.description?.trim() : undefined;
      if (text) parts.push(text);
    }
    return parts.join(' ');
  }

  /** Case-insensitive substring search over item names (items include perks, mods, aspects, fragments...). */
  searchItems(opts: { query: string; itemTypes?: number[]; classType?: number; limit?: number }): ItemIndexRow[] {
    const where = ['name_lower LIKE ?'];
    const args: (string | number)[] = [`%${opts.query.toLowerCase()}%`];
    if (opts.itemTypes?.length) {
      where.push(`item_type IN (${opts.itemTypes.map(() => '?').join(',')})`);
      args.push(...opts.itemTypes);
    }
    if (opts.classType !== undefined) {
      where.push('class_type IN (?, 3)');
      args.push(opts.classType);
    }
    // Exact matches first, then shorter names, then higher rarity.
    const rows = this.db
      .prepare(
        `SELECT hash, name, type_name AS typeName, item_type AS itemType, tier_type AS tierType, class_type AS classType
         FROM ${INDEX_TABLE} WHERE ${where.join(' AND ')}
         ORDER BY (name_lower = ?) DESC, length(name) ASC, tier_type DESC LIMIT ?`,
      )
      .all(...args, opts.query.toLowerCase(), opts.limit ?? 25) as unknown as ItemIndexRow[];
    return rows.map((r) => ({ ...r, hash: r.hash >>> 0 }));
  }

  /** Name search over a small definition table (e.g. armor sets, sandbox perks). */
  searchTable<T>(table: string, query: string, limit = 10): T[] {
    const rows = this.db
      .prepare(
        `SELECT json FROM ${table}
         WHERE lower(json_extract(CAST(json AS TEXT), '$.displayProperties.name')) LIKE ? LIMIT ?`,
      )
      .all(`%${query.toLowerCase()}%`, limit) as { json: string | Uint8Array }[];
    return rows.map((r) => JSON.parse(typeof r.json === 'string' ? r.json : decoder.decode(r.json)) as T);
  }
}

/** Creates the name index used by searchItems. Runs once per manifest version. */
export function buildItemIndex(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE IF EXISTS ${INDEX_TABLE};
    CREATE TABLE ${INDEX_TABLE} (
      hash INTEGER PRIMARY KEY, name TEXT, name_lower TEXT, type_name TEXT,
      item_type INTEGER, tier_type INTEGER, class_type INTEGER
    );
    INSERT INTO ${INDEX_TABLE}
      SELECT id, n, lower(n), t, it, tt, ct FROM (
        SELECT id,
          json_extract(j, '$.displayProperties.name') AS n,
          json_extract(j, '$.itemTypeDisplayName') AS t,
          json_extract(j, '$.itemType') AS it,
          json_extract(j, '$.inventory.tierType') AS tt,
          json_extract(j, '$.classType') AS ct,
          json_extract(j, '$.redacted') AS r
        FROM (SELECT id, CAST(json AS TEXT) AS j FROM DestinyInventoryItemDefinition)
      ) WHERE n IS NOT NULL AND n != '' AND (r IS NULL OR r = 0);
    CREATE INDEX ${INDEX_TABLE}_name ON ${INDEX_TABLE}(name_lower);
  `);
}
