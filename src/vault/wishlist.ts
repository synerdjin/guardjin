import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { WISHLIST_ANY_ITEM } from '../inventory/constants.js';
import type { Item } from '../inventory/model.js';
import type { Defs } from '../manifest/defs.js';

export interface WishlistEntry {
  perks: number[];
  trash: boolean;
  notes?: string;
}

export interface Wishlist {
  title?: string;
  /** Entries keyed by (positive) item hash; WISHLIST_ANY_ITEM applies to every item. */
  entries: Map<number, WishlistEntry[]>;
  size: number;
}

export type Verdict = 'wishlist' | 'trash' | 'not-on-wishlist' | 'unknown';

export interface WishlistResult {
  verdict: Verdict;
  /** Perk names from the best matching entry. */
  matchedPerks?: string[];
  notes?: string[];
}

const REFRESH_MS = 24 * 60 * 60 * 1000;

/** Parses the DIM wishlist text format (as used by voltron.txt). */
export function parseWishlist(text: string): Wishlist {
  const entries = new Map<number, WishlistEntry[]>();
  const interned = new Map<string, string>();
  const intern = (s: string) => {
    const hit = interned.get(s);
    if (hit) return hit;
    interned.set(s, s);
    return s;
  };
  let title: string | undefined;
  let blockNotes: string | undefined;
  let size = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      blockNotes = undefined;
      continue;
    }
    if (line.startsWith('title:')) {
      title = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('//notes:')) {
      blockNotes = intern(line.slice(8).trim());
      continue;
    }
    if (!line.startsWith('dimwishlist:')) continue;

    const body = line.slice('dimwishlist:'.length);
    const hashIdx = body.indexOf('#notes:');
    const query = hashIdx >= 0 ? body.slice(0, hashIdx) : body;
    const inlineNotes = hashIdx >= 0 ? body.slice(hashIdx + 7).trim() : undefined;
    const params = new URLSearchParams(query);
    const itemRaw = Number(params.get('item'));
    if (!Number.isFinite(itemRaw) || itemRaw === 0) continue;
    const perks = (params.get('perks') ?? '')
      .split(',')
      .map((p) => Number(p.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    const trash = itemRaw < 0 && itemRaw !== WISHLIST_ANY_ITEM;
    const key = itemRaw === WISHLIST_ANY_ITEM ? WISHLIST_ANY_ITEM : Math.abs(itemRaw);
    const notes = inlineNotes ? intern(inlineNotes) : blockNotes;
    const list = entries.get(key);
    const entry: WishlistEntry = { perks, trash, notes };
    if (list) list.push(entry);
    else entries.set(key, [entry]);
    size++;
  }
  return { title, entries, size };
}

const normalizePerkName = (name: string) => name.toLowerCase().replace(/^enhanced\s+/, '').replace(/\s+enhanced$/, '').trim();

/** Evaluates a weapon roll against the wishlist. Perks are compared by name so enhanced variants match. */
export function evaluateRoll(item: Item, wishlist: Wishlist, defs: Defs): WishlistResult {
  if (!item.weapon) return { verdict: 'unknown' };
  const entries = [...(wishlist.entries.get(item.hash) ?? []), ...(wishlist.entries.get(WISHLIST_ANY_ITEM) ?? [])];
  if (!entries.length) return { verdict: 'unknown' };

  const available = new Set<string>();
  for (const col of item.weapon.perks) for (const o of col.options) available.add(normalizePerkName(o.name));
  if (item.weapon.intrinsic) available.add(normalizePerkName(item.weapon.intrinsic.name));
  if (item.weapon.masterwork) available.add(normalizePerkName(item.weapon.masterwork.name));

  const perkName = (h: number) => defs.item(h)?.displayProperties.name ?? `#${h}`;
  let bestGood: WishlistEntry | undefined;
  let bestTrash: WishlistEntry | undefined;
  const goodNotes = new Set<string>();
  const trashNotes = new Set<string>();
  for (const e of entries) {
    const matches = e.perks.every((h) => available.has(normalizePerkName(perkName(h))));
    if (!matches) continue;
    if (e.trash) {
      if (!bestTrash || e.perks.length > bestTrash.perks.length) bestTrash = e;
      if (e.notes) trashNotes.add(e.notes);
    } else {
      if (!bestGood || e.perks.length > bestGood.perks.length) bestGood = e;
      if (e.notes) goodNotes.add(e.notes);
    }
  }
  const cap = (s: Set<string>) => [...s].slice(0, 3).map((n) => (n.length > 400 ? `${n.slice(0, 400)}…` : n));
  if (bestGood) return { verdict: 'wishlist', matchedPerks: bestGood.perks.map(perkName), notes: cap(goodNotes) };
  if (bestTrash) return { verdict: 'trash', matchedPerks: bestTrash.perks.map(perkName), notes: cap(trashNotes) };
  return { verdict: 'not-on-wishlist' };
}

/** Downloads, caches (24h) and parses the configured wishlist. */
export class WishlistService {
  private loaded: Promise<Wishlist> | undefined;
  private readonly dir: string;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.dir = join(config.homeDir, 'wishlist');
  }

  get(forceRefresh = false): Promise<Wishlist> {
    if (forceRefresh) this.loaded = undefined;
    this.loaded ??= this.load(forceRefresh).catch((err) => {
      this.loaded = undefined;
      throw err;
    });
    return this.loaded;
  }

  private async load(forceRefresh: boolean): Promise<Wishlist> {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, 'wishlist.txt');
    const metaFile = join(this.dir, 'meta.json');
    const meta = existsSync(metaFile)
      ? (JSON.parse(readFileSync(metaFile, 'utf8')) as { url: string; fetchedAt: number })
      : undefined;
    const fresh = meta && meta.url === this.config.wishlistUrl && Date.now() - meta.fetchedAt < REFRESH_MS && existsSync(file);
    if (!fresh || forceRefresh) {
      try {
        const res = await this.fetchImpl(this.config.wishlistUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        writeFileSync(file, await res.text());
        writeFileSync(metaFile, JSON.stringify({ url: this.config.wishlistUrl, fetchedAt: Date.now() }));
      } catch (err) {
        if (!existsSync(file)) throw new Error(`Could not download wishlist from ${this.config.wishlistUrl}: ${(err as Error).message}`);
        console.error(`[guardjin] wishlist refresh failed (${(err as Error).message}); using cached copy`);
      }
    }
    return parseWishlist(readFileSync(file, 'utf8'));
  }
}
