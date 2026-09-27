import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';

const REFRESH_MS = 24 * 60 * 60 * 1000;
const DIM_ADDITIONAL_INFO = 'https://raw.githubusercontent.com/DestinyItemManager/d2-additional-info/master/output';

/** Community datasets guardjin can use; all are optional extras on top of Bungie's own data. */
export const DATASETS = {
  /** DIM: item hash → breaker type hash, for exotics whose champion ability isn't in the manifest. */
  extendedBreaker: `${DIM_ADDITIONAL_INFO}/extended-breaker.json`,
  /** DIM: collectible source hash → "Source: …" text. */
  sources: `${DIM_ADDITIONAL_INFO}/sources.json`,
} as const;
export type Dataset = keyof typeof DATASETS;

/**
 * Downloads small community JSON files and caches them in ~/.guardjin/community for a day.
 * Failures are not fatal: callers get the cached copy, or undefined if there is none.
 */
export class CommunityDataService {
  private readonly dir: string;
  private readonly loaded = new Map<Dataset, Promise<unknown>>();

  constructor(
    config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.dir = join(config.homeDir, 'community');
  }

  get<T>(name: Dataset): Promise<T | undefined> {
    let p = this.loaded.get(name);
    if (!p) {
      p = this.load(name);
      this.loaded.set(name, p);
    }
    return p as Promise<T | undefined>;
  }

  private async load(name: Dataset): Promise<unknown> {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${name}.json`);
    const metaFile = join(this.dir, `${name}.meta.json`);
    const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, 'utf8')) as { fetchedAt: number }) : undefined;
    if (!meta || Date.now() - meta.fetchedAt > REFRESH_MS || !existsSync(file)) {
      try {
        const res = await this.fetchImpl(DATASETS[name]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        JSON.parse(text);
        writeFileSync(file, text);
        writeFileSync(metaFile, JSON.stringify({ fetchedAt: Date.now() }));
      } catch (err) {
        console.error(`[guardjin] community data "${name}" refresh failed (${(err as Error).message})${existsSync(file) ? '; using cached copy' : ''}`);
      }
    }
    try {
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
    } catch {
      return undefined;
    }
  }
}
