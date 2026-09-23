import { describe, expect, it } from 'vitest';
import { BungieApiError, NotAuthenticatedError, createHttpClient } from '../src/bungie/http.js';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const success = (payload: unknown) => response({ Response: payload, ErrorCode: 1, ThrottleSeconds: 0, ErrorStatus: 'Success', Message: 'Ok' });

function client(responses: (() => Response)[], token?: string) {
  const requests: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const http = createHttpClient({
    apiKey: 'KEY',
    getAccessToken: async () => token,
    fetchImpl: (async (url: URL, init: RequestInit) => {
      requests.push({ url: String(url), init });
      const next = responses.shift();
      if (!next) throw new Error('no more responses');
      return next();
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { http, requests, sleeps };
}

describe('createHttpClient', () => {
  it('sends the API key, bearer token and query params', async () => {
    const { http, requests } = client([() => success({ ok: true })], 'TOKEN');
    const res = await http<{ Response: unknown }>({ method: 'GET', url: 'https://www.bungie.net/Platform/X/', params: { components: '100,200' } });
    expect(res.Response).toEqual({ ok: true });
    const headers = requests[0].init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('KEY');
    expect(headers.Authorization).toBe('Bearer TOKEN');
    expect(requests[0].url).toContain('components=100%2C200');
  });

  it('retries throttled requests after ThrottleSeconds', async () => {
    const { http, sleeps } = client([
      () => response({ ErrorCode: 1672, ThrottleSeconds: 2, ErrorStatus: 'DestinyThrottledByGameServer', Message: 'slow down' }),
      () => success(1),
    ]);
    await expect(http({ method: 'GET', url: 'https://www.bungie.net/Platform/X/' })).resolves.toMatchObject({ Response: 1 });
    expect(sleeps).toEqual([2000]);
  });

  it('maps auth errors and other failures to typed errors', async () => {
    const { http } = client([
      () => response({ ErrorCode: 99, ThrottleSeconds: 0, ErrorStatus: 'WebAuthRequired', Message: 'Please sign in.' }),
      () => response({ ErrorCode: 1642, ThrottleSeconds: 0, ErrorStatus: 'DestinyNoRoomInDestination', Message: 'No room.' }),
    ]);
    await expect(http({ method: 'GET', url: 'https://www.bungie.net/Platform/X/' })).rejects.toBeInstanceOf(NotAuthenticatedError);
    const err = (await http({ method: 'GET', url: 'https://www.bungie.net/Platform/X/' }).catch((e) => e)) as BungieApiError;
    expect(err).toBeInstanceOf(BungieApiError);
    expect(err.errorCode).toBe(1642);
  });

  it('spaces out write actions', async () => {
    const { http, sleeps, requests } = client([() => success(0), () => success(0)]);
    const url = 'https://www.bungie.net/Platform/Destiny2/Actions/Items/TransferItem/';
    await Promise.all([http({ method: 'POST', url, body: { a: 1 } }), http({ method: 'POST', url, body: { a: 2 } })]);
    expect(requests.map((r) => JSON.parse(String(r.init.body)).a)).toEqual([1, 2]);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });
});
