import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import type { HttpClient } from 'bungie-api-ts/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { ManifestLoader, type ManifestReplacement } from '../src/manifest/manifest.js';
import { defsFrom } from './helpers.js';

/** A manifest home with version v1 installed in `language`, and a server that offers v2 in English. */
function setup(language = 'en') {
  const home = mkdtempSync(join(tmpdir(), 'guardjin-manifest-'));
  const dir = join(home, 'manifest');
  mkdirSync(dir);
  const world = join(home, 'world.sqlite');
  defsFrom({}).db.exec(`VACUUM INTO '${world}'`);
  const oldFile = `world_${language}_v1.sqlite`;
  copyFileSync(world, join(dir, oldFile));
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ version: 'v1', language, file: oldFile }));

  const http = (async () => ({ Response: { version: 'v2', mobileWorldContentPaths: { en: '/world.content' } } })) as unknown as HttpClient;
  vi.stubGlobal('fetch', async () => new Response(zipSync({ 'world.content': readFileSync(world) })));
  const loader = new ManifestLoader({ homeDir: home, language: 'en' } as Config, http);
  return { loader, dir, oldPath: join(dir, oldFile), newPath: join(dir, 'world_en_v2.sqlite') };
}

describe('ManifestLoader updates', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports a new version while the previous database still exists, then removes it', async () => {
    const { loader, oldPath, newPath } = setup();
    const seen: (ManifestReplacement & { bothExist: boolean })[] = [];
    loader.onUpdate = (u) => seen.push({ ...u, bothExist: existsSync(u.previousFile) && existsSync(u.file) });
    const defs = await loader.load();
    expect(defs.version).toBe('v2');
    await loader.updated;
    expect(seen).toEqual([{ version: 'v2', previousVersion: 'v1', previousFile: oldPath, file: newPath, bothExist: true }]);
    expect(existsSync(oldPath)).toBe(false);
  });

  it('still loads and cleans up when the comparison fails', async () => {
    const { loader, oldPath } = setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    loader.onUpdate = () => {
      throw new Error('boom');
    };
    expect((await loader.load()).version).toBe('v2');
    await loader.updated;
    expect(error.mock.calls.some(([m]) => String(m).includes('could not compare manifest v1 with v2: boom'))).toBe(true);
    expect(existsSync(oldPath)).toBe(false);
  });

  it('does not compare across languages', async () => {
    const { loader } = setup('fr');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onUpdate = vi.fn();
    loader.onUpdate = onUpdate;
    await loader.load();
    await loader.updated;
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
