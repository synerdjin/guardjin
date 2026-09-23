import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DestinyActivityModeType, getActivityHistory, getPostGameCarnageReport } from 'bungie-api-ts/destiny2';
import { z } from 'zod';
import type { Context } from '../context.js';
import { unwrap } from '../bungie/http.js';
import { summarizeActivity, summarizeReport } from '../history/activities.js';
import { READ_ONLY, ok, resolveCharacter, safe } from './util.js';

const MODES = {
  all: DestinyActivityModeType.None,
  raid: DestinyActivityModeType.Raid,
  dungeon: DestinyActivityModeType.Dungeon,
  nightfall: DestinyActivityModeType.ScoredNightfall,
  strike: DestinyActivityModeType.AllStrikes,
  lostsector: DestinyActivityModeType.LostSector,
  story: DestinyActivityModeType.Story,
  patrol: DestinyActivityModeType.Patrol,
  pve: DestinyActivityModeType.AllPvE,
  crucible: DestinyActivityModeType.AllPvP,
  trials: DestinyActivityModeType.TrialsOfOsiris,
  ironbanner: DestinyActivityModeType.IronBanner,
  gambit: DestinyActivityModeType.Gambit,
} as const;

export function registerHistoryTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'get_recent_activities',
    {
      title: 'Recent activities',
      description:
        'Your most recent completed activities for one character, newest first: name, result, duration, kills/deaths/assists and efficiency. ' +
        'Each entry has an `instanceId` you can pass to get_activity_report for the full fireteam and weapon breakdown.',
      inputSchema: {
        character: z.string().optional().describe('Character id or class name. Default: most recently played'),
        mode: z.enum(Object.keys(MODES) as [keyof typeof MODES, ...(keyof typeof MODES)[]]).optional().describe('Default: all'),
        count: z.number().int().min(1).max(50).optional().describe('Default 10'),
        page: z.number().int().min(0).optional().describe('Page of results, starting at 0'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ character, mode, count, page }) => {
      const [inv, defs, account] = await Promise.all([ctx.profile.inventory(), ctx.manifest.load(), ctx.account.get()]);
      const char = resolveCharacter(inv, character);
      const history = await unwrap(
        getActivityHistory(ctx.http, {
          membershipType: account.membershipType,
          destinyMembershipId: account.membershipId,
          characterId: char.id,
          mode: MODES[mode ?? 'all'],
          count: count ?? 10,
          page: page ?? 0,
        }),
      );
      return ok({ character: char.className, activities: (history.activities ?? []).map((a) => summarizeActivity(a, defs)) });
    }),
  );

  server.registerTool(
    'get_activity_report',
    {
      title: 'Activity report',
      description:
        'Post-game carnage report for one activity: every player with kills, deaths, assists, efficiency and per-weapon kills (with precision kills), and which entry is you. ' +
        'Use the `instanceId` from get_recent_activities.',
      inputSchema: {
        instanceId: z.string().regex(/^\d+$/).describe('Activity instance id'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ instanceId }) => {
      const [defs, account] = await Promise.all([ctx.manifest.load(), ctx.account.get()]);
      const data = await unwrap(getPostGameCarnageReport(ctx.http, { activityId: instanceId }));
      return ok(summarizeReport(data, defs, account.membershipId));
    }),
  );
}
