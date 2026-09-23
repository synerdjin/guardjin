import type { DestinyItemComponent, DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import { Buckets } from '../inventory/constants.js';
import type { Defs } from '../manifest/defs.js';

export interface Holding {
  name: string;
  quantity: number;
}

export interface Wallet {
  currencies: Holding[];
  silver: Holding[];
  materials: Holding[];
}

const byQuantity = (a: Holding, b: Holding) => b.quantity - a.quantity || a.name.localeCompare(b.name);

/** Sums stacks of the same item (a currency or material can be split across stacks). */
function tally(items: DestinyItemComponent[], defs: Defs): Holding[] {
  const totals = new Map<number, number>();
  for (const i of items) totals.set(i.itemHash, (totals.get(i.itemHash) ?? 0) + i.quantity);
  return [...totals]
    .flatMap(([hash, quantity]) => {
      const name = defs.item(hash)?.displayProperties.name;
      return name && quantity > 0 ? [{ name, quantity }] : [];
    })
    .sort(byQuantity);
}

/**
 * Glimmer, shards and other currencies, Silver per platform, and crafting/upgrade materials.
 * Needs ProfileCurrencies, PlatformSilver and ProfileInventories.
 */
export function buildWallet(profile: DestinyProfileResponse, defs: Defs): Wallet {
  const materialBuckets: number[] = [Buckets.Materials, Buckets.Consumables, Buckets.Modifications];
  return {
    currencies: tally(profile.profileCurrencies?.data?.items ?? [], defs),
    silver: tally(Object.values(profile.platformSilver?.data?.platformSilver ?? {}), defs),
    materials: tally((profile.profileInventory?.data?.items ?? []).filter((i) => materialBuckets.includes(i.bucketHash)), defs),
  };
}
