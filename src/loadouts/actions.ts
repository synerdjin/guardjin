import type { HttpClient } from 'bungie-api-ts/http';
import { clearLoadout, equipLoadout, snapshotLoadout, updateLoadoutIdentifiers } from 'bungie-api-ts/destiny2';
import type { DestinyAccount } from '../bungie/account.js';
import { unwrap } from '../bungie/http.js';
import { UserError } from '../errors.js';
import type { InventoryModel, Item } from '../inventory/model.js';
import type { Defs } from '../manifest/defs.js';
import { planEquip, planTransfers, type TransferPlan } from '../vault/actions.js';
import { buildLoadouts, type Loadout } from './loadouts.js';

export interface LoadoutSlot {
  characterId: string;
  index: number;
  /** The saved loadout, or undefined when the slot is empty. */
  loadout?: Loadout;
}

/** Number of loadout slots this character has unlocked. */
export function slotCount(inv: InventoryModel, characterId: string): number {
  return inv.raw.characterLoadouts?.data?.[characterId]?.loadouts?.length ?? 0;
}

/**
 * Finds a loadout slot by index (as list_loadouts reports it) or by saved name. With no reference,
 * returns the first empty slot when `preferEmpty` is set.
 */
export function resolveSlot(inv: InventoryModel, defs: Defs, characterId: string, ref: string | number | undefined, opts: { preferEmpty?: boolean } = {}): LoadoutSlot {
  const count = slotCount(inv, characterId);
  if (!count) throw new UserError('This character has no loadout slots (they unlock with Guardian Rank).');
  const character = inv.characters.find((c) => c.id === characterId);
  const saved = buildLoadouts(inv, defs, character ? [character] : []);
  const at = (index: number): LoadoutSlot => ({ characterId, index, loadout: saved.find((l) => l.index === index) });

  if (ref === undefined || ref === '') {
    if (!opts.preferEmpty) throw new UserError('Say which loadout: its index from list_loadouts or its name.');
    for (let i = 0; i < count; i++) if (!saved.some((l) => l.index === i)) return at(i);
    throw new UserError(`All ${count} loadout slots are in use. Pick one to overwrite (index or name) and pass overwrite: true.`);
  }
  const text = String(ref).trim();
  if (/^\d+$/.test(text)) {
    const index = Number(text);
    if (index >= count) throw new UserError(`Loadout index ${index} is out of range; this character has slots 0-${count - 1}.`);
    return at(index);
  }
  const byName = saved.filter((l) => l.name.toLowerCase() === text.toLowerCase());
  if (byName.length === 1) return at(byName[0].index);
  if (byName.length > 1) throw new UserError(`Several loadouts are named "${text}" (indexes ${byName.map((l) => l.index).join(', ')}); pass an index.`);
  throw new UserError(`No saved loadout is named "${text}". Saved: ${saved.map((l) => `${l.index}: ${l.name}`).join(', ') || 'none'}.`);
}

export interface Identifiers {
  nameHash: number;
  iconHash: number;
  colorHash: number;
}

/** The preset loadout names the game allows (loadouts can't have free-text names). */
export function loadoutNames(defs: Defs): { hash: number; name: string }[] {
  return (defs.loadoutConstants()?.loadoutNameHashes ?? []).flatMap((hash) => {
    const name = defs.loadoutName(hash)?.name;
    return name ? [{ hash, name }] : [];
  });
}

/**
 * Identifiers for a save or rename: the requested preset name, otherwise what the slot already
 * has, otherwise the game's default for that slot index.
 */
export function chooseIdentifiers(inv: InventoryModel, defs: Defs, slot: LoadoutSlot, name: string | undefined): Identifiers {
  const constants = defs.loadoutConstants();
  const current = inv.raw.characterLoadouts?.data?.[slot.characterId]?.loadouts?.[slot.index];
  const pick = (list: number[] | undefined, existing: number | undefined) =>
    existing || (list?.length ? list[slot.index % list.length] : 0);

  let nameHash = pick(constants?.loadoutNameHashes, slot.loadout ? current?.nameHash : undefined);
  if (name) {
    const names = loadoutNames(defs);
    const match = names.find((n) => n.name.toLowerCase() === name.trim().toLowerCase());
    if (!match) throw new UserError(`"${name}" isn't an allowed loadout name. Choose one of: ${names.map((n) => n.name).join(', ')}.`);
    nameHash = match.hash;
  }
  return {
    nameHash,
    iconHash: pick(constants?.loadoutIconHashes, slot.loadout ? current?.iconHash : undefined),
    colorHash: pick(constants?.loadoutColorHashes, slot.loadout ? current?.colorHash : undefined),
  };
}

export interface EquipLoadoutPlan {
  slot: LoadoutSlot & { loadout: Loadout };
  /** Moves that bring items from the vault or other characters first. */
  transfers: TransferPlan;
  /** Saved items that no longer exist. The game equips the rest. */
  missing: string[];
  /**
   * Items the game will skip because of the one-exotic-weapon / one-exotic-armor rule: it silently
   * leaves them unequipped when a currently equipped exotic stays in a slot the loadout doesn't fill.
   */
  conflicts: string[];
  alreadyActive: boolean;
}

/**
 * Plans equipping a saved loadout. Items elsewhere are moved to the character first so the result
 * doesn't depend on whether the API pulls from the vault by itself.
 */
export function planEquipLoadout(inv: InventoryModel, defs: Defs, slot: LoadoutSlot): EquipLoadoutPlan {
  if (!slot.loadout) throw new UserError(`Loadout slot ${slot.index} is empty.`);
  const items = slot.loadout.items.flatMap((li) => inv.byId.get(li.id) ?? []);
  const elsewhere = items.filter((i: Item) => !(i.location.type === 'character' && i.location.characterId === slot.characterId));
  return {
    slot: slot as EquipLoadoutPlan['slot'],
    transfers: planTransfers(inv, defs, elsewhere.map((item) => ({ item, to: { type: 'character', characterId: slot.characterId } }))),
    missing: slot.loadout.items.filter((i) => i.missing).map((i) => i.id),
    conflicts: planEquip(inv, defs, slot.characterId, items, { autoResolveExotic: false }).errors.filter((e) => /exotic/i.test(e.error)).map((e) => e.error),
    alreadyActive: slot.loadout.active,
  };
}

const request = (account: DestinyAccount, slot: LoadoutSlot) => ({
  loadoutIndex: slot.index,
  characterId: slot.characterId,
  membershipType: account.membershipType,
});

export async function equipSavedLoadout(http: HttpClient, account: DestinyAccount, slot: LoadoutSlot): Promise<void> {
  await unwrap(equipLoadout(http, request(account, slot)));
}

/** Saves everything currently equipped on the character (gear, subclass setup, mods, cosmetics) into the slot. */
export async function snapshotToSlot(http: HttpClient, account: DestinyAccount, slot: LoadoutSlot, ids: Identifiers): Promise<void> {
  await unwrap(snapshotLoadout(http, { ...request(account, slot), ...ids }));
}

export async function renameSlot(http: HttpClient, account: DestinyAccount, slot: LoadoutSlot, ids: Identifiers): Promise<void> {
  await unwrap(updateLoadoutIdentifiers(http, { ...request(account, slot), ...ids }));
}

export async function clearSlot(http: HttpClient, account: DestinyAccount, slot: LoadoutSlot): Promise<void> {
  await unwrap(clearLoadout(http, request(account, slot)));
}
