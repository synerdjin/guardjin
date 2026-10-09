import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getPublicMilestones } from 'bungie-api-ts/destiny2';
import { z } from 'zod';
import { weaponChampion } from '../builds/champions.js';
import { characterStats, equippedOn } from '../builds/spec.js';
import { unwrap } from '../bungie/http.js';
import type { Context } from '../context.js';
import { ARMOR_STATS } from '../inventory/constants.js';
import { describeSubclass } from '../inventory/subclass.js';
import { characterArtifacts } from '../progress/artifact.js';
import { buildWallet } from '../progress/currencies.js';
import { vaultSummary } from '../vault/analysis.js';
import { buildWeekly } from '../world/weekly.js';
import { publicVendorOffers, vendorPresent } from '../world/vendors.js';
import { checkWanted } from './sources.js';
import { diffAgainstSnapshot } from './tracking.js';
import { READ_ONLY, ok, safe } from './util.js';

/** Currencies worth a glance at the start of a session, in display order. */
const KEY_CURRENCIES = ['Glimmer', 'Bright Dust', 'Strange Coin', 'Enhancement Core', 'Enhancement Prism', 'Ascendant Shard', 'Ascendant Alloy', 'Upgrade Module', 'Spoils of Conquest', 'Legendary Shards'];

export function registerBriefTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'session_brief',
    {
      title: 'Session brief',
      description:
        'Start-of-session overview in one call: every character\'s power and subclass; the main character\'s equipped weapons (with champion types), exotic, artifact and stats; key currencies; vault and postmaster space; ' +
        'this week\'s featured activities; whether Xûr is here and whether any vendor sells an item on your wanted list; and what changed since the last brief (new drops, dismantles, power and currency changes). ' +
        'Call this first in a Destiny conversation, then drill down with the specific tools.',
      inputSchema: {
        character: z.string().optional().describe('Character to detail (default: most recently played)'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ character }) => {
      const inv = await ctx.profile.inventory(true);
      const defs = await ctx.manifest.load();
      const main = character ? inv.characters.find((c) => c.id === character || c.classType === character.toLowerCase()) ?? inv.characters[0] : inv.characters[0];

      const characters = inv.characters.map((c) => {
        const sub = equippedOn(inv, c.id).find((i) => i.kind === 'subclass');
        return { class: c.className, id: c.id, power: c.light, subclass: sub?.name, lastPlayed: c.lastPlayed };
      });
      const eq = main ? equippedOn(inv, main.id) : [];
      const stats = main ? characterStats(inv, main.id) : undefined;
      const statNames = Object.fromEntries(ARMOR_STATS.map((s) => [s.key, defs.stat(s.hash)?.displayProperties.name ?? s.key]));
      const sub = eq.find((i) => i.kind === 'subclass');
      const subSummary = sub ? describeSubclass(sub, inv, defs, false) : undefined;
      const artifact = main ? characterArtifacts(inv, main.id).find((a) => a.equipped) : undefined;

      const wallet = buildWallet(inv.raw, defs);
      const all = [...wallet.currencies, ...wallet.materials];
      const currencies = KEY_CURRENCIES.flatMap((n) => {
        const h = all.find((x) => x.name === n);
        return h ? [`${h.name}: ${h.quantity}`] : [];
      });

      const vault = vaultSummary(inv, defs);
      const [milestones, offers] = await Promise.all([
        unwrap(getPublicMilestones(ctx.http)).catch(() => undefined),
        publicVendorOffers(ctx.http, defs).catch(() => undefined),
      ]);
      const weekly = milestones
        ? buildWeekly(milestones, defs)
            .filter((m) => m.activities.length)
            .slice(0, 16)
            .map((m) => {
              // "Vow of the Disciple: Master" under the "Vow of the Disciple" milestone → "Master"; Standard is implied.
              const variants = [...new Set(m.activities.map((a) => (a.name.startsWith(`${m.name}:`) ? a.name.slice(m.name.length + 1).trim() : a.name)))].filter(
                (v) => v !== m.name && !/^(Standard|Normal)$/i.test(v),
              );
              return `${m.name}${variants.length ? ` (${variants.slice(0, 3).join(', ')})` : ''}${m.ends ? `, until ${m.ends.slice(0, 10)}` : ''}`;
            })
        : undefined;
      const wanted = offers ? await checkWanted(ctx, defs, offers).catch(() => undefined) : undefined;

      let sinceLast: Record<string, unknown> | undefined;
      const store = ctx.store;
      if (store) {
        const lastBrief = Number(store.getMeta('last_brief') ?? 0) || undefined;
        if (lastBrief) {
          const { added, gone } = store.changesSince(lastBrief);
          const snap = store.snapshotAt(lastBrief);
          const diff = snap ? diffAgainstSnapshot(store, snap.id, inv, wallet.currencies) : undefined;
          sinceLast = {
            since: new Date(lastBrief).toISOString(),
            newDrops: added.length ? added.slice(0, 15).map((a) => a.name) : undefined,
            newDropCount: added.length || undefined,
            gone: gone.length ? gone.slice(0, 15).map((g) => g.name) : undefined,
            power: diff?.power.length ? diff.power : undefined,
            currencies: diff?.currencies.length ? diff.currencies : undefined,
          };
        }
        store.setMeta('last_brief', String(Date.now()));
      }

      return ok({
        characters,
        main: main && {
          class: main.className,
          subclass: subSummary && {
            name: subSummary.name,
            super: subSummary.sections.find((s) => s.category.toUpperCase() === 'SUPER')?.equipped[0]?.name,
            aspects: subSummary.sections.find((s) => s.category.toUpperCase() === 'ASPECTS')?.equipped.map((p) => p.name),
          },
          weapons: eq.filter((i) => i.kind === 'weapon').map((w) => `${w.name} (${[w.weapon?.element, w.typeName, weaponChampion(inv, defs, w)].filter(Boolean).join(', ')})`),
          exoticArmor: eq.find((i) => i.kind === 'armor' && i.isExotic)?.name,
          artifact: artifact?.name,
          stats: stats && Object.fromEntries(Object.entries(stats).map(([k, v]) => [statNames[k], v])),
        },
        currencies,
        vault: `${vault.vault.used}/${vault.vault.capacity}`,
        fullBuckets: vault.characters.filter((c) => c.full.length).map((c) => `${c.className}: ${c.full.join(', ')}`),
        postmaster: vault.postmaster.filter((p) => p.count > 0).map((p) => `${p.className}: ${p.count}/${p.capacity}`),
        weekly,
        xur: offers ? vendorPresent(offers, 'Xûr') : undefined,
        wantedForSale: wanted?.hits.length ? wanted.hits.map((h) => `${h.name}: ${h.offers.map((o) => `${o.vendor}${o.cost ? ` (${o.cost.join(', ')})` : ''}`).join('; ')}`) : undefined,
        sinceLastBrief: sinceLast,
      });
    }),
  );
}
