#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext } from './context.js';
import { registerPrompts } from './prompts/index.js';
import { registerAccountTools } from './tools/account.js';
import { registerActionTools } from './tools/actions.js';
import { registerBuildTools } from './tools/builds.js';
import { registerHistoryTools } from './tools/history.js';
import { registerInventoryTools } from './tools/inventory.js';
import { registerLoadoutTools } from './tools/loadouts.js';
import { registerProgressTools } from './tools/progress.js';
import { registerQuestTools } from './tools/quests.js';
import { registerSocketTools } from './tools/sockets.js';
import { registerVaultTools } from './tools/vault.js';
import { registerWorldTools } from './tools/world.js';

const INSTRUCTIONS = `guardjin connects to the user's Destiny 2 account through the Bungie API.
- Item ids returned by search tools are stable instance ids; pass them to other tools.
- Armor uses Armor 3.0 stats (Weapons, Health, Class, Grenade, Super, Melee; 0-200 each).
- For builds, gather context (get_equipped_loadout, get_subclass_options, exotics via search_inventory) before running optimize_armor, and only recommend gear the user owns unless asked otherwise.
- get_quests lists quests and bounties with objective progress; use it for "what should I work on" or "which bounties are done". get_weekly_activities and get_vendor cover what is available this week; search_collectibles and search_triumphs cover what is missing or closest to done; get_recent_activities, get_activity_report, get_career_stats, get_activity_clears and get_weapon_stats cover past performance; get_progression, get_currencies and get_craftables cover account progress. Bungie's data can lag a write by a minute or more: get_character and get_item_details read live, and get_current_activity says whether gear changes are likely to be accepted.
- Write tools (transfer_items, equip_items, set_lock_state, pull_from_postmaster, track_quest, equip_loadout, save_loadout, rename_loadout, clear_loadout, apply_plugs) change the real account: confirm with the user first, and run dryRun before larger changes. save_loadout with overwrite and clear_loadout cannot be undone.
- To save an optimize_armor result: equip the pieces (save_loadout items, or equip_items), apply its stat mods with apply_plugs, then save_loadout. The API cannot dismantle items.
- If a tool reports that the user is not logged in, tell them to run \`npm run auth\` in the guardjin folder.`;

async function main(): Promise<void> {
  const ctx = createContext();
  const server = new McpServer({ name: 'guardjin', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  registerAccountTools(server, ctx);
  registerInventoryTools(server, ctx);
  registerBuildTools(server, ctx);
  registerVaultTools(server, ctx);
  registerActionTools(server, ctx);
  registerLoadoutTools(server, ctx);
  registerWorldTools(server, ctx);
  registerProgressTools(server, ctx);
  registerHistoryTools(server, ctx);
  registerSocketTools(server, ctx);
  registerQuestTools(server, ctx);
  registerPrompts(server);

  await server.connect(new StdioServerTransport());
  console.error('[guardjin] MCP server running on stdio');

  // Warm the manifest in the background so the first tool call is fast.
  if (ctx.config.apiKey) {
    ctx.manifest.load().catch((err) => console.error('[guardjin] manifest preload failed:', (err as Error).message));
  } else {
    console.error('[guardjin] BUNGIE_API_KEY is not set; see README "One-time setup".');
  }
}

main().catch((err) => {
  console.error('[guardjin] fatal:', err);
  process.exit(1);
});
