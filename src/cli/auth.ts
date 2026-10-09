#!/usr/bin/env node
/**
 * One-time Bungie OAuth login: `npm run auth`.
 *
 * Opens Bungie's consent page, catches the redirect on https://localhost:<port>/callback with a
 * self-signed certificate (the browser will warn once; that's expected), exchanges the code for
 * tokens, and stores them in ~/.guardjin/tokens.json. If the local listener can't be used, paste the
 * URL you were redirected to into this terminal instead.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { createInterface } from 'node:readline';
import { generate } from 'selfsigned';
import { AccountService } from '../bungie/account.js';
import { AuthManager } from '../bungie/auth.js';
import { createHttpClient } from '../bungie/http.js';
import { loadConfig, redirectUri } from '../config.js';

const TIMEOUT_MS = 5 * 60_000;

function openBrowser(url: string): void {
  try {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The URL is printed too; opening the browser is best effort.
  }
}

function parseRedirect(input: string, expectedState: string): string | undefined {
  try {
    const url = new URL(input.trim(), 'https://localhost');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code) return undefined;
    if (state !== expectedState) throw new Error('OAuth state mismatch; start `npm run auth` again.');
    return code;
  } catch (err) {
    if (err instanceof Error && err.message.includes('state mismatch')) throw err;
    return undefined;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.apiKey || !config.clientId) {
    console.error('BUNGIE_API_KEY and BUNGIE_CLIENT_ID must be set (copy .env.example to .env and fill it in).');
    process.exit(1);
  }
  if (!config.clientSecret) {
    console.warn('Note: BUNGIE_CLIENT_SECRET is not set. Public clients get no refresh token, so you will need to log in again every hour.');
  }

  const auth = new AuthManager(config);
  const state = randomBytes(16).toString('hex');
  const authorizeUrl = auth.authorizeUrl(state);

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      server?.close();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('Timed out waiting for Bungie login.'))), TIMEOUT_MS);

    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      try {
        const c = parseRedirect(line, state);
        if (c) finish(() => resolve(c));
        else console.log('That does not look like the redirect URL (it should contain "?code=").');
      } catch (err) {
        finish(() => reject(err));
      }
    });

    let server: ReturnType<typeof createServer> | undefined;
    generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256', notAfterDate: new Date(Date.now() + 86_400_000) })
      .then((pems) => {
        server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
          try {
            const c = req.url?.startsWith('/callback') ? parseRedirect(req.url, state) : undefined;
            if (!c) {
              res.writeHead(404).end('Not found');
              return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2>guardjin is logged in to Bungie.</h2><p>You can close this tab.</p>');
            finish(() => resolve(c));
          } catch (err) {
            res.writeHead(400).end((err as Error).message);
            finish(() => reject(err));
          }
        });
        server.on('error', (err) => {
          console.warn(`Could not listen on ${redirectUri(config)} (${err.message}). Paste the redirect URL here instead.`);
        });
        server.listen(config.redirectPort, '127.0.0.1');
      })
      .catch((err) => console.warn(`Could not start the local HTTPS listener (${(err as Error).message}). Paste the redirect URL here instead.`));

    console.log('\nOpening Bungie login in your browser. If it does not open, visit:\n');
    console.log(`  ${authorizeUrl}\n`);
    console.log(`After you approve, Bungie redirects to ${redirectUri(config)}.`);
    console.log('Your browser will warn about the self-signed certificate; continue to localhost to finish.');
    console.log('Or paste the full URL from the address bar here and press Enter.\n');
    openBrowser(authorizeUrl);
  });

  const tokens = await auth.exchangeCode(code);
  console.log(`Logged in. Tokens saved to ${auth.tokenFile}`);
  if (tokens.refreshTokenExpiresAt) {
    console.log(`Refresh token valid until ${new Date(tokens.refreshTokenExpiresAt).toLocaleString()} (log in again after that).`);
  }

  const http = createHttpClient({ apiKey: config.apiKey, getAccessToken: () => auth.getAccessToken() });
  try {
    const account = await new AccountService(http).get();
    console.log(`Destiny account: ${account.bungieGlobalName ?? account.displayName} (membership type ${account.membershipType})`);
  } catch (err) {
    console.warn(`Logged in, but could not load your Destiny account: ${(err as Error).message}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`Login failed: ${(err as Error).message}`);
  process.exit(1);
});
