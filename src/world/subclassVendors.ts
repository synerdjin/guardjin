import type { DestinyVendorDefinition, DestinyVendorSaleItemComponent } from 'bungie-api-ts/destiny2';
import { acceptedCategories } from '../inventory/subclass.js';
import { actingCharacter, type InventoryModel, type Item } from '../inventory/model.js';
import type { ProfileService } from '../inventory/profile.js';
import type { Defs } from '../manifest/defs.js';
import { costText } from './vendors.js';

/** Whether a character has bought an aspect or fragment, what it costs, and why it can't be bought yet. */
export interface PlugOwnership {
  /** Whether the character has bought it. Undefined when the vendor doesn't offer it to this character. */
  owned?: boolean;
  /** Cost to unlock it when not owned, e.g. "Glimmer x5000". */
  price?: string;
  /** Why it can't be bought right now, in the game's words (e.g. "Requires Guardian Rank 3"). */
  locked?: string;
}

/** DestinyVendorItemState.Owned: the vendor flags sale items you already own. */
const OWNED_AUGMENT = 128;
const NOT_OFFERED = "the vendor doesn't offer it to this character yet (usually a quest or campaign unlocks it)";

const vendorIndexCache = new WeakMap<Defs, Map<string, number[]>>();

/**
 * The game sells every aspect and fragment through "Aspects" / "Fragments" vendors, one per class and
 * element (the Hunter Void aspects, the Void fragments...). This maps a plug category such as
 * `hunter.void.aspects` or `shared.void.fragments` to the enabled vendors that sell it, in manifest
 * order. Fragment vendors come in per-class copies. Prismatic and Strand have no vendor.
 */
export function subclassVendorIndex(defs: Defs): Map<string, number[]> {
  const cached = vendorIndexCache.get(defs);
  if (cached) return cached;
  const index = new Map<string, number[]>();
  for (const vendor of defs.byName<DestinyVendorDefinition>('DestinyVendorDefinition', ['Aspects', 'Fragments'])) {
    if (!vendor.enabled) continue;
    for (const entry of vendor.itemList) {
      const category = defs.item(entry.itemHash)?.plug?.plugCategoryIdentifier;
      if (!category) continue;
      const vendors = index.get(category) ?? [];
      if (!vendors.includes(vendor.hash)) index.set(category, [...vendors, vendor.hash]);
    }
  }
  vendorIndexCache.set(defs, index);
  return index;
}

/** For each aspect/fragment category this subclass's sockets accept, the vendors that sell it (try them in order). */
export function subclassVendors(item: Item, defs: Defs): number[][] {
  const index = subclassVendorIndex(defs);
  const out = new Map<string, number[]>();
  for (const entry of defs.item(item.hash)?.sockets?.socketEntries ?? []) {
    for (const category of acceptedCategories(defs, entry.socketTypeHash)) {
      const vendors = index.get(category);
      if (vendors) out.set(vendors.join(','), vendors);
    }
  }
  return [...out.values()];
}

/** Ownership of everything one vendor sells, from that character's sale entries. */
function readSales(defs: Defs, vendorHash: number, sales: DestinyVendorSaleItemComponent[], out: Map<number, PlugOwnership>): void {
  const vendor = defs.vendor(vendorHash);
  for (const sale of sales) {
    const owned = (sale.augments & OWNED_AUGMENT) !== 0;
    const reasons = owned || sale.saleStatus === 0 ? [] : (sale.failureIndexes ?? []).map((i) => vendor?.failureStrings?.[i]).filter((m): m is string => !!m);
    out.set(sale.itemHash, { owned, price: owned ? undefined : costText(defs, sale.costs)?.join(', '), locked: reasons.length ? reasons.join('; ') : undefined });
  }
  // Items the vendor defines but leaves out of this character's stock are hidden until unlocked elsewhere.
  for (const entry of vendor?.itemList ?? []) if (!out.has(entry.itemHash)) out.set(entry.itemHash, { locked: NOT_OFFERED });
}

/**
 * What a subclass's holder has bought among its aspects and fragments, or undefined for any other item.
 * Everything that lists, plans or applies aspects and fragments asks here, because Bungie's profile plug
 * sets can't answer: they list every fragment as insertable whether or not it was bought, and block bought
 * aspects on a character that has been idle. The vendor is the one place ownership is recorded; for each
 * category the first vendor with stock for the character answers, and one that fails or is empty is skipped.
 *
 * `fresh` is the caller's call, because only the caller knows what the answer is for: reads that only
 * describe may use the profile's 2-minute vendor cache (offer a refresh input next to them); anything that
 * refuses or plans a write, or must agree with one, reads fresh, since turning a plug down as unbought on a
 * stale answer would be wrong.
 */
export async function subclassOwnership(
  profile: Pick<ProfileService, 'characterVendorSales'>,
  inv: Pick<InventoryModel, 'characters'>,
  defs: Defs,
  item: Item,
  { fresh }: { fresh: boolean },
): Promise<Map<number, PlugOwnership> | undefined> {
  const characterId = actingCharacter(inv, item);
  if (item.kind !== 'subclass' || !characterId) return undefined;
  const out = new Map<number, PlugOwnership>();
  await Promise.all(
    subclassVendors(item, defs).map(async (vendors) => {
      for (const vendorHash of vendors) {
        const sales = await profile.characterVendorSales(characterId, vendorHash, fresh).catch(() => []);
        if (!sales.length) continue;
        readSales(defs, vendorHash, sales, out);
        return;
      }
    }),
  );
  return out;
}

/** Plain-language state of an aspect or fragment for messages, or undefined when it is bought. */
export function describeOwnership(own: PlugOwnership): string | undefined {
  if (own.owned) return undefined;
  if (own.owned === undefined) return `not available to this character yet: ${own.locked ?? "the vendor doesn't offer it"}`;
  const price = own.price ? ` (costs ${own.price})` : '';
  return own.locked ? `not bought${price}, and it can't be bought yet: ${own.locked}` : `not bought${price}`;
}
