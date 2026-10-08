import type { InventoryModel, Item } from '../inventory/model.js';
import type { ProfileService } from '../inventory/profile.js';
import { fragmentCapacity, fragmentSlotUse, isEmptyPlug } from '../inventory/subclass.js';
import { findLoadoutSlot } from '../loadouts/actions.js';
import { isSavedPlug, type Loadout, type LoadoutItem } from '../loadouts/loadouts.js';
import type { Defs } from '../manifest/defs.js';
import { EMPTYISH, itemSockets, type Socket } from '../sockets/plugs.js';
import { describeOwnership, subclassOwnership, type PlugOwnership } from '../world/subclassVendors.js';
import { equippedOn, isLegacyWeapon, legacyWeaponMessage, notMasterworkedMessage } from './spec.js';

export interface LoadoutIssue {
  area: 'items' | 'mods' | 'masterwork' | 'weapons' | 'subclass' | 'equipped' | 'plugs';
  message: string;
}

export interface LoadoutAudit {
  /** Problems with the saved loadout itself, whatever is worn now. */
  gaps: LoadoutIssue[];
  /** Ways what the character wears now differs from the saved slot. */
  drift: LoadoutIssue[];
  /** The worn setup was changed after saving (a plug differs, or other items are worn): re-save it if that is the setup you want. */
  resaveSuggested: boolean;
  /** Ready-made inputs for equip_items and apply_plugs that put the saved setup back (confirm with the user and dry-run first). */
  suggested: { equip: { id: string; name: string }[]; plugs: { item: string; plug: string; socket: number; for: string }[] };
}

/**
 * audit_build's loadout mode: finds the saved slot (see findLoadoutSlot), reads what the vendors say about
 * its subclass (cached unless `refresh`) and audits it, with a note on how to resolve any drift.
 */
export async function auditSavedLoadout(
  profile: Pick<ProfileService, 'characterVendorSales'>,
  inv: InventoryModel,
  defs: Defs,
  ref: string | number,
  opts: { characterId?: string; refresh?: boolean } = {},
) {
  const slot = findLoadoutSlot(inv, defs, ref, opts.characterId);
  const owner = inv.characters.find((c) => c.id === slot.characterId)!;
  const savedSubclass = slot.loadout.items.map((i) => inv.byId.get(i.id)).find((i) => i?.kind === 'subclass');
  const ownership = savedSubclass ? await subclassOwnership(profile, inv, defs, savedSubclass, { fresh: !!opts.refresh }) : undefined;
  const audit = auditLoadout(inv, defs, slot.loadout, ownership);
  return {
    loadout: `${slot.index}: ${slot.loadout.name}`,
    character: owner.className,
    matches: !audit.gaps.length && !audit.drift.length,
    ...audit,
    note: audit.drift.length
      ? `If what the ${owner.className} wears now is the setup you want, re-save slot ${slot.index} (save_loadout with overwrite); otherwise equip_loadout with loadout ${slot.index} and character ${owner.className} puts the saved one back.`
      : undefined,
  };
}

const plugName = (defs: Defs, hash: number) => defs.item(hash)?.displayProperties.name || `#${hash}`;

/**
 * Checks one saved in-game loadout: what is wrong with it (items that no longer exist, unmasterworked
 * pieces, power-10 weapons, empty armor mod slots, unused fragment slots, aspects and fragments not
 * bought) and how what the character wears now differs from it, so the coach knows when a slot needs
 * re-saving. `ownership` is what the vendors say about the saved subclass (see subclassOwnership).
 */
export function auditLoadout(inv: InventoryModel, defs: Defs, loadout: Loadout, ownership?: Map<number, PlugOwnership>): LoadoutAudit {
  const gaps: LoadoutIssue[] = [];
  const drift: LoadoutIssue[] = [];
  const suggested: LoadoutAudit['suggested'] = { equip: [], plugs: [] };
  const worn = equippedOn(inv, loadout.characterId);
  let wearingOther = false;

  for (const saved of loadout.items) {
    const item = inv.byId.get(saved.id);
    if (!item) {
      const carried = saved.plugs.slice(0, 3).join(', ');
      gaps.push({ area: 'items', message: `an item no longer exists (dismantled or deleted)${carried ? `; it carried ${carried}` : ''}: re-save the slot without it` });
      continue;
    }
    if ((item.kind === 'weapon' || item.kind === 'armor') && !item.masterworked) gaps.push({ area: 'masterwork', message: notMasterworkedMessage(item) });
    if (isLegacyWeapon(item)) gaps.push({ area: 'weapons', message: legacyWeaponMessage(item) });

    // Disabled sockets too: a fragment saved in a slot the current aspects don't open still counts.
    const sockets = itemSockets(inv, defs, item, { includeDisabled: true });
    if (item.kind === 'armor') gaps.push(...emptyModSlots(defs, item, sockets, saved));
    if (item.kind === 'subclass') gaps.push(...subclassGaps(defs, sockets, saved, ownership));

    if (saved.equipped) {
      for (const d of driftedPlugs(defs, item, sockets, saved)) {
        drift.push(d.issue);
        if (d.restore) suggested.plugs.push(d.restore);
      }
    } else {
      const instead = worn.find((i) => i.bucketHash === item.bucketHash);
      if (instead) wearingOther = true;
      drift.push({ area: 'equipped', message: `${item.name} is not equipped${instead ? ` (you are wearing ${instead.name})` : ''}` });
      suggested.equip.push({ id: saved.id, name: item.name });
    }
  }

  // Wearing other items in a saved slot, or changed plugs, means the setup moved on since saving.
  return { gaps, drift, resaveSuggested: wearingOther || drift.some((d) => d.area === 'plugs'), suggested };
}

/**
 * Empty armor mod slots the saved loadout leaves on a piece that has the energy to fill them. Energy is
 * counted as equipping the loadout would leave it: saved mods where the loadout saved one, current ones elsewhere.
 */
function emptyModSlots(defs: Defs, item: Item, sockets: Socket[], saved: LoadoutItem): LoadoutIssue[] {
  if (!item.armor?.energy) return [];
  const plugAfter = (s: Socket) => (isSavedPlug(saved.plugHashes[s.index]) ? saved.plugHashes[s.index] : s.current?.hash);
  const used = sockets.reduce((sum, s) => sum + (defs.item(plugAfter(s))?.plug?.energyCost?.energyCost ?? 0), 0);
  const free = item.armor.energy.capacity - used;
  if (free < 1) return [];
  return sockets
    .filter((s) => s.enabled && s.changeable && s.category === 'ARMOR MODS' && s.current && EMPTYISH.test(s.current.name) && !/tuning/i.test(s.current.name) && !isSavedPlug(saved.plugHashes[s.index]))
    .map((s) => ({ area: 'mods' as const, message: `${item.name}: mod slot ${s.index} is empty (${free} armor energy free)` }));
}

/** Unused fragment slots, and saved aspects or fragments the character hasn't bought. */
function subclassGaps(defs: Defs, sockets: Socket[], saved: LoadoutItem, ownership?: Map<number, PlugOwnership>): LoadoutIssue[] {
  const out: LoadoutIssue[] = [];
  const pick = (category: string) =>
    sockets.flatMap((s) => {
      const hash = saved.plugHashes[s.index];
      const def = isSavedPlug(hash) ? defs.item(hash) : undefined;
      return s.category === category && def && !isEmptyPlug(def) ? [{ hash, name: def.displayProperties.name, fragmentSlots: fragmentCapacity(def) }] : [];
    });
  const aspects = pick('ASPECTS');
  const fragments = pick('FRAGMENTS');
  for (const p of [...aspects, ...fragments]) {
    const own = ownership?.get(p.hash);
    const note = own && describeOwnership(own);
    if (note) out.push({ area: 'subclass', message: `${p.name} is ${note}` });
  }
  const { used, available } = fragmentSlotUse(aspects, fragments);
  if (available !== undefined && available > used) {
    out.push({ area: 'subclass', message: `${available - used} fragment slot${available - used === 1 ? '' : 's'} unused (the aspects open ${available}, ${used} saved)` });
  }
  return out;
}

/** Saved plugs of a worn item that differ from what is socketed now, with the apply_plugs change that restores each. */
function driftedPlugs(defs: Defs, item: Item, sockets: Socket[], saved: LoadoutItem) {
  return sockets.flatMap((s) => {
    const hash = saved.plugHashes[s.index];
    if (!isSavedPlug(hash) || s.cosmetic || s.current?.hash === hash) return [];
    const was = plugName(defs, hash);
    const where = s.category || 'socket';
    const now = s.enabled ? (s.current?.name ?? 'empty') : 'disabled now';
    const issue: LoadoutIssue = { area: 'plugs', message: `${item.name}: ${where} ${s.index} is ${now}, saved ${was}` };
    const restore = EMPTYISH.test(was) ? undefined : { item: item.instanceId!, plug: was, socket: s.index, for: `${item.name} ${where.toLowerCase()}` };
    return [{ issue, restore }];
  });
}
