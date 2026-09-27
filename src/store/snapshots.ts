import { DatabaseSync } from 'node:sqlite';
import type { InventoryModel, Item } from '../inventory/model.js';
import { locationLabel } from '../inventory/model.js';

/** A full snapshot is written at most this often (or when asked); first/last-seen is tracked on every read. */
export const SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;

const MIGRATIONS = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE items_seen (
     instance_id TEXT PRIMARY KEY, hash INTEGER NOT NULL, name TEXT, kind TEXT,
     first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, gone_at INTEGER,
     baseline INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, taken_at INTEGER NOT NULL, manifest_version TEXT);
   CREATE TABLE snapshot_items (
     snapshot_id INTEGER NOT NULL, instance_id TEXT NOT NULL, hash INTEGER NOT NULL, name TEXT, kind TEXT, slot TEXT,
     tier INTEGER, power INTEGER, locked INTEGER, masterworked INTEGER, location TEXT, perks TEXT, stats TEXT,
     PRIMARY KEY (snapshot_id, instance_id)
   );
   CREATE TABLE snapshot_characters (snapshot_id INTEGER NOT NULL, character_id TEXT NOT NULL, class_name TEXT, light INTEGER, PRIMARY KEY (snapshot_id, character_id));
   CREATE TABLE snapshot_currencies (snapshot_id INTEGER NOT NULL, name TEXT NOT NULL, quantity INTEGER, PRIMARY KEY (snapshot_id, name));`,
];

export interface SeenItem {
  instanceId: string;
  hash: number;
  name: string;
  kind: string;
  firstSeenAt: number;
  lastSeenAt: number;
  goneAt?: number;
  /** Already owned when tracking started, so firstSeenAt is not the acquisition time. */
  baseline: boolean;
}

export interface SnapshotItem {
  instanceId: string;
  hash: number;
  name: string;
  kind: string;
  slot: string;
  tier?: number;
  power?: number;
  locked: boolean;
  masterworked: boolean;
  location: string;
}

export interface SnapshotInfo {
  id: number;
  takenAt: number;
}

const tracked = (i: Item) => !!i.instanceId && (i.kind === 'weapon' || i.kind === 'armor');

/**
 * Local history of the account in ~/.guardjin/guardjin.db. Bungie's API only shows the present, so
 * this is what lets guardjin answer "what's new since Tuesday" or "what did I dismantle".
 */
export class SnapshotStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    while (version < MIGRATIONS.length) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[version]);
        version++;
        this.db.prepare('UPDATE schema_version SET version = ?').run(version);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** When tracking started (the first inventory read with this store). */
  trackingSince(): number | undefined {
    const v = this.getMeta('tracking_since');
    return v ? Number(v) : undefined;
  }

  /**
   * Updates first/last-seen for every weapon and armor piece, and marks items that are gone. The
   * first call records everything as baseline, since their acquisition time is unknown.
   */
  observe(inv: InventoryModel, now = Date.now()): void {
    const baseline = this.trackingSince() === undefined;
    const items = inv.items.filter(tracked);
    if (!items.length) return; // an empty read is more likely an API hiccup than a dismantled vault
    const upsert = this.db.prepare(
      `INSERT INTO items_seen (instance_id, hash, name, kind, first_seen_at, last_seen_at, baseline) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, gone_at = NULL`,
    );
    this.db.exec('BEGIN');
    try {
      for (const i of items) upsert.run(i.instanceId!, i.hash, i.name, i.kind, now, now, baseline ? 1 : 0);
      this.db.prepare('UPDATE items_seen SET gone_at = ? WHERE gone_at IS NULL AND last_seen_at < ?').run(now, now);
      if (baseline) this.setMeta('tracking_since', String(now));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  lastSnapshot(): SnapshotInfo | undefined {
    const row = this.db.prepare('SELECT id, taken_at FROM snapshots ORDER BY taken_at DESC LIMIT 1').get() as { id: number; taken_at: number } | undefined;
    return row ? { id: row.id, takenAt: row.taken_at } : undefined;
  }

  /** The latest snapshot taken at or before `at`, else the earliest one. */
  snapshotAt(at: number): SnapshotInfo | undefined {
    const row = (this.db.prepare('SELECT id, taken_at FROM snapshots WHERE taken_at <= ? ORDER BY taken_at DESC LIMIT 1').get(at) ??
      this.db.prepare('SELECT id, taken_at FROM snapshots ORDER BY taken_at ASC LIMIT 1').get()) as { id: number; taken_at: number } | undefined;
    return row ? { id: row.id, takenAt: row.taken_at } : undefined;
  }

  snapshots(limit = 50): SnapshotInfo[] {
    return (this.db.prepare('SELECT id, taken_at FROM snapshots ORDER BY taken_at DESC LIMIT ?').all(limit) as { id: number; taken_at: number }[]).map((r) => ({ id: r.id, takenAt: r.taken_at }));
  }

  /** Writes a full snapshot if the last one is older than the interval (or `force`). Returns its id. */
  maybeSnapshot(
    inv: InventoryModel,
    opts: { manifestVersion?: string; currencies?: { name: string; quantity: number }[]; force?: boolean; now?: number } = {},
  ): number | undefined {
    const now = opts.now ?? Date.now();
    const last = this.lastSnapshot();
    if (!opts.force && last && now - last.takenAt < SNAPSHOT_INTERVAL_MS) return undefined;
    this.db.exec('BEGIN');
    try {
      const { lastInsertRowid } = this.db.prepare('INSERT INTO snapshots (taken_at, manifest_version) VALUES (?, ?)').run(now, opts.manifestVersion ?? null);
      const id = Number(lastInsertRowid);
      const insert = this.db.prepare(
        `INSERT INTO snapshot_items (snapshot_id, instance_id, hash, name, kind, slot, tier, power, locked, masterworked, location, perks, stats)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const i of inv.items.filter(tracked)) {
        const perks = i.weapon?.perks.map((p) => p.equipped.name) ?? i.armor?.mods.map((m) => m.name) ?? [];
        insert.run(
          id, i.instanceId!, i.hash, i.name, i.kind, i.slot, i.gearTier ?? null, i.power ?? null, i.locked ? 1 : 0, i.masterworked ? 1 : 0,
          locationLabel(i.location, inv.characters), JSON.stringify(perks), i.armor ? JSON.stringify(i.armor.masterworked) : null,
        );
      }
      const character = this.db.prepare('INSERT INTO snapshot_characters (snapshot_id, character_id, class_name, light) VALUES (?, ?, ?, ?)');
      for (const c of inv.characters) character.run(id, c.id, c.className, c.light);
      const currency = this.db.prepare('INSERT OR REPLACE INTO snapshot_currencies (snapshot_id, name, quantity) VALUES (?, ?, ?)');
      for (const c of opts.currencies ?? []) currency.run(id, c.name, c.quantity);
      this.db.exec('COMMIT');
      return id;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  snapshotItems(snapshotId: number): Map<string, SnapshotItem> {
    const rows = this.db.prepare('SELECT * FROM snapshot_items WHERE snapshot_id = ?').all(snapshotId) as Record<string, unknown>[];
    return new Map(
      rows.map((r) => [
        r.instance_id as string,
        {
          instanceId: r.instance_id as string,
          hash: r.hash as number,
          name: r.name as string,
          kind: r.kind as string,
          slot: r.slot as string,
          tier: (r.tier as number | null) ?? undefined,
          power: (r.power as number | null) ?? undefined,
          locked: r.locked === 1,
          masterworked: r.masterworked === 1,
          location: r.location as string,
        },
      ]),
    );
  }

  snapshotCharacters(snapshotId: number): { characterId: string; className: string; light: number }[] {
    return (this.db.prepare('SELECT character_id, class_name, light FROM snapshot_characters WHERE snapshot_id = ?').all(snapshotId) as Record<string, unknown>[]).map((r) => ({
      characterId: r.character_id as string,
      className: r.class_name as string,
      light: r.light as number,
    }));
  }

  snapshotCurrencies(snapshotId: number): Map<string, number> {
    const rows = this.db.prepare('SELECT name, quantity FROM snapshot_currencies WHERE snapshot_id = ?').all(snapshotId) as { name: string; quantity: number }[];
    return new Map(rows.map((r) => [r.name, r.quantity]));
  }

  seen(instanceIds?: string[]): Map<string, SeenItem> {
    const rows = (instanceIds
      ? instanceIds.length
        ? this.db.prepare(`SELECT * FROM items_seen WHERE instance_id IN (${instanceIds.map(() => '?').join(',')})`).all(...instanceIds)
        : []
      : this.db.prepare('SELECT * FROM items_seen').all()) as Record<string, unknown>[];
    return new Map(rows.map((r) => [r.instance_id as string, toSeen(r)]));
  }

  /** Items first seen after `since` (excluding the baseline), and items that went missing after it. */
  changesSince(since: number): { added: SeenItem[]; gone: SeenItem[] } {
    const added = (this.db.prepare('SELECT * FROM items_seen WHERE baseline = 0 AND first_seen_at > ? ORDER BY first_seen_at DESC').all(since) as Record<string, unknown>[]).map(toSeen);
    const gone = (this.db.prepare('SELECT * FROM items_seen WHERE gone_at IS NOT NULL AND gone_at > ? ORDER BY gone_at DESC').all(since) as Record<string, unknown>[]).map(toSeen);
    return { added, gone };
  }

  close(): void {
    this.db.close();
  }
}

function toSeen(r: Record<string, unknown>): SeenItem {
  return {
    instanceId: r.instance_id as string,
    hash: r.hash as number,
    name: r.name as string,
    kind: r.kind as string,
    firstSeenAt: r.first_seen_at as number,
    lastSeenAt: r.last_seen_at as number,
    goneAt: (r.gone_at as number | null) ?? undefined,
    baseline: r.baseline === 1,
  };
}

/** Instance ids grow over time, so comparing them orders items by when they dropped. */
export function newerThan(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}
