import type { HttpClient } from 'bungie-api-ts/http';
import { DestinyComponentType, getPublicVendors } from 'bungie-api-ts/destiny2';
import { unwrap } from '../bungie/http.js';
import type { Defs } from '../manifest/defs.js';

export interface VendorOffer {
  vendor: string;
  vendorHash: number;
  cost?: string[];
  /** When this vendor's stock changes. */
  refreshes?: string;
}

/**
 * Everything any vendor sells right now in the public (character-independent) stock, by item hash.
 * This includes Xûr and his Strange Gear offers while he is here.
 */
export async function publicVendorOffers(http: HttpClient, defs: Defs): Promise<Map<number, VendorOffer[]>> {
  const pub = await unwrap(getPublicVendors(http, { components: [DestinyComponentType.Vendors, DestinyComponentType.VendorSales] }));
  const out = new Map<number, VendorOffer[]>();
  for (const [vendorHash, sales] of Object.entries(pub.sales?.data ?? {})) {
    const vendor = defs.vendor(Number(vendorHash))?.displayProperties.name || `#${vendorHash}`;
    const refreshes = pub.vendors?.data?.[vendorHash as unknown as number]?.nextRefreshDate;
    for (const s of Object.values(sales.saleItems ?? {})) {
      if (!s.itemHash) continue;
      const cost = s.costs?.length ? s.costs.map((c) => `${defs.item(c.itemHash)?.displayProperties.name ?? `#${c.itemHash}`}${c.quantity > 1 ? ` x${c.quantity}` : ''}`) : undefined;
      const list = out.get(s.itemHash) ?? [];
      if (!list.some((o) => o.vendorHash === Number(vendorHash))) list.push({ vendor, vendorHash: Number(vendorHash), cost, refreshes });
      out.set(s.itemHash, list);
    }
  }
  return out;
}

/** Whether a vendor whose name matches is in the public stock right now (e.g. "Xûr"). */
export function vendorPresent(offers: Map<number, VendorOffer[]>, name: string): boolean {
  const n = name.toLowerCase();
  for (const list of offers.values()) if (list.some((o) => o.vendor.toLowerCase().includes(n))) return true;
  return false;
}
