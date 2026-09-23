import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { locationLabel, type InventoryModel } from '../inventory/model.js';
import {
  executeEquip,
  executeTransfers,
  planEquip,
  planTransfers,
  setLocks,
  type Destination,
  type TransferPlan,
} from '../vault/actions.js';
import { UserError, WRITE, ok, resolveCharacter, resolveItems, safe } from './util.js';

const ACTION_NOTE = 'Changes your real inventory. Use dryRun first when moving many items.';

function describePlan(plan: TransferPlan, inv: InventoryModel) {
  const charName = (id: string) => inv.characters.find((c) => c.id === id)?.className ?? id;
  return {
    steps: plan.steps.map((s) => ({
      item: s.item.name,
      id: s.item.instanceId,
      action:
        s.action === 'to-vault'
          ? `${charName(s.characterId)} → vault`
          : s.action === 'from-vault'
            ? `vault → ${charName(s.characterId)}`
            : `postmaster → ${charName(s.characterId)}`,
    })),
    errors: plan.errors.map((e) => e.error),
    alreadyThere: plan.alreadyThere.map((i) => `${i.name} (${locationLabel(i.location, inv.characters)})`),
  };
}

export function registerActionTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'transfer_items',
    {
      title: 'Transfer items',
      description:
        'Moves items to the vault or to a character. Character-to-character moves go through the vault; items in the postmaster are pulled first. ' +
        `Checks free space before moving. Equipped items can't be moved (equip something else first). ${ACTION_NOTE}`,
      inputSchema: {
        items: z.array(z.string()).min(1).max(50).describe('Item ids (from search_inventory) or unique names'),
        to: z.string().describe('"vault", or a character id/class name'),
        dryRun: z.boolean().optional().describe('Only show the planned moves'),
      },
      annotations: WRITE,
    },
    safe(async ({ items, to, dryRun }) => {
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const resolved = resolveItems(inv, items);
      const dest: Destination =
        to.trim().toLowerCase() === 'vault' ? { type: 'vault' } : { type: 'character', characterId: resolveCharacter(inv, to).id };
      const plan = planTransfers(inv, defs, resolved.map((item) => ({ item, to: dest })));
      if (dryRun || !plan.steps.length) return ok({ dryRun: !!dryRun, plan: describePlan(plan, inv) });
      const account = await ctx.account.get();
      try {
        const results = await executeTransfers(ctx.http, account, plan);
        return ok({ plan: describePlan(plan, inv), results });
      } finally {
        ctx.profile.invalidate();
      }
    }),
  );

  server.registerTool(
    'equip_items',
    {
      title: 'Equip items',
      description:
        'Equips weapons/armor (and subclass or ghost) on a character, moving them there first if needed. Checks class restrictions and the one-exotic-weapon / one-exotic-armor limit. ' +
        `The character must be in orbit, in a social space, or offline. ${ACTION_NOTE}`,
      inputSchema: {
        items: z.array(z.string()).min(1).max(20).describe('Item ids or unique names'),
        character: z.string().optional().describe('Character id or class name; default is the most recently played'),
        dryRun: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ items, character, dryRun }) => {
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character);
      const plan = planEquip(inv, defs, c.id, resolveItems(inv, items));
      const summary = {
        character: c.className,
        transfers: describePlan(plan.transfers, inv).steps,
        equip: plan.toEquip.map((i) => i.name),
        errors: plan.errors.map((e) => e.error),
      };
      if (dryRun || !plan.toEquip.length) return ok({ dryRun: !!dryRun, ...summary });
      const account = await ctx.account.get();
      try {
        const results = await executeEquip(ctx.http, account, c.id, plan);
        return ok({ ...summary, results });
      } finally {
        ctx.profile.invalidate();
      }
    }),
  );

  server.registerTool(
    'set_lock_state',
    {
      title: 'Lock or unlock items',
      description:
        'Locks or unlocks items. Locked items are protected from dismantling in game. The usual cleanup flow is to lock everything you want to keep, then dismantle the unlocked items in game. ' +
        ACTION_NOTE,
      inputSchema: {
        items: z.array(z.string()).min(1).max(100).describe('Item ids or unique names'),
        locked: z.boolean().describe('true = lock, false = unlock'),
        dryRun: z.boolean().optional(),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    safe(async ({ items, locked, dryRun }) => {
      const inv = await ctx.profile.inventory(true);
      const resolved = resolveItems(inv, items);
      if (dryRun) {
        return ok({
          dryRun: true,
          willChange: resolved.filter((i) => i.locked !== locked && i.lockable).map((i) => `${i.name} [${i.instanceId}]`),
          unchanged: resolved.filter((i) => i.locked === locked || !i.lockable).map((i) => `${i.name} [${i.instanceId}]`),
        });
      }
      const account = await ctx.account.get();
      try {
        return ok({ results: await setLocks(ctx.http, account, inv, resolved, locked) });
      } finally {
        ctx.profile.invalidate();
      }
    }),
  );

  server.registerTool(
    'pull_from_postmaster',
    {
      title: 'Pull from postmaster',
      description: `Pulls gear from a character's postmaster (Lost Items) into that character's inventory, if there is room. ${ACTION_NOTE}`,
      inputSchema: {
        character: z.string().optional().describe('Character id or class name, or "all" (default: all characters)'),
        items: z.array(z.string()).optional().describe('Only these item ids; default is every instanced item in the postmaster'),
        dryRun: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ character, items, dryRun }) => {
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const charIds =
        !character || character.toLowerCase() === 'all' ? inv.characters.map((c) => c.id) : [resolveCharacter(inv, character).id];
      let postmaster = inv.items.filter(
        (i) => i.location.type === 'postmaster' && charIds.includes(i.location.characterId) && i.instanceId,
      );
      if (items?.length) {
        const wanted = new Set(resolveItems(inv, items).map((i) => i.instanceId));
        postmaster = postmaster.filter((i) => wanted.has(i.instanceId));
      }
      if (!postmaster.length) throw new UserError('Nothing to pull from the postmaster.');
      const plan = planTransfers(
        inv,
        defs,
        postmaster.map((item) => ({
          item,
          to: { type: 'character', characterId: (item.location as { characterId: string }).characterId },
        })),
      );
      if (dryRun || !plan.steps.length) return ok({ dryRun: !!dryRun, plan: describePlan(plan, inv) });
      const account = await ctx.account.get();
      try {
        return ok({ plan: describePlan(plan, inv), results: await executeTransfers(ctx.http, account, plan) });
      } finally {
        ctx.profile.invalidate();
      }
    }),
  );
}
