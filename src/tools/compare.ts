import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { namedStats, statTotal, type InventoryModel, type Item } from '../inventory/model.js';
import type { Defs } from '../manifest/defs.js';
import { armorStatInfo, weaponPerkInfo } from './inventory.js';
import { READ_ONLY, UserError, briefItem, itemLabel, ok, resolveItems, safe } from './util.js';

const MAX_ITEMS = 6;
/** Stats where a lower value is better. */
const LOWER_IS_BETTER = new Set(['Charge Time', 'Draw Time']);
/** Stats where neither direction is better. */
const NO_BEST = new Set(['Rounds Per Minute']);
/** The power level shows up among live stats; it is already in the item header. */
const POWER_STATS = new Set(['Power', 'Attack', 'Defense']);

export interface ComparisonEntry {
  label: string;
  stats: Record<string, number>;
  /** Equipped perk per column, in column order. */
  perks: string[];
}

export interface StatRow {
  stat: string;
  values: (number | null)[];
  /** Index into the compared items of the single best value; absent on ties or when no direction is better. */
  best?: number;
}

export interface PerkRow {
  column: number;
  values: (string | null)[];
}

/** Lines up stats and perks of the given items (in the given order) and lists what differs. */
export function buildComparison(entries: ComparisonEntry[]) {
  const statNames: string[] = [];
  for (const e of entries) for (const name of Object.keys(e.stats)) if (!statNames.includes(name)) statNames.push(name);

  const differing: StatRow[] = [];
  const same: StatRow[] = [];
  const differences: string[] = [];
  for (const stat of statNames) {
    const values = entries.map((e) => e.stats[stat] ?? null);
    const present = values.filter((v): v is number => v !== null);
    const differs = present.length !== values.length || new Set(present).size > 1;
    const row: StatRow = { stat, values };
    if (!differs) {
      same.push(row);
      continue;
    }
    const lower = LOWER_IS_BETTER.has(stat);
    const top = lower ? Math.min(...present) : Math.max(...present);
    const bottom = lower ? Math.max(...present) : Math.min(...present);
    const topAt = values.flatMap((v, i) => (v === top ? [i] : []));
    if (!NO_BEST.has(stat) && topAt.length === 1) row.best = topAt[0];
    differing.push(row);
    const hi = values.indexOf(top);
    const lo = values.indexOf(bottom);
    if (hi !== lo) differences.push(`${stat}: ${top} (${entries[hi].label}) vs ${bottom} (${entries[lo].label})`);
  }

  const columns = Math.max(0, ...entries.map((e) => e.perks.length));
  const perkRows: PerkRow[] = [];
  for (let c = 0; c < columns; c++) {
    const values = entries.map((e) => e.perks[c] ?? null);
    perkRows.push({ column: c + 1, values });
    if (new Set(values).size > 1) {
      differences.push(`Column ${c + 1}: ${values.map((v, i) => `${v ?? 'none'} (${entries[i].label})`).join(' / ')}`);
    }
  }
  return { statRows: [...differing, ...same], perkRows, differences };
}

/** Refuses comparisons across kinds (weapons vs armor) and of anything that is neither. */
export function assertComparable(items: Item[]): 'weapon' | 'armor' {
  const kinds = new Set(items.map((i) => i.kind));
  if (kinds.size > 1) throw new UserError(`Can't compare weapons with armor: ${items.map((i) => `${i.name} (${i.kind})`).join(', ')}`);
  const kind = items[0]?.kind;
  if (kind !== 'weapon' && kind !== 'armor') throw new UserError(`Only weapons or armor can be compared; ${items[0]?.name} is ${kind}.`);
  return kind;
}

function comparisonEntry(item: Item, defs: Defs): ComparisonEntry {
  const label = itemLabel(item, defs);
  if (item.armor) {
    const stats = namedStats(item.armor.noMods, defs);
    stats.Total = statTotal(item.armor.noMods);
    stats['Total (masterworked)'] = statTotal(item.armor.masterworked);
    return { label, stats, perks: [] };
  }
  const stats = Object.fromEntries(Object.entries(item.stats).filter(([name]) => !POWER_STATS.has(name)));
  return { label, stats, perks: item.weapon?.perks.map((c) => c.equipped.name) ?? [] };
}

/** All owned copies matching a name: exact name first, then substring. Highest power first. */
function copiesByName(inv: InventoryModel, query: string): Item[] {
  const q = query.trim().toLowerCase();
  const owned = inv.items.filter((i) => i.instanceId && (i.kind === 'weapon' || i.kind === 'armor'));
  const exact = owned.filter((i) => i.name.toLowerCase() === q);
  const matches = exact.length ? exact : owned.filter((i) => i.name.toLowerCase().includes(q));
  return matches.sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || a.instanceId!.localeCompare(b.instanceId!));
}

export function registerCompareTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'compare_items',
    {
      title: 'Compare items',
      description:
        'Side-by-side comparison of 2–6 weapons (or 2–6 armor pieces): stats aligned per row with the best value marked, equipped perks per column, and a short list of differences. ' +
        'Pass item ids, or a name in `query` to compare every copy you own. Items are returned in the order given; refer to them by their label.',
      inputSchema: {
        items: z.array(z.string()).min(2).max(MAX_ITEMS).optional().describe('Item ids (preferred) or unique names'),
        query: z.string().optional().describe('Item name: compares every owned copy (up to 6, highest power first)'),
        live: z.boolean().optional().describe('Read the items fresh from Bungie (default true)'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ items: refs, query, live }) => {
      if (!refs === !query) throw new UserError('Pass either `items` (2–6 ids) or `query` (an item name), not both.');
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      let note: string | undefined;
      let items: Item[];
      if (refs) items = resolveItems(inv, refs);
      else {
        const all = copiesByName(inv, query!);
        if (all.length < 2) throw new UserError(`"${query}" matches ${all.length} owned weapon/armor item${all.length === 1 ? '' : 's'}; need at least 2 to compare.`);
        items = all.slice(0, MAX_ITEMS);
        if (all.length > MAX_ITEMS) note = `${all.length} copies match; compared the ${MAX_ITEMS} with the highest power.`;
      }
      assertComparable(items);
      if (live !== false) for (const item of items) await ctx.profile.refreshItem(inv, item);

      const comparison = buildComparison(items.map((i) => comparisonEntry(i, defs)));
      return ok({
        note,
        items: items.map((item) => {
          const out: Record<string, unknown> = { ...briefItem(item, inv, defs) };
          if (item.weapon) {
            out.stats = comparisonEntry(item, defs).stats;
            out.perks = weaponPerkInfo(item, defs).map((c) => ({ column: c.column, type: c.type, equipped: c.equipped, options: c.options.map((o) => o.name) }));
            out.masterwork = item.weapon.masterwork?.name;
            out.mod = item.weapon.mod?.name;
          } else if (item.armor) {
            const { withoutMods, fullyMasterworked, totalWithoutMods, totalMasterworked } = armorStatInfo(item.armor, defs);
            out.stats = { withoutMods, fullyMasterworked, totalWithoutMods, totalMasterworked };
            out.mods = item.armor.mods.map((m) => m.name);
            out.tuning = item.armor.tuning?.name;
            delete out.statTotal;
          }
          return out;
        }),
        ...comparison,
      });
    }),
  );
}
