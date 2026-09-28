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
  /** The section and block this entry came from, e.g. "PvE Podcast 174 - The Best Machine Guns › Hammerhead - PvE Boss god 1". */
  source?: string;
}

export interface Wishlist {
  /** The file's own title (its first `title:` line). */
  title?: string;
  /** Entries keyed by (positive) item hash; WISHLIST_ANY_ITEM applies to every item. */
  entries: Map<number, WishlistEntry[]>;
  size: number;
}

export type Verdict = 'wishlist' | 'trash' | 'not-on-wishlist' | 'unknown';

export interface WishlistNote {
  source?: string;
  note: string;
}

export interface WishlistResult {
  verdict: Verdict;
  /** Perk names from the best matching entry. */
  matchedPerks?: string[];
  /** Notes from the best-matching entries first. */
  notes?: WishlistNote[];
  /** Set when a note was cut short. */
  truncated?: boolean;
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
  let section: string | undefined;
  let header: string | undefined;
  let source: string | undefined;
  let blockNotes: string | undefined;
  let blockStart = true;
  let size = 0;
  const setSource = () => {
    const parts = [section, header].filter(Boolean);
    source = parts.length ? intern(parts.join(' › ')) : undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      blockNotes = undefined;
      blockStart = true;
      continue;
    }
    const startsBlock = blockStart;
    blockStart = false;
    if (line.startsWith('title:')) {
      // The first title names the whole file; later ones start a new section (voltron concatenates many lists).
      if (title === undefined) title = line.slice(6).trim();
      else {
        section = line.slice(6).trim();
        header = undefined;
        setSource();
      }
      continue;
    }
    if (line.startsWith('//notes:')) {
      blockNotes = intern(line.slice(8).trim());
      continue;
    }
    if (line.startsWith('//')) {
      // The first comment of a block names it ("// Hammerhead - PvE Boss god 1"); later ones list perks.
      if (startsBlock) {
        header = line.slice(2).trim() || undefined;
        setSource();
      }
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
    const entry: WishlistEntry = { perks, trash, notes, source };
    if (list) list.push(entry);
    else entries.set(key, [entry]);
    size++;
  }
  return { title, entries, size };
}

const normalizePerkName = (name: string) => name.toLowerCase().replace(/^enhanced\s+/, '').replace(/\s+enhanced$/, '').trim();

const MAX_NOTES = 3;
const NOTE_LIMIT = 1200;

/**
 * Evaluates a weapon roll against the wishlist. Perks are compared by name so enhanced variants match.
 * Notes come from the entries that match the most equipped perks first; `fullNotes` lifts the length cap.
 */
export function evaluateRoll(item: Item, wishlist: Wishlist, defs: Defs, opts: { fullNotes?: boolean } = {}): WishlistResult {
  if (!item.weapon) return { verdict: 'unknown' };
  const entries = [...(wishlist.entries.get(item.hash) ?? []), ...(wishlist.entries.get(WISHLIST_ANY_ITEM) ?? [])];
  if (!entries.length) return { verdict: 'unknown' };

  const available = new Set<string>();
  const equipped = new Set<string>();
  for (const col of item.weapon.perks) {
    for (const o of col.options) available.add(normalizePerkName(o.name));
    equipped.add(normalizePerkName(col.equipped.name));
  }
  for (const p of [item.weapon.intrinsic, item.weapon.masterwork]) {
    if (!p) continue;
    available.add(normalizePerkName(p.name));
    equipped.add(normalizePerkName(p.name));
  }

  const perkName = (h: number) => defs.item(h)?.displayProperties.name ?? `#${h}`;
  const good: { entry: WishlistEntry; equipped: number }[] = [];
  const trash: { entry: WishlistEntry; equipped: number }[] = [];
  for (const e of entries) {
    const names = e.perks.map((h) => normalizePerkName(perkName(h)));
    if (!names.every((n) => available.has(n))) continue;
    (e.trash ? trash : good).push({ entry: e, equipped: names.filter((n) => equipped.has(n)).length });
  }

  const summarize = (verdict: Verdict, matches: { entry: WishlistEntry; equipped: number }[]): WishlistResult => {
    // Best match first: most equipped perks, then the most specific entry. Stable, so file order breaks ties.
    const ranked = [...matches].sort((a, b) => b.equipped - a.equipped || b.entry.perks.length - a.entry.perks.length);
    const best = matches.reduce((a, b) => (b.entry.perks.length > a.entry.perks.length ? b : a));
    const seen = new Set<string>();
    const notes: WishlistNote[] = [];
    let truncated = false;
    for (const { entry } of ranked) {
      if (!entry.notes || seen.has(entry.notes)) continue;
      seen.add(entry.notes);
      if (notes.length >= MAX_NOTES) {
        truncated = true;
        break;
      }
      const cut = !opts.fullNotes && entry.notes.length > NOTE_LIMIT;
      if (cut) truncated = true;
      notes.push({ source: entry.source, note: cut ? `${entry.notes.slice(0, NOTE_LIMIT)}…` : entry.notes });
    }
    return { verdict, matchedPerks: best.entry.perks.map(perkName), notes, truncated: truncated || undefined };
  };
  if (good.length) return summarize('wishlist', good);
  if (trash.length) return summarize('trash', trash);
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
