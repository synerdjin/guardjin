import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DestinyActivityModeType,
  DestinyStatsGroupType,
  PeriodType,
  getActivityHistory,
  getDestinyAggregateActivityStats,
  getHistoricalStats,
  getPostGameCarnageReport,
  getUniqueWeaponHistory,
} from 'bungie-api-ts/destiny2';
import { z } from 'zod';
import type { Context } from '../context.js';
import { unwrap } from '../bungie/http.js';
import { mergeClears, mergeWeapons, summarizeStats } from '../history/career.js';
import { summarizeActivity, summarizeReport } from '../history/activities.js';
import { READ_ONLY, UserError, ok, paginate, resolveCharacter, safe } from './util.js';

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

/** Modes shown in the overview, in one request. */
const OVERVIEW_MODES = [
  MODES.pve, MODES.crucible, MODES.raid, MODES.dungeon, MODES.nightfall, MODES.strike, MODES.lostsector,
  MODES.story, MODES.patrol, MODES.trials, MODES.ironbanner, MODES.gambit,
];

/** Additional modes accepted by get_career_stats. */
const CAREER_ONLY_MODES: Record<string, DestinyActivityModeType> = {
  control: DestinyActivityModeType.Control,
  clash: DestinyActivityModeType.Clash,
  rumble: DestinyActivityModeType.Rumble,
  elimination: DestinyActivityModeType.Elimination,
};

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

  server.registerTool(
    'get_career_stats',
    {
      title: 'Career stats',
      description:
        'Lifetime stats from the game: kills, deaths, K/D, efficiency, activities entered and won, time played, best kill spree. Without `mode` it lists every mode you have played with headline numbers; ' +
        'with `mode` (e.g. raid, allPvP, nightfall, trialsOfOsiris) it returns every stat for that mode.',
      inputSchema: {
        mode: z.string().optional().describe('e.g. raid, dungeon, nightfall, strike, lostsector, story, patrol, pve, pvp, crucible, trials, ironbanner, gambit. Default: overview of the main modes'),
        character: z.string().optional().describe('Character id or class name. Default: all characters combined'),
        allStats: z.boolean().optional().describe('With mode: every stat instead of the headline ones'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ mode, character, allStats }) => {
      const [inv, account] = await Promise.all([ctx.profile.inventory(), ctx.account.get()]);
      const char = character ? resolveCharacter(inv, character) : undefined;
      const wanted = mode?.trim().toLowerCase();
      const modeType = wanted ? (MODES[wanted as keyof typeof MODES] ?? CAREER_ONLY_MODES[wanted]) : undefined;
      if (wanted && wanted !== 'all' && modeType === undefined) {
        throw new UserError(`Unknown mode "${mode}". Try: ${[...Object.keys(MODES), ...Object.keys(CAREER_ONLY_MODES)].filter((m) => m !== 'all').join(', ')}`);
      }
      // Character id "0" asks Bungie for stats merged across every character.
      const results = await unwrap(
        getHistoricalStats(ctx.http, {
          membershipType: account.membershipType,
          destinyMembershipId: account.membershipId,
          characterId: char?.id ?? '0',
          groups: [DestinyStatsGroupType.General],
          periodType: PeriodType.AllTime,
          modes: wanted && wanted !== 'all' ? [modeType!] : OVERVIEW_MODES,
        }),
      );
      const scope = char ? char.className : 'all characters';
      const played = Object.entries(results).filter(([, v]) => v.allTime && Object.keys(v.allTime).length);
      if (!wanted || wanted === 'all') {
        return ok({ scope, modes: Object.fromEntries(played.map(([key, v]) => [key, summarizeStats(v.allTime)])) });
      }
      if (!played.length) return ok({ scope, mode: mode, note: 'No recorded stats for this mode.' });
      return ok({ scope, modes: Object.fromEntries(played.map(([key, v]) => [key, summarizeStats(v.allTime, allStats)])) });
    }),
  );

  server.registerTool(
    'get_activity_clears',
    {
      title: 'Activity clears',
      description:
        'How many times you have completed each activity (raids, dungeons, strikes, Nightfalls...), with your fastest clear time and total kills, combined across characters. ' +
        'Difficulty variants (Normal, Master, Contest) are separate rows.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring of the activity name, e.g. "Vault of Glass", "Master"'),
        minCompletions: z.number().int().min(0).optional().describe('Default 1'),
        sort: z.enum(['completions', 'fastest', 'name']).optional().describe('Default: completions'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 30'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, minCompletions, sort, limit }) => {
      const [inv, defs, account] = await Promise.all([ctx.profile.inventory(), ctx.manifest.load(), ctx.account.get()]);
      const perCharacter = await Promise.all(
        inv.characters.map(async (c) =>
          (await unwrap(getDestinyAggregateActivityStats(ctx.http, { membershipType: account.membershipType, destinyMembershipId: account.membershipId, characterId: c.id }))).activities ?? [],
        ),
      );
      const q = query?.trim().toLowerCase();
      const rows = mergeClears(perCharacter, defs).filter((c) => c.completions >= (minCompletions ?? 1) && (!q || c.name.toLowerCase().includes(q)));
      rows.sort((a, b) =>
        sort === 'name'
          ? a.name.localeCompare(b.name)
          : sort === 'fastest'
            ? (a.fastestMs ?? Infinity) - (b.fastestMs ?? Infinity)
            : b.completions - a.completions || a.name.localeCompare(b.name),
      );
      const page = paginate(rows, 0, limit ?? 30);
      return ok({ ...page, items: page.items.map(({ fastestMs: _ms, ...c }) => c) });
    }),
  );

  server.registerTool(
    'get_weapon_stats',
    {
      title: 'Weapon stats',
      description: 'Your lifetime kills per weapon with precision kills and precision percentage, combined across characters. Weapons you have used at least once; sort by kills or precision.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring of the weapon name'),
        type: z.string().optional().describe('Substring of the weapon type, e.g. "Hand Cannon", "Sniper"'),
        minKills: z.number().int().min(0).optional().describe('Default 1'),
        sort: z.enum(['kills', 'precision']).optional().describe('Default: kills'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, type, minKills, sort, limit }) => {
      const [inv, defs, account] = await Promise.all([ctx.profile.inventory(), ctx.manifest.load(), ctx.account.get()]);
      const perCharacter = await Promise.all(
        inv.characters.map(async (c) =>
          (await unwrap(getUniqueWeaponHistory(ctx.http, { membershipType: account.membershipType, destinyMembershipId: account.membershipId, characterId: c.id }))).weapons ?? [],
        ),
      );
      const q = query?.trim().toLowerCase();
      const t = type?.trim().toLowerCase();
      const rows = mergeWeapons(perCharacter, defs).filter(
        (w) => w.kills >= (minKills ?? 1) && (!q || w.name.toLowerCase().includes(q)) && (!t || (w.type ?? '').toLowerCase().includes(t)),
      );
      rows.sort((a, b) => (sort === 'precision' ? b.precisionPercent - a.precisionPercent || b.kills - a.kills : b.kills - a.kills));
      return ok(paginate(rows, 0, limit ?? 25));
    }),
  );
}
