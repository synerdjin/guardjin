import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNGIE_ROOT = 'https://www.bungie.net';
export const API_ROOT = `${BUNGIE_ROOT}/Platform`;
export const OAUTH_AUTHORIZE_URL = `${BUNGIE_ROOT}/en/OAuth/Authorize`;
export const OAUTH_TOKEN_URL = `${API_ROOT}/App/OAuth/Token/`;
export const DEFAULT_WISHLIST_URL =
  'https://raw.githubusercontent.com/48klocs/dim-wish-list-sources/master/voltron.txt';

export interface Config {
  apiKey: string;
  clientId?: string;
  clientSecret?: string;
  homeDir: string;
  language: string;
  redirectPort: number;
  wishlistUrl: string;
  /** Where build specs (JSON) are read and written by name. */
  buildsDir: string;
}

let loadedEnv = false;

/** Loads `.env` from the project root and the current directory (values already in the environment win). */
function loadDotEnv(): void {
  if (loadedEnv) return;
  loadedEnv = true;
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const file of [join(process.cwd(), '.env'), join(projectRoot, '.env')]) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch {
        // ignore malformed .env; explicit env vars still apply
      }
    }
  }
}

export function loadConfig(): Config {
  loadDotEnv();
  const env = process.env;
  const homeDir = env.GUARDJIN_HOME || join(homedir(), '.guardjin');
  mkdirSync(homeDir, { recursive: true });
  return {
    apiKey: env.BUNGIE_API_KEY ?? '',
    clientId: env.BUNGIE_CLIENT_ID || undefined,
    clientSecret: env.BUNGIE_CLIENT_SECRET || undefined,
    homeDir,
    language: env.GUARDJIN_LANGUAGE || 'en',
    redirectPort: Number(env.GUARDJIN_REDIRECT_PORT || 7777),
    wishlistUrl: env.GUARDJIN_WISHLIST_URL || DEFAULT_WISHLIST_URL,
    buildsDir: expandHome(env.GUARDJIN_BUILDS_DIR) || join(homeDir, 'builds'),
  };
}

/** Expands a leading ~ to the home folder. */
export function expandHome(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

export function redirectUri(config: Config): string {
  return `https://localhost:${config.redirectPort}/callback`;
}
