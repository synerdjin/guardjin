#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext } from './context.js';
import { registerPrompts } from './prompts/index.js';
import { registerAccountTools } from './tools/account.js';
import { registerActionTools } from './tools/actions.js';
import { registerBuildTools } from './tools/builds.js';
import { registerInventoryTools } from './tools/inventory.js';
import { registerVaultTools } from './tools/vault.js';

const INSTRUCTIONS = `guardjin connects to the user's Destiny 2 account through the Bungie API.
- Item ids returned by search tools are stable instance ids; pass them to other tools.
- Armor uses Armor 3.0 stats (Weapons, Health, Class, Grenade, Super, Melee; 0-200 each).
- For builds, gather context (get_equipped_loadout, get_subclass_options, exotics via search_inventory) before running optimize_armor, and only recommend gear the user owns unless asked otherwise.
- Write tools (transfer_items, equip_items, set_lock_state, pull_from_postmaster) change the real inventory: confirm with the user first. The API cannot dismantle items.
- If a tool reports that the user is not logged in, tell them to run \`npm run auth\` in the guardjin folder.`;

async function main(): Promise<void> {
  const ctx = createContext();
  const server = new McpServer({ name: 'guardjin', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  registerAccountTools(server, ctx);
  registerInventoryTools(server, ctx);
  registerBuildTools(server, ctx);
  registerVaultTools(server, ctx);
  registerActionTools(server, ctx);
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
