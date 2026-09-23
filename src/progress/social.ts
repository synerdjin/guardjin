import type { DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import type { Defs } from '../manifest/defs.js';

export interface KioskVendor {
  vendor: string;
  total: number;
  acquirable: number;
  items: { name: string; type?: string; canAcquire: boolean; reasons: string[] }[];
}

/**
 * Kiosk contents (items a vendor can re-issue or lets you acquire), per vendor. Needs the Kiosks
 * component. Profile-wide and per-character kiosks are merged.
 */
export function buildKiosks(profile: DestinyProfileResponse, defs: Defs): KioskVendor[] {
  const sources = [profile.profileKiosks?.data?.kioskItems, ...Object.values(profile.characterKiosks?.data ?? {}).map((k) => k.kioskItems)];
  const merged = new Map<number, Map<number, { canAcquire: boolean; failures: number[] }>>();
  for (const source of sources) {
    for (const [vendorText, items] of Object.entries(source ?? {})) {
      const vendorHash = Number(vendorText);
      const slots = merged.get(vendorHash) ?? new Map();
      for (const k of items) {
        const prev = slots.get(k.index);
        if (!prev || (!prev.canAcquire && k.canAcquire)) slots.set(k.index, { canAcquire: k.canAcquire, failures: k.failureIndexes });
      }
      merged.set(vendorHash, slots);
    }
  }

  const out: KioskVendor[] = [];
  for (const [vendorHash, slots] of merged) {
    const vendor = defs.vendor(vendorHash);
    const vendorName = vendor?.displayProperties.name;
    if (!vendor || !vendorName) continue;
    const items = [...slots].flatMap(([index, k]) => {
      const def = defs.item(vendor.itemList?.[index]?.itemHash);
      if (!def?.displayProperties.name) return [];
      return [
        {
          name: def.displayProperties.name,
          type: def.itemTypeDisplayName || undefined,
          canAcquire: k.canAcquire,
          reasons: k.failures.map((f) => vendor.failureStrings?.[f]).filter((s): s is string => !!s),
        },
      ];
    });
    out.push({ vendor: vendorName, total: items.length, acquirable: items.filter((i) => i.canAcquire).length, items });
  }
  return out.sort((a, b) => a.vendor.localeCompare(b.vendor));
}

const REFUND = ['not refundable', 'refundable', 'refundable and revokes the item', 'refundable, with the cost returned'];

export interface Receipt {
  item: string;
  quantity: number;
  paid: string[];
  refund: string;
  expires?: string;
  character?: string;
}

/** Recent vendor purchases that can still be refunded. Needs VendorReceipts. */
export function buildReceipts(profile: DestinyProfileResponse, defs: Defs, characterName: (id: string) => string | undefined): Receipt[] {
  return (profile.vendorReceipts?.data?.receipts ?? []).map((r) => ({
    item: defs.item(r.itemReceived.itemHash)?.displayProperties.name ?? `#${r.itemReceived.itemHash}`,
    quantity: r.itemReceived.quantity,
    paid: r.currencyPaid.map((c) => `${defs.item(c.itemHash)?.displayProperties.name ?? `#${c.itemHash}`}${c.quantity > 1 ? ` x${c.quantity}` : ''}`),
    refund: REFUND[r.refundPolicy] ?? `policy ${r.refundPolicy}`,
    expires: r.expiresOn || undefined,
    character: characterName(r.purchasedByCharacterId),
  }));
}

export interface CommendationNode {
  name: string;
  score: number;
  percent?: number;
  commendations: { name: string; score: number }[];
}

/** Commendation scores grouped by category. Needs SocialCommendations. */
export function buildCommendations(profile: DestinyProfileResponse, defs: Defs) {
  const data = profile.profileCommendations?.data;
  if (!data) return undefined;
  const nodes: CommendationNode[] = Object.entries(data.commendationNodeScoresByHash ?? {})
    .flatMap(([hash, score]) => {
      const node = defs.commendationNode(Number(hash));
      const name = node?.displayProperties?.name;
      if (!name) return [];
      const commendations = (node.childCommendationHashes ?? []).flatMap((c) => {
        const cName = defs.commendation(c)?.displayProperties?.name;
        return cName ? [{ name: cName, score: data.commendationScoresByHash?.[c] ?? 0 }] : [];
      });
      return [{ name, score, percent: data.commendationNodePercentagesByHash?.[Number(hash)], commendations: commendations.sort((a, b) => b.score - a.score) }];
    })
    .sort((a, b) => b.score - a.score);
  return { totalScore: data.totalScore, nodes };
}
