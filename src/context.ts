import { join } from 'node:path';
import type { HttpClient } from 'bungie-api-ts/http';
import { AccountService } from './bungie/account.js';
import { AuthManager } from './bungie/auth.js';
import { CommunityDataService } from './community/data.js';
import { createHttpClient } from './bungie/http.js';
import { loadConfig, type Config } from './config.js';
import { ProfileService } from './inventory/profile.js';
import { diffManifestFiles } from './manifest/diff.js';
import { ManifestLoader } from './manifest/manifest.js';
import { buildWallet } from './progress/currencies.js';
import { SnapshotStore } from './store/snapshots.js';
import { WishlistService } from './vault/wishlist.js';

/** Everything a tool needs; built once per server process. */
export interface Context {
  config: Config;
  http: HttpClient;
  auth: AuthManager;
  account: AccountService;
  manifest: ManifestLoader;
  profile: ProfileService;
  wishlist: WishlistService;
  community: CommunityDataService;
  /** Local inventory history; undefined if the database can't be opened. */
  store?: SnapshotStore;
}

export function createContext(config: Config = loadConfig()): Context {
  const auth = new AuthManager(config);
  const http = createHttpClient({ apiKey: config.apiKey, getAccessToken: () => auth.getAccessToken() });
  const account = new AccountService(http);
  const manifest = new ManifestLoader(config, http);
  const profile = new ProfileService(http, account, manifest);
  const wishlist = new WishlistService(config);
  const community = new CommunityDataService(config);
  const store = openStore(config);
  if (store) {
    profile.onFetch = (model, defs) => {
      store.observe(model);
      store.maybeSnapshot(model, { manifestVersion: defs.version, currencies: buildWallet(model.raw, defs).currencies });
    };
    manifest.onUpdate = (u) => store.recordManifestChanges(u.version, u.previousVersion, diffManifestFiles(u.previousFile, u.file));
  }
  return { config, http, auth, account, manifest, profile, wishlist, community, store };
}

function openStore(config: Config): SnapshotStore | undefined {
  try {
    return new SnapshotStore(join(config.homeDir, 'guardjin.db'));
  } catch (err) {
    console.error('[guardjin] local history disabled:', (err as Error).message);
    return undefined;
  }
}
