import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OAUTH_AUTHORIZE_URL, OAUTH_TOKEN_URL, type Config } from '../config.js';

export interface StoredTokens {
  accessToken: string;
  /** epoch ms */
  accessTokenExpiresAt: number;
  refreshToken?: string;
  /** epoch ms */
  refreshTokenExpiresAt?: number;
  /** Bungie.net membership id of the logged-in user */
  bungieMembershipId: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  membership_id: string;
}

const EXPIRY_MARGIN_MS = 60_000;

export class AuthManager {
  private tokens: StoredTokens | undefined;
  private refreshing: Promise<StoredTokens | undefined> | undefined;
  private readonly file: string;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.file = join(config.homeDir, 'tokens.json');
    this.tokens = this.readFile();
  }

  get tokenFile(): string {
    return this.file;
  }

  authorizeUrl(state: string): string {
    const u = new URL(OAUTH_AUTHORIZE_URL);
    u.searchParams.set('client_id', this.requireClientId());
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('state', state);
    return u.toString();
  }

  status(): { loggedIn: boolean; accessTokenExpiresAt?: string; refreshTokenExpiresAt?: string; bungieMembershipId?: string } {
    const t = this.readFile() ?? this.tokens;
    this.tokens = t;
    if (!t) return { loggedIn: false };
    const refreshValid = !!t.refreshToken && (t.refreshTokenExpiresAt ?? 0) > Date.now();
    return {
      loggedIn: refreshValid || t.accessTokenExpiresAt > Date.now(),
      accessTokenExpiresAt: new Date(t.accessTokenExpiresAt).toISOString(),
      refreshTokenExpiresAt: t.refreshTokenExpiresAt ? new Date(t.refreshTokenExpiresAt).toISOString() : undefined,
      bungieMembershipId: t.bungieMembershipId,
    };
  }

  /** A valid access token, refreshing it if needed; undefined when not logged in. */
  async getAccessToken(): Promise<string | undefined> {
    // Pick up tokens written by `npm run auth` while the server is running.
    if (!this.tokens || this.tokens.accessTokenExpiresAt - EXPIRY_MARGIN_MS <= Date.now()) {
      this.tokens = this.readFile() ?? this.tokens;
    }
    const t = this.tokens;
    if (!t) return undefined;
    if (t.accessTokenExpiresAt - EXPIRY_MARGIN_MS > Date.now()) return t.accessToken;
    if (!t.refreshToken || (t.refreshTokenExpiresAt ?? 0) <= Date.now()) return undefined;
    this.refreshing ??= this.refresh(t.refreshToken).finally(() => {
      this.refreshing = undefined;
    });
    return (await this.refreshing)?.accessToken;
  }

  async exchangeCode(code: string): Promise<StoredTokens> {
    return this.requestTokens({ grant_type: 'authorization_code', code });
  }

  private async refresh(refreshToken: string): Promise<StoredTokens | undefined> {
    try {
      return await this.requestTokens({ grant_type: 'refresh_token', refresh_token: refreshToken });
    } catch (err) {
      console.error('[guardjin] token refresh failed:', err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  private async requestTokens(params: Record<string, string>): Promise<StoredTokens> {
    const clientId = this.requireClientId();
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-API-Key': this.config.apiKey,
    };
    const body = new URLSearchParams(params);
    if (this.config.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${this.config.clientSecret}`).toString('base64')}`;
    } else {
      body.set('client_id', clientId);
    }
    const res = await this.fetchImpl(OAUTH_TOKEN_URL, { method: 'POST', headers, body });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Bungie token endpoint returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text) as TokenResponse;
    const now = Date.now();
    const tokens: StoredTokens = {
      accessToken: json.access_token,
      accessTokenExpiresAt: now + json.expires_in * 1000,
      refreshToken: json.refresh_token,
      refreshTokenExpiresAt: json.refresh_expires_in ? now + json.refresh_expires_in * 1000 : undefined,
      bungieMembershipId: json.membership_id,
    };
    this.tokens = tokens;
    writeFileSync(this.file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    return tokens;
  }

  private readFile(): StoredTokens | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as StoredTokens;
    } catch {
      return undefined;
    }
  }

  private requireClientId(): string {
    if (!this.config.clientId) {
      throw new Error('BUNGIE_CLIENT_ID is not set. Add it to .env (see README "One-time setup").');
    }
    return this.config.clientId;
  }
}
