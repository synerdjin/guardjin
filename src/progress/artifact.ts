import { Buckets } from '../inventory/constants.js';
import type { InventoryModel, Item } from '../inventory/model.js';
import type { Defs } from '../manifest/defs.js';
import { itemSockets, socketOptions } from '../sockets/plugs.js';

export interface ArtifactPerk {
  socket: number;
  name: string;
  description: string;
  /** 1–3: the earliest socket group that accepts it (Tier 1 fits any slot, Tier 3 only the last ones). */
  tier?: number;
}

export interface ArtifactSummary {
  id: string;
  name: string;
  equipped: boolean;
  description?: string;
  /** Active perks in socket order; empty slots are left out. */
  perks: ArtifactPerk[];
  emptySlots: number;
}

export interface ArtifactOptions extends ArtifactSummary {
  /** Every perk you can put in this artifact, by tier. */
  options: { name: string; tier: number; description: string; active: boolean }[];
}

const isFiller = (name: string) => /^(empty|reset)\b/i.test(name);

/** Artifacts on a character; the equipped one first. */
export function characterArtifacts(inv: InventoryModel, characterId: string): Item[] {
  return inv.items
    .filter((i) => i.bucketHash === Buckets.Artifact && i.instanceId && i.location.type === 'character' && i.location.characterId === characterId)
    .sort((a, b) => Number(b.equipped) - Number(a.equipped) || a.name.localeCompare(b.name));
}

/**
 * Perk tiers come from socket groups: each group accepts everything the earlier groups do plus
 * the next tier, so a perk's tier is the first group whose options include it.
 */
function tierByPlug(inv: InventoryModel, defs: Defs, artifact: Item): Map<number, number> {
  const def = defs.item(artifact.hash);
  const groups = (def?.sockets?.socketCategories ?? []).map((c) => c.socketIndexes).filter((g) => g.length);
  const tiers = new Map<number, number>();
  let tier = 0;
  for (const group of groups) {
    const hashes = socketOptions(inv, defs, artifact, group[0]).map((o) => o.hash).filter((h) => !isFiller(defs.item(h)?.displayProperties.name ?? ''));
    if (!hashes.length) continue;
    tier++;
    for (const h of hashes) if (!tiers.has(h)) tiers.set(h, tier);
  }
  return tiers;
}

export function describeArtifact(inv: InventoryModel, defs: Defs, artifact: Item): ArtifactSummary {
  const tiers = tierByPlug(inv, defs, artifact);
  const perks: ArtifactPerk[] = [];
  let emptySlots = 0;
  for (const s of itemSockets(inv, defs, artifact)) {
    // The last socket only takes "Reset Artifact"; it isn't a perk slot.
    const perkSlot = socketOptions(inv, defs, artifact, s.index).some((o) => !isFiller(defs.item(o.hash)?.displayProperties.name ?? ''));
    if (!perkSlot) continue;
    if (!s.current || isFiller(s.current.name)) {
      emptySlots++;
      continue;
    }
    perks.push({ socket: s.index, name: s.current.name, description: defs.describePlug(defs.item(s.current.hash)), tier: tiers.get(s.current.hash) });
  }
  return {
    id: artifact.instanceId!,
    name: artifact.name,
    equipped: artifact.equipped,
    description: defs.item(artifact.hash)?.displayProperties.description?.trim() || undefined,
    perks,
    emptySlots,
  };
}

export function artifactOptions(inv: InventoryModel, defs: Defs, artifact: Item): ArtifactOptions {
  const summary = describeArtifact(inv, defs, artifact);
  const active = new Set(summary.perks.map((p) => p.name));
  const options = [...tierByPlug(inv, defs, artifact)].map(([hash, tier]) => {
    const d = defs.item(hash);
    const name = d?.displayProperties.name ?? `#${hash}`;
    return { name, tier, description: defs.describePlug(d), active: active.has(name) };
  });
  options.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
  return { ...summary, options };
}
