import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DestinyComponentType, getCharacter, type DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import { z } from 'zod';
import type { Context } from '../context.js';
import { unwrap } from '../bungie/http.js';
import { Buckets } from '../inventory/constants.js';
import { buildInventory } from '../inventory/model.js';
import { READ_ONLY, briefItem, ok, resolveCharacter, safe } from './util.js';

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

  server.registerTool(
    'get_character',
    {
      title: 'Character (live)',
      description:
        'One character read live from Bungie: power level, stats, and everything equipped right now (weapons, armor with mods, subclass). Lighter and fresher than the cached inventory used by other tools, ' +
        'so use it to check the result of a change. Bungie\'s data can still trail a write by a minute.',
      inputSchema: { character: z.string().optional().describe('Character id or class name. Default: most recently played') },
      annotations: READ_ONLY,
    },
    safe(async ({ character }) => {
      const [inv, defs, account] = await Promise.all([ctx.profile.inventory(), ctx.manifest.load(), ctx.account.get()]);
      const c = resolveCharacter(inv, character);
      const live = await unwrap(
        getCharacter(ctx.http, {
          membershipType: account.membershipType,
          destinyMembershipId: account.membershipId,
          characterId: c.id,
          components: [
            DestinyComponentType.Characters,
            DestinyComponentType.CharacterEquipment,
            DestinyComponentType.ItemInstances,
            DestinyComponentType.ItemStats,
            DestinyComponentType.ItemSockets,
          ],
        }),
      );
      // GetCharacter shares GetProfile's shape per character, so the same builder reads it.
      const shaped = {
        characters: { data: { [c.id]: live.character.data } },
        characterEquipment: { data: { [c.id]: live.equipment.data } },
        itemComponents: live.itemComponents,
      } as unknown as DestinyProfileResponse;
      const model = buildInventory(shaped, defs);
      const stats: Record<string, number> = {};
      for (const [hash, value] of Object.entries(live.character.data?.stats ?? {})) {
        const name = defs.stat(Number(hash))?.displayProperties.name;
        if (name && name !== 'Power') stats[name] = value;
      }
      const equipped = model.items.filter((i) => i.equipped);
      return ok({
        character: model.characters[0],
        stats,
        subclass: equipped.find((i) => i.kind === 'subclass')?.name,
        weapons: equipped.filter((i) => i.kind === 'weapon').map((i) => briefItem(i, model, defs)),
        armor: equipped.filter((i) => i.kind === 'armor').map((i) => ({ ...briefItem(i, model, defs), mods: i.armor?.mods.map((m) => m.name) })),
      });
    }),
  );
}
