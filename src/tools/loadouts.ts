import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import type { InventoryModel } from '../inventory/model.js';
import {
  chooseIdentifiers,
  clearSlot,
  equipSavedLoadout,
  planEquipLoadout,
  renameSlot,
  resolveSlot,
  snapshotToSlot,
  type LoadoutSlot,
} from '../loadouts/actions.js';
import { buildLoadouts, checkSave, type Loadout } from '../loadouts/loadouts.js';
import type { Defs } from '../manifest/defs.js';
import { executeEquip, executeTransfers, planEquip } from '../vault/actions.js';
import { READ_ONLY, UserError, WRITE, ok, resolveCharacter, resolveItems, safe } from './util.js';

const LAG_NOTE = 'Bungie\'s data can take a minute or more to reflect changes; call list_loadouts again to confirm.';
const OVERLAY_NOTE =
  "Mods you just changed are shown as saved, but Bungie's data can take a minute or more to show them. Re-check with list_loadouts or audit_build.";
const ORBIT_NOTE = 'The character must be in orbit, in a social space, or offline.';
const slotSchema = z.union([z.number().int().min(0), z.string()]);

function describeLoadout(l: Loadout, inv: InventoryModel) {
  return {
    character: inv.characters.find((c) => c.id === l.characterId)?.className,
    characterId: l.characterId,
    index: l.index,
    name: l.name,
    active: l.active || undefined,
    missingItems: l.items.filter((i) => i.missing).length || undefined,
    items: l.items.map((i) => ({
      id: i.id,
      name: i.name ?? '(missing)',
      slot: i.slot,
      plugs: i.plugs.length ? i.plugs : undefined,
      equipped: i.equipped || undefined,
      missing: i.missing || undefined,
    })),
  };
}

/** Re-reads the saved loadout after a write so results reflect the game, not the request. */
async function reread(ctx: Context, slot: LoadoutSlot): Promise<{ inv: InventoryModel; defs: Defs; loadout?: Loadout }> {
  ctx.profile.invalidate();
  const [inv, defs] = await Promise.all([ctx.profile.inventory(true), ctx.manifest.load()]);
  const character = inv.characters.filter((c) => c.id === slot.characterId);
  return { inv, defs, loadout: buildLoadouts(inv, defs, character).find((l) => l.index === slot.index) };
}

export function registerLoadoutTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'list_loadouts',
    {
      title: 'List saved loadouts',
      description:
        'Lists your saved in-game loadouts (the ones in the Loadouts menu) per character: name, slot index, every item with its saved mods/aspects/fragments, ' +
        'whether it is equipped right now, and which items are missing (dismantled since the loadout was saved). Empty slots are skipped; `freeSlots` lists them.',
      inputSchema: {
        character: z.string().optional().describe('Character id or class name. Default: all characters'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ character }) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const characters = character ? [resolveCharacter(inv, character)] : inv.characters;
      const loadouts = buildLoadouts(inv, defs, characters);
      return ok({
        loadouts: loadouts.map((l) => describeLoadout(l, inv)),
        freeSlots: Object.fromEntries(
          characters.map((c) => {
            const used = new Set(loadouts.filter((l) => l.characterId === c.id).map((l) => l.index));
            const total = inv.raw.characterLoadouts?.data?.[c.id]?.loadouts?.length ?? 0;
            return [c.className, Array.from({ length: total }, (_, i) => i).filter((i) => !used.has(i))];
          }),
        ),
      });
    }),
  );

  server.registerTool(
    'equip_loadout',
    {
      title: 'Equip a saved loadout',
      description:
        'Equips one of your saved in-game loadouts, including its subclass setup, mods and cosmetics. Items in the vault or on other characters are moved over first. ' +
        `Items that no longer exist are skipped by the game. ${ORBIT_NOTE} Changes your real inventory.`,
      inputSchema: {
        loadout: slotSchema.describe('Slot index from list_loadouts, or the loadout name'),
        character: z.string().optional().describe('Character id or class name. Default: most recently played'),
        dryRun: z.boolean().optional().describe('Only show the moves and what would be equipped'),
      },
      annotations: WRITE,
    },
    safe(async ({ loadout, character, dryRun }) => {
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character);
      const plan = planEquipLoadout(inv, defs, resolveSlot(inv, defs, c.id, loadout));
      const summary = {
        character: c.className,
        loadout: `${plan.slot.index}: ${plan.slot.loadout.name}`,
        moves: plan.transfers.steps.map((s) => `${s.item.name}: ${s.action}`),
        problems: plan.transfers.errors.map((e) => e.error),
        missingItems: plan.missing.length || undefined,
        warnings: plan.conflicts.length ? plan.conflicts.map((c) => `The game will skip this: ${c}`) : undefined,
      };
      if (dryRun) return ok({ dryRun: true, alreadyActive: plan.alreadyActive || undefined, ...summary });

      const account = await ctx.account.get();
      try {
        const transfers = await executeTransfers(ctx.http, account, plan.transfers);
        await equipSavedLoadout(ctx.http, account, plan.slot);
        const after = await reread(ctx, plan.slot);
        const notEquipped = after.loadout?.items.filter((i) => !i.equipped && !i.missing).map((i) => i.name ?? i.id) ?? [];
        return ok({
          ...summary,
          transferFailures: transfers.filter((t) => !t.ok).map((t) => `${t.item}: ${t.error}`),
          // The API accepted the request; whether the profile already shows it is a separate question.
          confirmed: !notEquipped.length,
          unconfirmed: notEquipped.length ? notEquipped : undefined,
          note: notEquipped.length ? LAG_NOTE : undefined,
        });
      } finally {
        ctx.profile.invalidate();
      }
    }),
  );

  server.registerTool(
    'save_loadout',
    {
      title: 'Save a loadout',
      description:
        'Saves what a character has equipped right now (gear, subclass, aspects, fragments, mods, cosmetics) into an in-game loadout slot. ' +
        'Pass `items` to equip them first, e.g. the armor from an optimize_armor result; apply any stat mods with apply_plugs before saving so they are included. ' +
        'Defaults to the first empty slot. Replacing a saved loadout needs overwrite: true. Loadout names are limited to the game\'s presets. ' +
        `${ORBIT_NOTE} Changes your real inventory.`,
      inputSchema: {
        slot: slotSchema.optional().describe('Slot index or the name of the loadout to replace. Default: first empty slot'),
        character: z.string().optional().describe('Character id or class name. Default: most recently played'),
        items: z.array(z.string()).max(20).optional().describe('Item ids to equip before saving'),
        name: z.string().optional().describe('Preset loadout name (e.g. Alpha, Beta, Gamma). Default: keep the slot\'s name'),
        overwrite: z.boolean().optional().describe('Required to replace a slot that already holds a loadout'),
        dryRun: z.boolean().optional(),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    safe(async ({ slot: slotRef, character, items, name, overwrite, dryRun }) => {
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character);
      const slot = resolveSlot(inv, defs, c.id, slotRef, { preferEmpty: true });
      const ids = chooseIdentifiers(inv, defs, slot, name);
      const equipPlan = items?.length ? planEquip(inv, defs, c.id, resolveItems(inv, items)) : undefined;

      const summary = {
        character: c.className,
        slot: slot.index,
        name: defs.loadoutName(ids.nameHash)?.name,
        replaces: slot.loadout ? describeLoadout(slot.loadout, inv) : undefined,
        equipFirst: equipPlan?.toEquip.map((i) => i.name),
        fillers: equipPlan?.fillers.length ? equipPlan.fillers.map((f) => `${f.item.name} replaces ${f.replaces.name}`) : undefined,
        problems: equipPlan?.errors.map((e) => e.error),
      };
      if (slot.loadout && !overwrite && !dryRun) {
        throw new UserError(`Slot ${slot.index} already holds "${slot.loadout.name}". Pass overwrite: true to replace it, or omit slot to use a free one.`);
      }
      if (dryRun) return ok({ dryRun: true, ...summary });
      if (equipPlan?.errors.length) throw new UserError(`Nothing was saved. Fix these first: ${equipPlan.errors.map((e) => e.error).join('; ')}`);

      const account = await ctx.account.get();
      try {
        if (equipPlan) {
          const result = await executeEquip(ctx.http, account, c.id, equipPlan);
          const failed = [...result.transfers.filter((t) => !t.ok).map((t) => `${t.item}: ${t.error}`), ...result.equip.filter((e) => !e.ok).map((e) => `${e.item}: equip status ${e.status}`)];
          // Don't snapshot a half-equipped set.
          if (failed.length) throw new UserError(`Nothing was saved because equipping failed: ${failed.join('; ')}`);
        }
        await snapshotToSlot(ctx.http, account, slot, ids);
        const after = await reread(ctx, slot);
        const check = checkSave(
          after.loadout,
          { name: summary.name, itemIds: (equipPlan?.toEquip ?? []).flatMap((i) => (i.instanceId ? [i.instanceId] : [])) },
          (id) => ctx.profile.recentPlugs(id),
          after.defs,
        );
        return ok({
          ...summary,
          replaces: undefined,
          saved: check.saved ? describeLoadout(check.saved, after.inv) : undefined,
          confirmed: check.confirmed,
          note: check.confirmed ? undefined : `The game accepted the save. ${check.modsPending ? OVERLAY_NOTE : LAG_NOTE}`,
        });
      } finally {
        ctx.profile.invalidate();
      }
    }),
  );

  server.registerTool(
    'rename_loadout',
    {
      title: 'Rename a loadout',
      description: `Changes a saved loadout's name to one of the game's preset names. Lists the allowed names if the one given isn't allowed.`,
      inputSchema: {
        loadout: slotSchema.describe('Slot index or current name'),
        name: z.string().describe('New preset name, e.g. Alpha, Beta, Gamma'),
        character: z.string().optional().describe('Character id or class name. Default: most recently played'),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    safe(async ({ loadout, name, character }) => {
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character);
      const slot = resolveSlot(inv, defs, c.id, loadout);
      if (!slot.loadout) throw new UserError(`Loadout slot ${slot.index} is empty.`);
      const account = await ctx.account.get();
      try {
        await renameSlot(ctx.http, account, slot, chooseIdentifiers(inv, defs, slot, name));
        const after = await reread(ctx, slot);
        const confirmed = after.loadout?.name === defs.loadoutName(chooseIdentifiers(inv, defs, slot, name).nameHash)?.name;
        return ok({ character: c.className, slot: slot.index, from: slot.loadout.name, requested: name, confirmed, note: confirmed ? undefined : `The game accepted the rename. ${LAG_NOTE}` });
      } finally {
        ctx.profile.invalidate();
      }
    }),
  );

  server.registerTool(
    'clear_loadout',
    {
      title: 'Delete a saved loadout',
      description: 'Empties a loadout slot. The saved loadout cannot be recovered afterwards; gear itself is untouched. Use dryRun to see what would be deleted.',
      inputSchema: {
        loadout: slotSchema.describe('Slot index or name'),
        character: z.string().optional().describe('Character id or class name. Default: most recently played'),
        dryRun: z.boolean().optional(),
      },
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    safe(async ({ loadout, character, dryRun }) => {
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character);
      const slot = resolveSlot(inv, defs, c.id, loadout);
      if (!slot.loadout) throw new UserError(`Loadout slot ${slot.index} is already empty.`);
      const deleting = describeLoadout(slot.loadout, inv);
      if (dryRun) return ok({ dryRun: true, wouldDelete: deleting });
      const account = await ctx.account.get();
      try {
        await clearSlot(ctx.http, account, slot);
        const after = await reread(ctx, slot);
        const confirmed = !after.loadout;
        return ok({ deleted: deleting.name, slot: slot.index, character: c.className, confirmed, note: confirmed ? undefined : `The game accepted the delete. ${LAG_NOTE}` });
      } finally {
        ctx.profile.invalidate();
      }
    }),
  );
}
