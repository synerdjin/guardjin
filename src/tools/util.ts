import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BungieApiError, NotAuthenticatedError } from '../bungie/http.js';
import { UserError } from '../errors.js';
import { ARMOR_BUCKETS, ARMOR_STAT_KEYS, ARMOR_STATS, type ArmorStatKey } from '../inventory/constants.js';
import { locationLabel, namedStats, statTotal, type Character, type InventoryModel, type Item } from '../inventory/model.js';
import type { Defs } from '../manifest/defs.js';
import { weaponChampion } from '../builds/champions.js';

export { UserError };

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Wraps a tool handler so failures come back as readable tool errors instead of protocol errors. */
export function safe<A extends unknown[]>(fn: (...args: A) => Promise<CallToolResult>) {
  return async (...args: A): Promise<CallToolResult> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof NotAuthenticatedError) return fail(err.message);
      if (err instanceof BungieApiError) return fail(`Bungie API error ${err.errorStatus} (${err.errorCode}): ${err.message}`);
      if (err instanceof UserError) return fail(err.message);
      console.error('[guardjin] tool error:', err);
      return fail(`Unexpected error: ${(err as Error).message ?? String(err)}`);
    }
  };
}


export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export const statKeySchema = z.enum(ARMOR_STAT_KEYS as [ArmorStatKey, ...ArmorStatKey[]]);
export const statMapSchema = z
  .object(Object.fromEntries(ARMOR_STAT_KEYS.map((k) => [k, z.number().min(0).max(200).optional()])) as Record<ArmorStatKey, z.ZodOptional<z.ZodNumber>>)
  .partial();

/** Converts { grenade: 100 } into a stat vector ordered like ARMOR_STATS. */
export function statMapToVector(map: Partial<Record<ArmorStatKey, number>> | undefined, fallback: number): number[] {
  return ARMOR_STATS.map((s) => map?.[s.key] ?? fallback);
}

export function statKeyNames(defs: Defs): Record<ArmorStatKey, string> {
  return Object.fromEntries(ARMOR_STATS.map((s) => [s.key, defs.stat(s.hash)?.displayProperties.name ?? s.key])) as Record<ArmorStatKey, string>;
}

/**
 * Resolves a character reference: an id, a class name ("warlock"), or undefined for the most
 * recently played character.
 */
export function resolveCharacter(inv: Pick<InventoryModel, 'characters'>, ref: string | undefined): Character {
  if (!inv.characters.length) throw new UserError('This account has no characters.');
  if (!ref) return inv.characters[0];
  const r = ref.trim().toLowerCase();
  const match = inv.characters.find((c) => c.id === ref || c.classType === r || c.className.toLowerCase() === r);
  if (!match) {
    throw new UserError(
      `No character matches "${ref}". Characters: ${inv.characters.map((c) => `${c.className} (${c.id})`).join(', ')}`,
    );
  }
  return match;
}

/** Resolves an item by instance id, or by name when that name is unique. */
export function resolveItem(inv: InventoryModel, ref: string): Item {
  const byId = inv.byId.get(ref.trim());
  if (byId) return byId;
  const q = ref.trim().toLowerCase();
  const exact = inv.items.filter((i) => i.instanceId && i.name.toLowerCase() === q);
  const matches = exact.length ? exact : inv.items.filter((i) => i.instanceId && i.name.toLowerCase().includes(q));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new UserError(`No item matches "${ref}". Use search_inventory to find item ids.`);
  throw new UserError(
    `"${ref}" matches ${matches.length} items; pass an item id instead. Candidates: ${matches
      .slice(0, 10)
      .map((m) => `${m.name} [${m.instanceId}] (${locationLabel(m.location, inv.characters)}${m.power ? `, ${m.power}` : ''})`)
      .join('; ')}`,
  );
}

export function resolveItems(inv: InventoryModel, refs: string[]): Item[] {
  return refs.map((r) => resolveItem(inv, r));
}

/** Compact item summary used in list results. */
export function briefItem(item: Item, inv: InventoryModel, defs: Defs, opts: { masterworkedStats?: boolean } = {}) {
  const out: Record<string, unknown> = {
    id: item.instanceId,
    name: item.name,
    type: item.typeName,
    slot: item.slot,
    rarity: item.rarity,
    location: locationLabel(item.location, inv.characters),
  };
  if (item.classType !== 'any' && item.kind === 'armor') out.class = item.classType;
  if (item.gearTier) out.tier = item.gearTier;
  if (item.power) out.power = item.power;
  if (item.equipped) out.equipped = true;
  if (item.locked) out.locked = true;
  if (item.masterworked) out.masterworked = true;
  if (item.crafted) out.crafted = true;
  if (item.weapon) {
    if (item.weapon.element) out.element = item.weapon.element;
    if (item.weapon.ammo) out.ammo = item.weapon.ammo;
    if (item.weapon.intrinsic) out.frame = item.weapon.intrinsic.name;
    const champion = weaponChampion(inv, defs, item);
    if (champion) out.antiChampion = champion;
    out.perks = item.weapon.perks.map((c) =>
      c.options.length > 1 ? `${c.equipped.name} (options: ${c.options.map((o) => o.name).join(', ')})` : c.equipped.name,
    );
  }
  if (item.armor) {
    const a = item.armor;
    if (a.archetype) out.archetype = a.archetype;
    if (a.set) out.set = a.set.name;
    if (item.isExotic && a.intrinsic) out.exoticPerk = a.intrinsic.name;
    const v = opts.masterworkedStats ? a.masterworked : a.noMods;
    out.stats = namedStats(v, defs);
    out.statTotal = statTotal(v);
    if (a.legacy) out.legacyArmor = true;
  }
  return out;
}

export function slotIndex(bucketHash: number): number {
  return (ARMOR_BUCKETS as readonly number[]).indexOf(bucketHash);
}

export function paginate<T>(items: T[], offset = 0, limit = 50) {
  return { total: items.length, offset, returned: Math.min(limit, Math.max(0, items.length - offset)), items: items.slice(offset, offset + limit) };
}
