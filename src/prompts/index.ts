import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'suggest_build',
    {
      title: 'Suggest a build',
      description: 'Walks through making a build from gear you actually own, for an activity and playstyle.',
      argsSchema: {
        character: z.string().optional().describe('titan, hunter, warlock, or a character id (default: last played)'),
        activity: z.string().describe('e.g. Grandmaster Nightfall, raid, solo dungeon, Trials, general PvE'),
        playstyle: z.string().optional().describe('e.g. grenade spam, melee, super uptime, support/healing, weapons'),
        element: z.string().optional().describe('Preferred subclass: Prismatic, Solar, Void, Arc, Stasis, Strand'),
      },
    },
    ({ character, activity, playstyle, element }) =>
      user(
        [
          `Build me a Destiny 2 build for ${activity}${character ? ` on my ${character}` : ''}` +
            `${playstyle ? `, playstyle: ${playstyle}` : ''}${element ? `, subclass: ${element}` : ''}.`,
          '',
          'Use the guardjin tools and only suggest gear I actually own:',
          '1. get_equipped_loadout to see my current setup and stats.',
          '2. get_subclass_options for the subclass(es) that fit, and pick a super, abilities, aspects and fragments. Note fragment stat bonuses.',
          '3. search_inventory with rarity "exotic" (armor for my class, and weapons) to list my exotics; use get_item_details or lookup_definition to read exotic perks and choose ONE exotic armor that synergizes with the subclass.',
          '4. Decide stat priorities for the activity and playstyle (stats range 0–200; above 100 gives enhanced benefits), then run optimize_armor with that exotic, minimums/priorities, and any worthwhile armor set bonus.',
          '5. Pick weapons from my inventory (search_inventory with kind "weapon", filtered by element/perk) that complement the build; mention the key perks. For endgame PvE, run champion_coverage with those weapons (items) and scope "owned" so Barrier, Overload and Unstoppable are all answered, and use plan_activity if a specific activity was named.',
          '6. Pick artifact perks with get_artifact.',
          '7. Present the build: subclass config, exotic, armor pieces (with ids and where they are), stat mods, weapons, artifact perks, champion coverage, and a short explanation of how it plays. Point out any piece that still needs masterworking.',
          '8. Ask whether I want it equipped. Only then call equip_items, apply_plugs for mods/aspects/fragments/artifact perks (dryRun first), and offer export_build to save it as a spec I can audit later.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'clean_vault',
    {
      title: 'Clean up my vault',
      description: 'Finds what is safe to dismantle and helps lock the keepers.',
      argsSchema: {
        focus: z.enum(['weapons', 'armor', 'all']).optional().describe('Default all'),
        aggressiveness: z.enum(['conservative', 'normal', 'aggressive']).optional().describe('How much to suggest removing (default normal)'),
      },
    },
    ({ focus, aggressiveness }) => {
      const level = aggressiveness ?? 'normal';
      const minConfidence = level === 'conservative' ? 3 : level === 'normal' ? 2 : 1;
      const kinds = focus === 'weapons' ? '["weapon"]' : focus === 'armor' ? '["armor"]' : '["weapon","armor"]';
      return user(
        [
          `Help me clean up my Destiny 2 vault (${focus ?? 'all'} gear, ${level} mode).`,
          '',
          '1. vault_summary to see how full the vault and characters are.',
          '2. triage_drops to apply my keep rules (~/.guardjin/keep-rules.json) to unlocked gear.',
          `3. suggest_cleanup with kinds ${kinds} and minConfidence ${minConfidence} as a second opinion. Page through all results.`,
          '4. find_duplicates to double-check weapon duplicates, keeping the best roll of each (wishlist verdict first, then perks that matter for my playstyle).',
          '5. Present a grouped list: "safe to dismantle", "probably dismantle", and "keep", with a one-line reason each. Never suggest dismantling locked or equipped items, or my only copy of an exotic.',
          '6. Offer to lock the "keep" items with set_lock_state so I can dismantle the rest in game. Do not change anything until I confirm.',
        ].join('\n'),
      );
    },
  );
}
