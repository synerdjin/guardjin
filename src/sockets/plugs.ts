import type { HttpClient } from 'bungie-api-ts/http';
import { DestinySocketArrayType, insertSocketPlugFree, type DestinyInventoryItemDefinition } from 'bungie-api-ts/destiny2';
import type { DestinyAccount } from '../bungie/account.js';
import { unwrap } from '../bungie/http.js';
import type { InventoryModel, Item } from '../inventory/model.js';
import type { Defs } from '../manifest/defs.js';

/**
 * Plug categories this tool never touches, even if the API would accept them: masterworks and
 * catalysts cost materials, rolled armor stats and intrinsics aren't swappable, and mementos,
 * crafting and infusion plugs are consumed or irreversible.
 */
const PROTECTED = /masterwork|armor_stats|armor_archetypes|intrinsics|memento|crafting|infusion|enhancers|deepsight|trackers/i;
const EMPTYISH = /^(empty|default)\b/i;

export interface Socket {
  index: number;
  /** Socket category name, e.g. "ARMOR MODS", "WEAPON PERKS". */
  category: string;
  current?: { hash: number; name: string };
  initial?: number;
  /** Plug category hashes this socket accepts. */
  accepts: Set<number>;
  /** False for sockets this tool won't change (see PROTECTED). */
  changeable: boolean;
}

interface PlugOption {
  hash: number;
  /** Known to be insertable now. False = listed but blocked (e.g. not unlocked). */
  canInsert: boolean;
}

/** The character used for socket actions on an item: its holder, or the most recently played one for vault items. */
export function actingCharacter(inv: InventoryModel, item: Item): string | undefined {
  return item.location.type === 'character' || item.location.type === 'postmaster' ? item.location.characterId : inv.characters[0]?.id;
}

/** Sockets of an instanced item, with their current plugs. Needs the ItemSockets component. */
export function itemSockets(inv: InventoryModel, defs: Defs, item: Item): Socket[] {
  const def = defs.item(item.hash);
  const states = item.instanceId ? inv.raw.itemComponents?.sockets?.data?.[item.instanceId]?.sockets : undefined;
  if (!def?.sockets || !states) return [];
  const categoryOf = new Map<number, string>();
  for (const c of def.sockets.socketCategories) {
    const name = defs.socketCategory(c.socketCategoryHash)?.displayProperties.name ?? '';
    for (const i of c.socketIndexes) categoryOf.set(i, name);
  }

  return def.sockets.socketEntries.flatMap((entry, index): Socket[] => {
    const state = states[index];
    if (!state || state.isVisible === false || state.isEnabled === false) return [];
    const type = defs.socketType(entry.socketTypeHash);
    const currentDef = defs.item(state.plugHash);
    const whitelist = type?.plugWhitelist ?? [];
    const protectedSocket =
      PROTECTED.test(currentDef?.plug?.plugCategoryIdentifier ?? '') ||
      (whitelist.length > 0 && whitelist.every((w) => PROTECTED.test(w.categoryIdentifier)));
    return [
      {
        index,
        category: categoryOf.get(index) ?? '',
        current: state.plugHash ? { hash: state.plugHash, name: currentDef?.displayProperties.name || `#${state.plugHash}` } : undefined,
        initial: entry.singleInitialItemHash || undefined,
        accepts: new Set(whitelist.map((w) => w.categoryHash)),
        changeable: !protectedSocket && whitelist.length > 0,
      },
    ];
  });
}

/** Everything the game lists as selectable in one socket, with whether each can be inserted now. */
export function socketOptions(inv: InventoryModel, defs: Defs, item: Item, socketIndex: number): PlugOption[] {
  const def = defs.item(item.hash);
  const entry = def?.sockets?.socketEntries[socketIndex];
  if (!entry || !item.instanceId) return [];
  const out = new Map<number, PlugOption>();
  const add = (hash: number, canInsert: boolean) => {
    if (!hash) return;
    const prev = out.get(hash);
    out.set(hash, { hash, canInsert: canInsert || !!prev?.canInsert });
  };

  // Rolled options (weapon perk columns, some cosmetics) come per item instance.
  for (const p of inv.raw.itemComponents?.reusablePlugs?.data?.[item.instanceId]?.plugs?.[socketIndex] ?? []) add(p.plugItemHash, p.canInsert !== false && p.enabled !== false);

  // Shared plug sets (mods, shaders, ornaments): the profile/character components say what is unlocked.
  if (entry.reusablePlugSetHash) {
    const characterId = actingCharacter(inv, item);
    const fromProfile = inv.raw.profilePlugSets?.data?.plugs?.[entry.reusablePlugSetHash];
    const fromCharacter = characterId ? inv.raw.characterPlugSets?.data?.[characterId]?.plugs?.[entry.reusablePlugSetHash] : undefined;
    if (fromProfile || fromCharacter) {
      for (const p of [...(fromProfile ?? []), ...(fromCharacter ?? [])]) add(p.plugItemHash, p.canInsert !== false && p.enabled !== false);
    } else {
      for (const p of defs.plugSet(entry.reusablePlugSetHash)?.reusablePlugItems ?? []) add(p.plugItemHash, true);
    }
  }
  for (const p of entry.reusablePlugItems ?? []) add(p.plugItemHash, true);
  // Resetting to an empty/default plug is always allowed.
  if (entry.singleInitialItemHash && EMPTYISH.test(defs.item(entry.singleInitialItemHash)?.displayProperties.name ?? '')) add(entry.singleInitialItemHash, true);
  return [...out.values()];
}

export interface PlugRequest {
  item: Item;
  /** Plug name or hash. Optional when removing by socket. */
  plug?: string;
  socket?: number;
  /** Reset the socket to its empty plug instead of inserting `plug`. */
  remove?: boolean;
}

export interface PlugChange {
  item: Item;
  characterId: string;
  socketIndex: number;
  category: string;
  plug: { hash: number; name: string };
  replaces?: string;
  /** Armor energy after this change, when the item uses energy. */
  energy?: { used: number; capacity: number };
}

export interface PlugPlan {
  changes: PlugChange[];
  /** Requests that are already satisfied. */
  unchanged: string[];
  errors: string[];
}

const energyCost = (d: DestinyInventoryItemDefinition | undefined) => d?.plug?.energyCost?.energyCost ?? 0;
const nameOf = (defs: Defs, hash: number) => defs.item(hash)?.displayProperties.name || `#${hash}`;

/** Plug definitions matching a name (exact first, then substring) or a hash. */
export function findPlugs(defs: Defs, ref: string): DestinyInventoryItemDefinition[] {
  const text = ref.trim();
  if (/^\d+$/.test(text)) {
    const d = defs.item(Number(text));
    return d?.plug ? [d] : [];
  }
  const rows = defs.searchItems({ query: text, limit: 300 });
  const exact = rows.filter((r) => r.name.toLowerCase() === text.toLowerCase());
  return (exact.length ? exact : rows).flatMap((r) => {
    const d = defs.item(r.hash);
    return d?.plug ? [d] : [];
  });
}

interface ItemState {
  sockets: Socket[];
  energy?: { used: number; capacity: number };
}

/**
 * Validates and allocates plug insertions. Requests on the same item are planned in order against
 * that item's evolving state, so several mods land in different sockets and energy is tracked.
 */
export function planPlugChanges(inv: InventoryModel, defs: Defs, requests: PlugRequest[]): PlugPlan {
  const plan: PlugPlan = { changes: [], unchanged: [], errors: [] };
  const states = new Map<Item, ItemState>();
  const stateOf = (item: Item): ItemState => {
    let s = states.get(item);
    if (!s) {
      s = { sockets: itemSockets(inv, defs, item), energy: item.armor?.energy ? { ...item.armor.energy } : undefined };
      states.set(item, s);
    }
    return s;
  };

  for (const req of requests) {
    const { item } = req;
    const label = `${item.name}${req.plug ? ` ← ${req.plug}` : ''}`;
    const fail = (msg: string) => plan.errors.push(`${label}: ${msg}`);
    const characterId = actingCharacter(inv, item);
    if (!item.instanceId || !characterId) {
      fail('only instanced gear on this account can be changed');
      continue;
    }
    const state = stateOf(item);
    if (!state.sockets.length) {
      fail('this item has no sockets that can be read');
      continue;
    }
    const changeable = state.sockets.filter((s) => s.changeable);
    const describe = (list: Socket[]) => list.map((s) => `${s.index}: ${s.current?.name ?? 'empty'} (${s.category})`).join('; ');

    // Resolve the target socket and plug.
    let socket: Socket | undefined;
    let plugHash: number | undefined;

    if (req.remove) {
      if (req.socket !== undefined) socket = changeable.find((s) => s.index === req.socket);
      else if (req.plug) {
        const q = req.plug.trim().toLowerCase();
        const holding = changeable.filter((s) => s.current?.name.toLowerCase() === q);
        if (holding.length > 1) {
          fail(`several sockets hold ${req.plug}; pass socket (${describe(holding)})`);
          continue;
        }
        socket = holding[0];
      }
      if (!socket) {
        fail(`say which socket to empty: ${describe(changeable)}`);
        continue;
      }
      const empty = socket.initial && EMPTYISH.test(nameOf(defs, socket.initial)) ? socket.initial : undefined;
      if (!empty) {
        fail(`socket ${socket.index} has no empty plug to reset to`);
        continue;
      }
      plugHash = empty;
    } else {
      if (!req.plug) {
        fail('pass the plug to insert');
        continue;
      }
      const candidates = findPlugs(defs, req.plug);
      if (!candidates.length) {
        fail('no mod, perk, shader or ornament has that name (lookup_definition can help find it)');
        continue;
      }
      if (candidates.every((c) => PROTECTED.test(c.plug?.plugCategoryIdentifier ?? ''))) {
        fail('masterworks, catalysts, mementos and other costly or irreversible plugs are not changed by this tool; do it in game');
        continue;
      }
      const pool = req.socket !== undefined ? changeable.filter((s) => s.index === req.socket) : changeable;
      if (req.socket !== undefined && !pool.length) {
        fail(`socket ${req.socket} can't be changed here. Changeable sockets: ${describe(changeable)}`);
        continue;
      }

      // For each same-named definition, find sockets that accept it and where it is unlocked.
      let fits = false;
      let blocked = false;
      const eligible: { socket: Socket; hash: number }[] = [];
      for (const c of candidates) {
        if (PROTECTED.test(c.plug?.plugCategoryIdentifier ?? '')) continue;
        for (const s of pool) {
          if (!s.accepts.has(c.plug!.plugCategoryHash)) continue;
          fits = true;
          const option = socketOptions(inv, defs, item, s.index).find((o) => o.hash === c.hash);
          if (s.current?.hash === c.hash) eligible.push({ socket: s, hash: c.hash });
          else if (option?.canInsert) eligible.push({ socket: s, hash: c.hash });
          else if (option) blocked = true;
        }
      }
      if (!eligible.length) {
        fail(
          !fits
            ? `no ${req.socket !== undefined ? `socket ${req.socket}` : 'socket'} on this item accepts it. Changeable sockets: ${describe(changeable)}`
            : blocked
              ? `it is listed for this item but can't be inserted right now (not unlocked, or blocked by the game)`
              : `it isn't one of the options available on this item (not unlocked, or not part of this item's roll)`,
        );
        continue;
      }
      const already = eligible.find((e) => e.socket.current?.hash === e.hash);
      if (already) {
        plan.unchanged.push(`${item.name}: ${nameOf(defs, already.hash)} is already in socket ${already.socket.index}`);
        continue;
      }
      const open = eligible.filter((e) => !e.socket.current || EMPTYISH.test(e.socket.current.name));
      const distinctSockets = new Set(eligible.map((e) => e.socket.index));
      const pick = open[0] ?? (distinctSockets.size === 1 ? eligible[0] : undefined);
      if (!pick) {
        fail(`it fits several filled sockets; pass socket to choose which to replace: ${describe(eligible.map((e) => e.socket).filter((s, i, a) => a.indexOf(s) === i))}`);
        continue;
      }
      socket = pick.socket;
      plugHash = pick.hash;
    }

    const newDef = defs.item(plugHash);
    let energy: PlugChange['energy'];
    if (state.energy) {
      const used = state.energy.used - energyCost(defs.item(socket.current?.hash)) + energyCost(newDef);
      if (used > state.energy.capacity) {
        fail(`not enough armor energy (${used}/${state.energy.capacity} after this change); remove or swap another mod first`);
        continue;
      }
      state.energy.used = used;
      energy = { ...state.energy };
    }
    plan.changes.push({
      item,
      characterId,
      socketIndex: socket.index,
      category: socket.category,
      plug: { hash: plugHash, name: nameOf(defs, plugHash) },
      replaces: socket.current?.name,
      energy,
    });
    socket.current = { hash: plugHash, name: nameOf(defs, plugHash) };
  }
  return plan;
}

export interface PlugResult {
  /** Instance id of the changed item. */
  itemId: string;
  plugHash: number;
  /** Armor energy used after this change, when the item has energy. */
  energyUsed?: number;
  item: string;
  socket: number;
  plug: string;
  ok: boolean;
  error?: string;
}

/** Inserts planned plugs one at a time; a failure doesn't stop the remaining changes. */
export async function executePlugChanges(http: HttpClient, account: DestinyAccount, plan: PlugPlan): Promise<PlugResult[]> {
  const results: PlugResult[] = [];
  for (const c of plan.changes) {
    const base = { itemId: c.item.instanceId!, plugHash: c.plug.hash, energyUsed: c.energy?.used, item: c.item.name, socket: c.socketIndex, plug: c.plug.name };
    try {
      await unwrap(
        insertSocketPlugFree(http, {
          plug: { socketIndex: c.socketIndex, socketArrayType: DestinySocketArrayType.Default, plugItemHash: c.plug.hash },
          itemId: c.item.instanceId!,
          characterId: c.characterId,
          membershipType: account.membershipType,
        }),
      );
      results.push({ ...base, ok: true });
    } catch (err) {
      results.push({ ...base, ok: false, error: (err as Error).message });
    }
  }
  return results;
}
