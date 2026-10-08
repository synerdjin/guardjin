import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { defaultSleep } from '../bungie/http.js';
import { applyPlugChanges, livePreparer, socketOwnership } from '../sockets/apply.js';
import { currentPlugProgress, executePlugChanges, itemSockets, socketOptions, type PlugChange } from '../sockets/plugs.js';
import { READ_ONLY, WRITE, ok, resolveItem, safe } from './util.js';

const MAX_OPTIONS = 40;

const MAX_WAIT_SECONDS = 180;

function describeChanges(changes: PlugChange[]) {
  return changes.map((c) => ({
    item: c.item.name,
    id: c.item.instanceId,
    socket: c.socketIndex,
    category: c.category || undefined,
    insert: c.plug.name,
    replaces: c.replaces,
    energy: c.energy ? `${c.energy.used}/${c.energy.capacity}` : undefined,
  }));
}

export function registerSocketTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'get_item_sockets',
    {
      title: 'Item sockets',
      description:
        'Lists an item\'s sockets by index with the current plug and whether apply_plugs can change it. With `socket`, lists the plugs you can insert there ' +
        '(unlocked mods, shaders, ornaments, or a weapon\'s rolled perk options). Use it to pick socket indexes for apply_plugs.',
      inputSchema: {
        item: z.string().describe('Item id or unique name'),
        socket: z.number().int().min(0).optional().describe('Show insertable options for this socket'),
        query: z.string().optional().describe('With socket: filter options by name'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ item: ref, socket, query }) => {
      const [inv, defs] = await Promise.all([ctx.profile.inventory(), ctx.manifest.load()]);
      const item = resolveItem(inv, ref);
      const [ownership] = await Promise.all([socket === undefined ? undefined : socketOwnership(ctx.profile, inv, defs, item, socket), ctx.profile.refreshItem(inv, item)]);
      const sockets = itemSockets(inv, defs, item);
      const energy = item.armor?.energy;
      if (socket === undefined) {
        return ok({
          item: item.name,
          id: item.instanceId,
          energy: energy ? `${energy.used}/${energy.capacity}` : undefined,
          sockets: sockets.map((s) => {
            const progress = currentPlugProgress(inv, defs, item, s.current?.hash);
            return { index: s.index, category: s.category || undefined, current: s.current?.name, changeable: s.changeable, progress: progress.length ? progress : undefined };
          }),
        });
      }
      const target = sockets.find((s) => s.index === socket);
      if (!target) return ok({ item: item.name, error: `No visible socket ${socket}. Sockets: ${sockets.map((s) => s.index).join(', ')}` });
      const q = query?.trim().toLowerCase();
      const options = socketOptions(inv, defs, item, socket, ownership)
        .map((o) => {
          const d = defs.item(o.hash);
          return { name: d?.displayProperties.name || `#${o.hash}`, canInsert: o.canInsert, reasons: o.reasons, progress: o.progress, ownership: o.ownership, staleProfile: o.staleProfile, cost: d?.plug?.energyCost?.energyCost || undefined, current: o.hash === target.current?.hash || undefined, fits: d?.plug ? target.accepts.has(d.plug.plugCategoryHash) : false };
        })
        .filter((o) => o.fits && o.name && (!q || o.name.toLowerCase().includes(q)))
        .sort((a, b) => Number(b.canInsert) - Number(a.canInsert) || a.name.localeCompare(b.name));
      return ok({
        item: item.name,
        socket,
        category: target.category || undefined,
        current: target.current?.name,
        currentProgress: currentPlugProgress(inv, defs, item, target.current?.hash).filter((p) => p.description || p.progress),
        changeable: target.changeable,
        totalOptions: options.length,
        options: options.slice(0, MAX_OPTIONS).map(({ fits: _f, canInsert, reasons, progress, ownership: own, staleProfile, ...o }) => ({
          ...o,
          owned: own?.owned,
          price: own?.price,
          note: staleProfile ? "bought (the vendor shows it owned), but Bungie's profile data still blocks it; apply_plugs will try it and the game decides" : undefined,
          canInsert: canInsert || undefined,
          blocked: !canInsert || undefined,
          reasons: reasons.length ? reasons : undefined,
          progress: !canInsert && progress.length ? progress : undefined,
        })),
        more: options.length > MAX_OPTIONS ? 'Narrow with query to see the rest.' : undefined,
      });
    }),
  );

  server.registerTool(
    'apply_plugs',
    {
      title: 'Equip mods, perks, aspects, fragments, shaders and ornaments',
      description:
        'Equips mods and other socketed options: armor mods (including +5/+10 stat mods from optimize_armor), weapon mods, switching a weapon perk to another option it rolled, ' +
        'subclass setup (super, grenade, melee, class ability, jump, aspects, fragments; pass the subclass item id), shaders, ornaments and armor tuning. ' +
        'Only free, reversible changes: masterworks, catalysts, mementos and other costly plugs are refused. Checks that the plug fits, is unlocked, and fits in armor energy. ' +
        'Without `socket`, a plug goes into an empty compatible socket (or the only compatible one). `remove: true` empties a socket. Swapping an aspect can change how many fragment slots are open. ' +
        'For aspects and fragments the Aspects/Fragments vendors decide what is unlocked, because Bungie\'s profile data is unreliable for them: a plug the vendor shows bought is tried even when the profile still blocks it, one that is not bought is refused with its price, and a rejected insert says which it was. ' +
        'Use get_item_sockets to see sockets and options. The character must be in orbit, in a social space, or offline. Changes your real gear; use dryRun first.',
      inputSchema: {
        changes: z
          .array(
            z.object({
              item: z.string().describe('Item id or unique name'),
              plug: z.string().optional().describe('Plug name (e.g. "Grenade Mod", "Backup Mag", "Firefly", "Echo of Persistence", "Chaos Accelerant") or hash; with remove, the plug to take out'),
              socket: z.number().int().min(0).optional().describe('Socket index from get_item_sockets'),
              remove: z.boolean().optional().describe('Reset the socket to empty'),
            }),
          )
          .min(1)
          .max(30),
        dryRun: z.boolean().optional(),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(
            "Keep retrying for up to this many seconds (every 15) when the game rejects an insert while Bungie's data catches up, e.g. just after an equip or a purchase. " +
              'Aspects and fragments are retried only when a vendor shows them bought; plugs that are not owned, do not fit or exceed armor energy are never retried. Ignored with dryRun. Default 0.',
          ),
      },
      annotations: WRITE,
    },
    safe(async ({ changes, dryRun, waitSeconds }, extra) => {
      const outcome = await applyPlugChanges(
        {
          prepare: livePreparer(ctx.profile, ctx.manifest, resolveItem),
          execute: async (plan) => {
            const account = await ctx.account.get();
            try {
              const results = await executePlugChanges(ctx.http, account, plan);
              for (const r of results) if (r.ok) ctx.profile.recordPlug(r.itemId, r.socket, r.plugHash, r.energyUsed);
              return results;
            } finally {
              ctx.profile.invalidate();
            }
          },
          sleep: defaultSleep,
          onWait: async (waited, total) => {
            const progressToken = extra._meta?.progressToken;
            if (progressToken === undefined) return;
            await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: waited, total, message: "Waiting for Bungie's data to catch up" } });
          },
        },
        changes,
        { dryRun, waitSeconds },
      );

      const wrote = !dryRun && outcome.changes.length > 0;
      const applied = outcome.results.filter((r) => r.ok).length;
      const failed = outcome.results.filter((r) => !r.ok).map(({ itemId: _i, plugHash: _p, energyUsed: _e, ...rest }) => rest);
      return ok({
        dryRun: dryRun || undefined,
        changes: describeChanges(outcome.changes),
        unchanged: outcome.unchanged.length ? outcome.unchanged : undefined,
        errors: outcome.errors.length ? outcome.errors : undefined,
        applied: wrote ? applied : undefined,
        failed: wrote && failed.length ? failed : undefined,
        note: wrote && applied ? "The game accepted the change. Bungie's data can take a minute to show it, but this tool remembers it meanwhile." : undefined,
        waitedSeconds: outcome.waitedSeconds || undefined,
        resolvedAfterWait: outcome.resolvedAfterWait.length ? outcome.resolvedAfterWait : undefined,
      });
    }),
  );
}
