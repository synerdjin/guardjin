import type { Defs } from '../manifest/defs.js';
import type { Character, InventoryModel } from '../inventory/model.js';

/** Bungie's "no plug in this socket" sentinel. */
const EMPTY_PLUG = 2166136261;
const NOISE = /^(empty|default|kill tracker)/i;

export interface LoadoutItem {
  id: string;
  name?: string;
  slot?: string;
  /** Mods, aspects, fragments and other plugs saved with the item. */
  plugs: string[];
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
    const saved = inv.raw.characterLoadouts?.data?.[character.id]?.loadouts ?? [];
    saved.forEach((l, index) => {
      if (!l.items.length) return;
      // Slots saved without an item come back as instance id "0".
      const items = l.items.filter((li) => li.itemInstanceId && li.itemInstanceId !== '0').map((li): LoadoutItem => {
        const item = inv.byId.get(li.itemInstanceId);
        return {
          id: li.itemInstanceId,
          name: item?.name,
          slot: item?.slot,
          plugs: li.plugItemHashes
            .filter((h) => h && h !== EMPTY_PLUG)
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
