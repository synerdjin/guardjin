import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setQuestTrackedState } from 'bungie-api-ts/destiny2';
import { z } from 'zod';
import type { Context } from '../context.js';
import { unwrap } from '../bungie/http.js';
import { buildCharacters, type Character } from '../inventory/model.js';
import { buildPursuits, type Pursuit, type PursuitKind } from '../quests/pursuits.js';
import { READ_ONLY, UserError, WRITE, ok, paginate, resolveCharacter, safe } from './util.js';

/** Keeps long lore text from swamping the result. */
const clip = (t: string | undefined, max = 220) => (t && t.length > max ? `${t.slice(0, max).trimEnd()}…` : t);

const KIND_ORDER: Record<PursuitKind, number> = { quest: 0, bounty: 1, other: 2 };

export function registerQuestTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'get_quests',
    {
      title: 'Quests and bounties',
      description:
        'Lists quests, bounties and other pursuits on your characters with objective progress, quest step (e.g. step 3 of 7), rewards, expiration and tracked state. ' +
        'Pursuits that several characters hold with the same progress are listed once with every holder. Progress is always fetched fresh.',
      inputSchema: {
        character: z.string().optional().describe('Character id or class name. Default: all characters'),
        kind: z.enum(['quest', 'bounty', 'other', 'all']).optional().describe('Default: all'),
        status: z
          .enum(['incomplete', 'complete', 'any'])
          .optional()
          .describe('complete = every objective done (bounties ready to turn in). Default: any'),
        query: z.string().optional().describe('Case-insensitive substring of the name, questline, or an objective'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
      },
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const [profile, defs] = await Promise.all([ctx.profile.pursuits(), ctx.manifest.load()]);
      const characters = buildCharacters(profile, defs);
      const character = args.character ? resolveCharacter({ characters }, args.character) : undefined;
      const q = args.query?.trim().toLowerCase();

      const all = buildPursuits(profile, defs);
      const results = all.filter((p) => {
        if (character && !p.characterIds.includes(character.id)) return false;
        if (args.kind && args.kind !== 'all' && p.kind !== args.kind) return false;
        if (args.status === 'complete' && !p.complete) return false;
        if (args.status === 'incomplete' && p.complete) return false;
        if (q && ![p.name, p.questline?.name ?? '', ...p.objectives.map((o) => o.description)].some((t) => t.toLowerCase().includes(q))) {
          return false;
        }
        return true;
      });
      results.sort(
        (a, b) =>
          Number(b.tracked) - Number(a.tracked) ||
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
          Number(a.complete) - Number(b.complete) ||
          a.name.localeCompare(b.name),
      );

      const scope = character ? all.filter((p) => p.characterIds.includes(character.id)) : all;
      const page = paginate(results, args.offset ?? 0, args.limit ?? 50);
      return ok({
        counts: {
          quests: scope.filter((p) => p.kind === 'quest').length,
          bounties: scope.filter((p) => p.kind === 'bounty').length,
          bountiesReadyToTurnIn: scope.filter((p) => p.kind === 'bounty' && p.complete).length,
          expired: scope.filter((p) => p.expired).length,
        },
        ...page,
        items: page.items.map((p) => briefPursuit(p, characters)),
      });
    }),
  );

  server.registerTool(
    'track_quest',
    {
      title: 'Track or untrack a quest',
      description:
        'Sets the tracked state of a quest or bounty (the one shown in your in-game HUD). Only instanced pursuits can be tracked; get_quests gives those an `id`. ' +
        'Changes your real account state. Tracking is per character.',
      inputSchema: {
        quest: z.string().describe('The `id` from get_quests, or a unique quest/bounty name'),
        tracked: z.boolean().optional().describe('Default true; false untracks'),
        character: z.string().optional().describe('Character id or class name. Default: the most recently played character holding it'),
        dryRun: z.boolean().optional().describe('Only show which quest would change'),
      },
      annotations: WRITE,
    },
    safe(async ({ quest, tracked, character, dryRun }) => {
      const [profile, defs] = await Promise.all([ctx.profile.pursuits(), ctx.manifest.load()]);
      const characters = buildCharacters(profile, defs);
      const wanted = character ? resolveCharacter({ characters }, character) : undefined;
      const q = quest.trim().toLowerCase();

      const id = quest.trim();
      const trackable = buildPursuits(profile, defs).filter((p) => p.instances.length);
      const byId = trackable.filter((p) => p.instances.some((i) => i.instanceId === id));
      const exact = trackable.filter((p) => p.name.toLowerCase() === q);
      const matches = byId.length ? byId : exact.length ? exact : trackable.filter((p) => p.name.toLowerCase().includes(q));
      if (matches.length > 1) {
        throw new UserError(`"${quest}" matches ${matches.length} pursuits: ${matches.map((p) => p.name).join(', ')}. Pass an id from get_quests.`);
      }
      if (!matches.length) {
        throw new UserError(`No trackable quest or bounty matches "${quest}". Uninstanced quest steps can't be tracked through the API; use get_quests to see ids.`);
      }
      const pursuit = matches[0];
      const instance = pursuit.instances.find((i) => (byId.length ? i.instanceId === id : !wanted || i.characterId === wanted.id));
      if (!instance) throw new UserError(`${wanted?.className ?? 'That character'} does not hold "${pursuit.name}".`);

      const state = tracked ?? true;
      const characterName = characters.find((c) => c.id === instance.characterId)?.className;
      if (dryRun) return ok({ dryRun: true, quest: pursuit.name, wouldTrack: state, character: characterName });
      const account = await ctx.account.get();
      await unwrap(
        setQuestTrackedState(ctx.http, {
          state,
          itemId: instance.instanceId,
          characterId: instance.characterId,
          membershipType: account.membershipType,
        }),
      );
      return ok({ quest: pursuit.name, tracked: state, character: characterName });
    }),
  );
}

function briefPursuit(p: Pursuit, characters: Character[]) {
  const out: Record<string, unknown> = { name: p.name, type: p.type, kind: p.kind };
  if (p.instances.length) out.id = p.instances[0].instanceId;
  if (p.questline) out.questline = { ...p.questline, summary: clip(p.questline.summary) };
  if (p.description) out.description = clip(p.description);
  out.objectives = p.objectives.map((o) => {
    const obj: Record<string, unknown> = {
      description: o.description,
      progress: `${o.progress}/${o.completionValue}`,
    };
    if (o.complete) obj.complete = true;
    if (o.activity) obj.activity = o.activity;
    if (o.destination) obj.destination = o.destination;
    return obj;
  });
  if (p.complete) out.complete = true;
  if (p.tracked) out.tracked = true;
  if (p.expires) out.expires = p.expires;
  if (p.expired) out.expired = true;
  if (p.rewards.length) out.rewards = p.rewards.map((r) => (r.quantity > 1 ? `${r.name} x${r.quantity}` : r.name));
  out.characters = p.characterIds.map((id) => characters.find((c) => c.id === id)?.className ?? id);
  return out;
}
