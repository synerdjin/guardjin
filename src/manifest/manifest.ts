import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Unzip, UnzipInflate } from 'fflate';
import type { HttpClient } from 'bungie-api-ts/http';
import { getDestinyManifest } from 'bungie-api-ts/destiny2';
import { BUNGIE_ROOT, type Config } from '../config.js';
import { unwrap } from '../bungie/http.js';
import { buildItemIndex, Defs } from './defs.js';

interface CurrentManifest {
  version: string;
  language: string;
  file: string;
}

const log = (msg: string) => console.error(`[guardjin] ${msg}`);

/** A new manifest has been downloaded; the previous file is still on disk until the callback returns. */
export interface ManifestReplacement {
  version: string;
  previousVersion: string;
  previousFile: string;
  file: string;
}

/**
 * Keeps a local copy of Bungie's world-content SQLite database up to date and opens it.
 * The database is re-downloaded only when Bungie publishes a new manifest version.
 */
export class ManifestLoader {
  private loading: Promise<Defs> | undefined;
  private readonly dir: string;
  /** Called once per game update, before the old database is deleted. A failure is logged and never blocks the load. */
  onUpdate?: (update: ManifestReplacement) => void;
  /** Settles once the work after a download (onUpdate, removing old files) is done. */
  updated: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly http: HttpClient,
  ) {
    this.dir = join(config.homeDir, 'manifest');
  }

  /** Resolves once the manifest is ready. Safe to call concurrently. */
  load(): Promise<Defs> {
    this.loading ??= this.doLoad().catch((err) => {
      this.loading = undefined;
      throw err;
    });
    return this.loading;
  }

  private async doLoad(): Promise<Defs> {
    mkdirSync(this.dir, { recursive: true });
    const currentFile = join(this.dir, 'current.json');
    const current: CurrentManifest | undefined = existsSync(currentFile)
      ? (JSON.parse(readFileSync(currentFile, 'utf8')) as CurrentManifest)
      : undefined;
    const lang = this.config.language;

    let remote: { version: string; path: string } | undefined;
    try {
      const m = await unwrap(getDestinyManifest(this.http));
      const path = m.mobileWorldContentPaths[lang];
      if (!path) throw new Error(`Manifest has no world content for language "${lang}"`);
      remote = { version: m.version, path };
    } catch (err) {
      if (current && existsSync(join(this.dir, current.file))) {
        log(`manifest check failed (${(err as Error).message}); using cached version ${current.version}`);
        return this.open(current);
      }
      throw err;
    }

    if (current && current.version === remote.version && current.language === lang && existsSync(join(this.dir, current.file))) {
      return this.open(current);
    }

    log(`downloading Destiny manifest ${remote.version} (${lang}); this happens once per game update...`);
    const file = `world_${lang}_${remote.version.replace(/[^\w.-]/g, '_')}.sqlite`;
    const tmp = join(this.dir, `${file}.part`);
    await downloadAndUnzip(`${BUNGIE_ROOT}${remote.path}`, tmp);

    const db = new DatabaseSync(tmp);
    buildItemIndex(db);
    db.close();
    renameSync(tmp, join(this.dir, file));

    const next: CurrentManifest = { version: remote.version, language: lang, file };
    writeFileSync(currentFile, JSON.stringify(next, null, 2));
    const previous = current?.language === lang && current.file !== file && existsSync(join(this.dir, current.file)) ? current : undefined;
    log('manifest ready');
    const defs = this.open(next);
    // Comparing with the previous version takes a few seconds; do it after the caller has the manifest.
    this.updated = new Promise((resolve) =>
      setImmediate(() => {
        this.afterUpdate(next, previous);
        resolve();
      }),
    );
    return defs;
  }

  /** Reports the update to onUpdate while the previous database still exists, then deletes old databases. Never throws. */
  private afterUpdate(next: CurrentManifest, previous: CurrentManifest | undefined): void {
    if (previous && this.onUpdate) {
      try {
        this.onUpdate({ version: next.version, previousVersion: previous.version, previousFile: join(this.dir, previous.file), file: join(this.dir, next.file) });
      } catch (err) {
        log(`could not compare manifest ${previous.version} with ${next.version}: ${(err as Error).message}`);
      }
    }
    try {
      for (const f of readdirSync(this.dir)) {
        if (f.startsWith('world_') && f !== next.file) rmSync(join(this.dir, f), { force: true });
      }
    } catch (err) {
      log(`could not remove old manifest files: ${(err as Error).message}`);
    }
  }

  private open(m: CurrentManifest): Defs {
    const db = new DatabaseSync(join(this.dir, m.file), { readOnly: true });
    return new Defs(db, m.version);
  }
}

/** Streams a zip download to disk, writing its single entry to `dest`. */
async function downloadAndUnzip(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Manifest download failed: HTTP ${res.status}`);
  const fd = openSync(dest, 'w');
  try {
    let wroteEntry = false;
    let finished = false;
    let error: Error | undefined;
    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.onfile = (entry) => {
      if (wroteEntry) return; // the world DB zip holds a single file
      wroteEntry = true;
      entry.ondata = (err, chunk, final) => {
        if (err) error = err;
        else writeSync(fd, chunk);
        if (final) finished = true;
      };
      entry.start();
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      unzip.push(chunk);
      if (error) throw error;
    }
    unzip.push(new Uint8Array(0), true);
    if (error) throw error;
    if (!wroteEntry || !finished) throw new Error('Manifest download was not a complete zip archive');
  } finally {
    closeSync(fd);
  }
}
