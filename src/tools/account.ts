import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from '../context.js';
import { Buckets } from '../inventory/constants.js';
import { READ_ONLY, ok, safe } from './util.js';

export function registerAccountTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'auth_status',
    {
      title: 'Bungie login status',
      description:
        'Shows whether guardjin is configured and logged in to Bungie, which Destiny account it uses, and when the login expires. Call this first if other tools report authentication errors.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const problems: string[] = [];
      if (!ctx.config.apiKey) problems.push('BUNGIE_API_KEY is not set');
      if (!ctx.config.clientId) problems.push('BUNGIE_CLIENT_ID is not set');
      const status = ctx.auth.status();
      let account: unknown;
      if (status.loggedIn && ctx.config.apiKey) {
        try {
          account = await ctx.account.get();
        } catch (err) {
          problems.push(`could not load Destiny account: ${(err as Error).message}`);
        }
      }
      return ok({
        ...status,
        account,
        problems: problems.length ? problems : undefined,
        howToLogIn: status.loggedIn ? undefined : 'In a terminal, run `npm run auth` in the guardjin project folder.',
      });
    }),
  );

  server.registerTool(
    'list_characters',
    {
      title: 'List characters',
      description: 'Lists your Destiny 2 characters (id, class, power, equipped subclass, last played). Most recently played comes first.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const raw = inv.raw.characters?.data ?? {};
      return ok(
        inv.characters.map((c) => {
          const subclass = inv.items.find(
            (i) => i.equipped && i.bucketHash === Buckets.Subclass && i.location.type === 'character' && i.location.characterId === c.id,
          );
          const stats: Record<string, number> = {};
          for (const [hash, value] of Object.entries(raw[c.id]?.stats ?? {})) {
            const name = defs.stat(Number(hash))?.displayProperties.name;
            if (name && name !== 'Power') stats[name] = value;
          }
          return { ...c, subclass: subclass?.name, stats };
        }),
      );
    }),
  );
}
