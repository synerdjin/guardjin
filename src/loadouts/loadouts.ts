import type { Defs } from '../manifest/defs.js';
import type { Character, InventoryModel } from '../inventory/model.js';

/** Bungie's "no plug in this socket" sentinel. */
export const EMPTY_PLUG = 2166136261;
/** Whether a saved loadout plug hash holds a plug (not the empty sentinel). */
export const isSavedPlug = (hash: number | undefined): hash is number => !!hash && hash !== EMPTY_PLUG;
const NOISE = /^(empty|default|kill tracker)/i;

export interface LoadoutItem {
  id: string;
  name?: string;
  slot?: string;
  /** Mods, aspects, fragments and other plugs saved with the item. */
  plugs: string[];
  /** The saved plug hash for each socket index of the item (EMPTY_PLUG where nothing is saved). */
  plugHashes: number[];
  /** Currently equipped on this character. */
  equipped: boolean;
  /** The item can't be found any more (dismantled or deleted). */
  missing: boolean;
}

export interface Loadout {
  /** Slot index; pass to loadout actions. */
  index: number;
  characterId: string;
  name: string;
  items: LoadoutItem[];
  /** Every saved item is equipped right now. */
  active: boolean;
}

/** Saved in-game loadouts for every character. Needs the CharacterLoadouts component. */
export function buildLoadouts(inv: InventoryModel, defs: Defs, characters: Character[] = inv.characters): Loadout[] {
  const out: Loadout[] = [];
  for (const character of characters) {
    const slots = inv.raw.characterLoadouts?.data?.[character.id]?.loadouts ?? [];
    slots.forEach((l, index) => {
      // Slots saved without an item come back as instance id "0".
      const saved = l.items.filter((li) => li.itemInstanceId && li.itemInstanceId !== '0');
      if (!saved.length) return; // empty slot
      const items = saved.map((li): LoadoutItem => {
        const item = inv.byId.get(li.itemInstanceId);
        return {
          id: li.itemInstanceId,
          name: item?.name,
          slot: item?.slot,
          plugHashes: li.plugItemHashes,
          plugs: li.plugItemHashes
            .filter(isSavedPlug)
            .map((h) => defs.item(h)?.displayProperties.name || `#${h}`)
            .filter((n) => !NOISE.test(n)),
          equipped: !!item?.equipped && item.location.type === 'character' && item.location.characterId === character.id,
          missing: !item,
        };
      });
      out.push({
        index,
        characterId: character.id,
        name: defs.loadoutName(l.nameHash)?.name || `Loadout ${index + 1}`,
        items,
        active: items.every((i) => i.equipped),
      });
    });
  }
  return out;
}
