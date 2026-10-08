import type { HttpClient, HttpClientConfig } from 'bungie-api-ts/http';
import type { ServerResponse } from 'bungie-api-ts/destiny2';

/** Bungie PlatformErrorCodes we treat specially. */
export const ErrorCodes = {
  Success: 1,
  SystemDisabled: 5,
  WebAuthRequired: 99,
  DestinyThrottledByGameServer: 1672,
  AccessTokenHasExpired: 2111,
} as const;

const THROTTLE_CODES = new Set([31, 35, 36, 37, 51, 54, 55, 56, 57, ErrorCodes.DestinyThrottledByGameServer]);
const MAX_ATTEMPTS = 4;
/** Bungie asks for at least 0.1s between write actions; leave some headroom. */
const ACTION_SPACING_MS = 150;
/** Endpoints whose documentation asks for a longer gap. */
const SLOW_ACTIONS: [RegExp, number][] = [
  [/\/Actions\/Loadouts\//, 1100],
  [/\/Actions\/Items\/SetTrackedState\//, 1100],
  [/\/Actions\/Items\/InsertSocketPlug(Free)?\//, 600],
];

/** Minimum gap around a write action, in ms. */
export function actionSpacing(url: string): number {
  return SLOW_ACTIONS.find(([re]) => re.test(url))?.[1] ?? ACTION_SPACING_MS;
}

export class BungieApiError extends Error {
  constructor(
    readonly errorCode: number,
    readonly errorStatus: string,
    message: string,
  ) {
    super(message);
    this.name = 'BungieApiError';
  }
}

export class NotAuthenticatedError extends Error {
  constructor(message = 'Not logged in to Bungie. Run `npm run auth` in the guardjin folder, then retry.') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

export interface HttpOptions {
  apiKey: string;
  /** Returns a valid access token, or undefined when the user is not logged in. */
  getAccessToken?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Builds the HttpClient that every bungie-api-ts helper runs through. It adds the API key and
 * bearer token, turns non-Success ErrorCodes into BungieApiError, retries throttling and transient
 * failures, and serializes write actions so they respect Bungie's pacing rules.
 */
export function createHttpClient(opts: HttpOptions): HttpClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  let actionChain: Promise<unknown> = Promise.resolve();
  let lastActionAt = 0;
  let lastSpacing = 0;

  async function send<T>(config: HttpClientConfig): Promise<T> {
    const url = new URL(config.url);
    if (config.params) {
      for (const [k, v] of Object.entries(config.params)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    const headers: Record<string, string> = { 'X-API-Key': opts.apiKey };
    const token = await opts.getAccessToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (config.body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: config.method,
          headers,
          body: config.body !== undefined ? JSON.stringify(config.body) : undefined,
        });
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw err;
      }

      let json: ServerResponse<unknown> | undefined;
      try {
        json = (await res.json()) as ServerResponse<unknown>;
      } catch {
        json = undefined;
      }

      if (!json || typeof json.ErrorCode !== 'number') {
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        if (res.status === 401) throw new NotAuthenticatedError();
        throw new BungieApiError(0, `HTTP${res.status}`, `Bungie API returned HTTP ${res.status} for ${url.pathname}`);
      }

      if (json.ErrorCode === ErrorCodes.Success) return json as T;

      if (THROTTLE_CODES.has(json.ErrorCode) && attempt < MAX_ATTEMPTS) {
        await sleep(Math.max(json.ThrottleSeconds ?? 0, 1) * 1000);
        continue;
      }
      if (json.ErrorCode === ErrorCodes.WebAuthRequired || json.ErrorCode === ErrorCodes.AccessTokenHasExpired) {
        throw new NotAuthenticatedError(
          `${json.Message} Run \`npm run auth\` in the guardjin folder to log in again.`,
        );
      }
      if (json.ErrorCode === ErrorCodes.SystemDisabled) {
        throw new BungieApiError(json.ErrorCode, json.ErrorStatus, 'The Bungie API is currently disabled (maintenance?). Try again later.');
      }
      throw new BungieApiError(json.ErrorCode, json.ErrorStatus, json.Message);
    }
  }

  return function http<T>(config: HttpClientConfig): Promise<T> {
    if (config.method === 'POST' && config.url.includes('/Destiny2/Actions/')) {
      const spacing = actionSpacing(config.url);
      const run = actionChain.then(async () => {
        // Honor both this action's gap and the one the previous action asked for.
        const wait = lastActionAt + Math.max(spacing, lastSpacing) - Date.now();
        if (wait > 0) await sleep(wait);
        try {
          return await send<T>(config);
        } finally {
          lastActionAt = Date.now();
          lastSpacing = spacing;
        }
      });
      actionChain = run.catch(() => undefined);
      return run;
    }
    return send<T>(config);
  } as HttpClient;
}

/** Unwraps the `Response` payload of a Bungie ServerResponse. */
export async function unwrap<T>(p: Promise<ServerResponse<T>>): Promise<T> {
  return (await p).Response;
}
