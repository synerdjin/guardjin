import type { HttpClient } from 'bungie-api-ts/http';
import { AccountService } from './bungie/account.js';
import { AuthManager } from './bungie/auth.js';
import { CommunityDataService } from './community/data.js';
import { createHttpClient } from './bungie/http.js';
import { loadConfig, type Config } from './config.js';
import { ProfileService } from './inventory/profile.js';
import { ManifestLoader } from './manifest/manifest.js';
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
}

export function createContext(config: Config = loadConfig()): Context {
  const auth = new AuthManager(config);
  const http = createHttpClient({ apiKey: config.apiKey, getAccessToken: () => auth.getAccessToken() });
  const account = new AccountService(http);
  const manifest = new ManifestLoader(config, http);
  const profile = new ProfileService(http, account, manifest);
  const wishlist = new WishlistService(config);
  const community = new CommunityDataService(config);
  return { config, http, auth, account, manifest, profile, wishlist, community };
}
