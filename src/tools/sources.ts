import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DestinyComponentType, type DestinyCollectibleDefinition } from 'bungie-api-ts/destiny2';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ItemType, Rarity } from '../inventory/constants.js';
import { locationLabel, type InventoryModel } from '../inventory/model.js';
import type { Defs } from '../manifest/defs.js';
import { isCollected } from '../progress/collections.js';
import { buildCraftables } from '../progress/craftables.js';
import { publicVendorOffers, type VendorOffer } from '../world/vendors.js';
import { READ_ONLY, UserError, ok, safe } from './util.js';

const decoder = new TextDecoder();
const MAX_ROWS = 200;

/** Weapon and armor definitions with this exact name (reissues and variants share a name). */
function gearDefsNamed(defs: Defs, name: string) {
  const rows = defs.searchItems({ query: name, itemTypes: [ItemType.Weapon, ItemType.Armor], limit: 60 });
  const exact = rows.filter((r) => r.name.toLowerCase() === name.trim().toLowerCase());
  return exact.length ? exact : rows.slice(0, 1);
}

interface WantedEntry {
  name: string;
  note?: string;
  addedAt: string;
}

function wantedFile(ctx: Context) {
  return join(ctx.config.homeDir, 'wanted.json');
}
function readWanted(ctx: Context): WantedEntry[] {
  const f = wantedFile(ctx);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as WantedEntry[]) : [];
}

/** Checks each wanted item against current vendor stock. */
export async function checkWanted(ctx: Context, defs: Defs, offers?: Map<number, VendorOffer[]>) {
  const wanted = readWanted(ctx);
  if (!wanted.length) return { wanted: 0, hits: [] as { name: string; note?: string; offers: VendorOffer[] }[] };
  const stock = offers ?? (await publicVendorOffers(ctx.http, defs));
  const hits = wanted.flatMap((w) => {
    const found = gearDefsNamed(defs, w.name).flatMap((d) => stock.get(d.hash) ?? []);
    return found.length ? [{ name: w.name, note: w.note, offers: found }] : [];
  });
  return { wanted: wanted.length, hits };
}

function refreshOwnedTable(defs: Defs, inv: InventoryModel): number {
  defs.db.exec(`CREATE TEMP TABLE IF NOT EXISTS owned_items (
    instance_id TEXT PRIMARY KEY, hash INTEGER, name TEXT, kind TEXT, slot TEXT, tier INTEGER, power INTEGER, element TEXT, location TEXT, locked INTEGER
  )`);
  defs.db.exec('DELETE FROM temp.owned_items');
  const insert = defs.db.prepare('INSERT INTO temp.owned_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let n = 0;
  for (const i of inv.items) {
    if (!i.instanceId) continue;
    insert.run(i.instanceId, i.hash | 0, i.name, i.kind, i.slot, i.gearTier ?? null, i.power ?? null, i.weapon?.element ?? null, locationLabel(i.location, inv.characters), i.locked ? 1 : 0);
    n++;
  }
  return n;
}

/** Validates a query_manifest statement: one SELECT/WITH, no writes. Returns it without a trailing semicolon. */
export function readOnlySql(sql: string): string {
  const text = sql.trim().replace(/;\s*$/, '');
  const code = text.replace(/'(?:[^']|'')*'/g, "''");
  if (!/^(select|with)\b/i.test(text)) throw new UserError('Only a single SELECT (or WITH … SELECT) statement is allowed.');
  if (code.includes(';')) throw new UserError('Only one statement is allowed.');
  if (/\b(insert|update|delete|drop|create|alter|attach|detach|pragma|vacuum)\b/i.test(code)) throw new UserError('Only read-only queries are allowed.');
  return text;
}

export function registerSourceTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'find_source',
    {
      title: 'Where to get an item',
      description:
        'Where a weapon or armor piece comes from: its collection source text, whether you own it or have it in Collections, whether you can craft it, and whether any vendor (including Xûr and his Strange Gear offers) sells it right now.',
      inputSchema: { item: z.string().describe('Item name, e.g. "Until Its Return"') },
      annotations: READ_ONLY,
    },
    safe(async ({ item }) => {
      const defs = await ctx.manifest.load();
      const rows = gearDefsNamed(defs, item);
      if (!rows.length) throw new UserError(`No weapon or armor named "${item}". lookup_definition can search more broadly.`);
      const name = rows[0].name;
      const [inv, profile, offers, dimSources] = await Promise.all([
        ctx.profile.inventory(),
        ctx.profile.components([DestinyComponentType.Collectibles, DestinyComponentType.Craftables]),
        publicVendorOffers(ctx.http, defs).catch(() => undefined),
        ctx.community.get<Record<string, string>>('sources'),
      ]);
      const charIds = inv.characters.map((c) => c.id);
      const hashes = new Set(rows.map((r) => r.hash));
      const sources = new Set<string>();
      let collected: boolean | undefined;
      for (const r of rows) {
        const col = defs.collectible(defs.item(r.hash)?.collectibleHash) as DestinyCollectibleDefinition | undefined;
        const text = col?.sourceString?.trim() || (col?.sourceHash ? dimSources?.[String(col.sourceHash)] : undefined);
        if (text) sources.add(text);
        const c = isCollected(profile, col?.hash, charIds);
        if (c !== undefined) collected = (collected ?? false) || c;
      }
      const owned = inv.items.filter((i) => hashes.has(i.hash) || i.name === name);
      const pattern = buildCraftables(profile, defs).find((c) => c.name === name);
      const forSale = [...hashes].flatMap((h) => offers?.get(h) ?? []);
      return ok({
        name,
        type: rows[0].typeName,
        rarity: Rarity[rows[0].tierType],
        sources: sources.size ? [...sources] : ['No source text in the game data; it may be a world drop or no longer available.'],
        collected,
        owned: owned.length ? owned.map((i) => ({ id: i.instanceId, tier: i.gearTier, power: i.power, location: locationLabel(i.location, inv.characters), locked: i.locked || undefined })) : undefined,
        craftable: pattern ? (pattern.unlocked ? true : { unlocked: false, reasons: pattern.reasons }) : undefined,
        forSaleNow: offers ? (forSale.length ? forSale : false) : 'vendor stock unavailable right now',
      });
    }),
  );

  server.registerTool(
    'wanted_items',
    {
      title: 'Wanted items',
      description:
        'A watch list of items you are hunting (kept in ~/.guardjin/wanted.json). action add/remove/list edits it; check looks for them in every vendor\'s current stock (Xûr, Strange Gear offers, Banshee, Ada...). ' +
        'Good for a weekly check after reset.',
      inputSchema: {
        action: z.enum(['list', 'add', 'remove', 'check']),
        items: z.array(z.string()).optional().describe('Item names for add/remove'),
        note: z.string().optional().describe('Why you want it, e.g. "want Auto-Loading Holster + Trench Barrel"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ action, items, note }) => {
      const defs = await ctx.manifest.load();
      let list = readWanted(ctx);
      if (action === 'add' || action === 'remove') {
        if (!items?.length) throw new UserError('Pass items to add or remove.');
        for (const raw of items) {
          if (action === 'add') {
            const found = gearDefsNamed(defs, raw);
            const name = found[0]?.name ?? raw;
            if (!list.some((w) => w.name.toLowerCase() === name.toLowerCase())) list.push({ name, note, addedAt: new Date().toISOString() });
          } else list = list.filter((w) => w.name.toLowerCase() !== raw.trim().toLowerCase());
        }
        writeFileSync(wantedFile(ctx), JSON.stringify(list, null, 2));
      }
      if (action === 'check') return ok(await checkWanted(ctx, defs));
      return ok({ file: wantedFile(ctx), wanted: list });
    }),
  );

  server.registerTool(
    'query_manifest',
    {
      title: 'Query game data (SQL)',
      description:
        'Runs one read-only SELECT against the local Destiny game database (SQLite) for questions no other tool answers, e.g. "every Void machine gun that can roll Destabilizing Rounds that I don\'t own". ' +
        'Tables are Bungie\'s Destiny*Definition tables with columns (id INTEGER = signed 32-bit hash, json BLOB); read fields with json_extract(CAST(json AS TEXT), \'$.displayProperties.name\'). ' +
        'Hashes inside json are unsigned: join with id = sid(<hash>), and uid(id) gives the unsigned hash. ' +
        'Helpful: guardjin_item_index(hash, name, name_lower, type_name, item_type, tier_type, class_type) for fast name lookups (item_type 3 = weapon, 2 = armor; tier_type 6 = exotic); ' +
        'temp.owned_items(instance_id, hash, name, kind, slot, tier, power, element, location, locked) is your current inventory (hash is signed like id). ' +
        'Weapon perk pools: DestinyInventoryItemDefinition $.sockets.socketEntries[*].randomizedPlugSetHash → DestinyPlugSetDefinition $.reusablePlugItems[*].plugItemHash. ' +
        `Results are capped at ${MAX_ROWS} rows; json columns come back parsed.`,
      inputSchema: {
        sql: z.string().describe('A single SELECT (or WITH … SELECT) statement'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ sql }) => {
      const text = readOnlySql(sql);
      const defs = await ctx.manifest.load();
      const inv = await ctx.profile.inventory();
      refreshOwnedTable(defs, inv);
      let rows: Record<string, unknown>[];
      try {
        rows = defs.db.prepare(`SELECT * FROM (${text}) LIMIT ${MAX_ROWS + 1}`).all() as Record<string, unknown>[];
      } catch (err) {
        throw new UserError(`SQL error: ${(err as Error).message}`);
      }
      const decode = (v: unknown) => {
        if (v instanceof Uint8Array) v = decoder.decode(v);
        if (typeof v === 'string' && /^[[{]/.test(v)) {
          try {
            return JSON.parse(v);
          } catch {
            return v;
          }
        }
        return v;
      };
      const out = rows.slice(0, MAX_ROWS).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, decode(v)])));
      const json = JSON.stringify(out);
      return ok({
        rows: json.length > 200_000 ? `${out.length} rows (${json.length} characters) is too much to return; select fewer columns or add LIMIT.` : out,
        truncated: rows.length > MAX_ROWS || undefined,
      });
    }),
  );
}
