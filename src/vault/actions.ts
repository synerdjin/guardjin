import type { HttpClient } from 'bungie-api-ts/http';
import { equipItems, pullFromPostmaster, setItemLockState, transferItem } from 'bungie-api-ts/destiny2';
import type { DestinyAccount } from '../bungie/account.js';
import { unwrap } from '../bungie/http.js';
import { ARMOR_BUCKETS, Buckets, WEAPON_BUCKETS } from '../inventory/constants.js';
import type { InventoryModel, Item } from '../inventory/model.js';
import type { Defs } from '../manifest/defs.js';

export type Destination = { type: 'vault' } | { type: 'character'; characterId: string };

export interface TransferStep {
  action: 'pull-from-postmaster' | 'to-vault' | 'from-vault';
  item: Item;
  characterId: string;
}

export interface PlanError {
  item?: Item;
  itemId: string;
  error: string;
}

export interface TransferPlan {
  steps: TransferStep[];
  errors: PlanError[];
  /** Items that are already where they were asked to go. */
  alreadyThere: Item[];
}

/**
 * Tracks free space while planning so multi-item plans are validated in order: the vault's
 * capacity, each character's buckets (one slot per bucket is the equipped item) and postmasters.
 */
class SpaceTracker {
  private vaultUsed: number;
  private readonly vaultCapacity: number;
  private readonly bucketUsed = new Map<string, number>();

  constructor(
    inv: InventoryModel,
    private readonly defs: Defs,
  ) {
    this.vaultUsed = inv.items.filter((i) => i.location.type === 'vault').length;
    this.vaultCapacity = defs.bucket(Buckets.Vault)?.itemCount ?? 700;
    for (const it of inv.items) {
      if (it.location.type === 'character' && !it.equipped) {
        const key = `${it.location.characterId}:${it.bucketHash}`;
        this.bucketUsed.set(key, (this.bucketUsed.get(key) ?? 0) + 1);
      }
    }
  }

  private capacity(bucketHash: number): number {
    return (this.defs.bucket(bucketHash)?.itemCount ?? 10) - 1;
  }

  /** Only gear buckets are space-checked; other buckets (consumables etc.) are left to the API. */
  private tracked(bucketHash: number): boolean {
    return (ARMOR_BUCKETS as readonly number[]).includes(bucketHash) || (WEAPON_BUCKETS as readonly number[]).includes(bucketHash);
  }

  vaultHasRoom(): boolean {
    return this.vaultUsed < this.vaultCapacity;
  }
  characterHasRoom(characterId: string, bucketHash: number): boolean {
    if (!this.tracked(bucketHash)) return true;
    return (this.bucketUsed.get(`${characterId}:${bucketHash}`) ?? 0) < this.capacity(bucketHash);
  }
  moveToVault(characterId: string, bucketHash: number): void {
    this.vaultUsed++;
    this.adjust(characterId, bucketHash, -1);
  }
  moveFromVault(characterId: string, bucketHash: number): void {
    this.vaultUsed--;
    this.adjust(characterId, bucketHash, +1);
  }
  addToCharacter(characterId: string, bucketHash: number): void {
    this.adjust(characterId, bucketHash, +1);
  }
  removeFromCharacter(characterId: string, bucketHash: number): void {
    this.adjust(characterId, bucketHash, -1);
  }
  private adjust(characterId: string, bucketHash: number, delta: number): void {
    const key = `${characterId}:${bucketHash}`;
    this.bucketUsed.set(key, (this.bucketUsed.get(key) ?? 0) + delta);
  }
}

/** Plans the API calls needed to move items. Character→character moves go through the vault. */
export function planTransfers(inv: InventoryModel, defs: Defs, requests: { item: Item; to: Destination }[]): TransferPlan {
  const space = new SpaceTracker(inv, defs);
  const plan: TransferPlan = { steps: [], errors: [], alreadyThere: [] };
  const charName = (id: string) => inv.characters.find((c) => c.id === id)?.className ?? id;

  for (const { item, to } of requests) {
    const itemId = item.instanceId ?? String(item.hash);
    const fail = (error: string) => plan.errors.push({ item, itemId, error: `${item.name}: ${error}` });
    if (to.type === 'character' && !inv.characters.some((c) => c.id === to.characterId)) {
      fail(`unknown character ${to.characterId}`);
      continue;
    }
    if (!item.transferable) {
      fail('this item cannot be transferred');
      continue;
    }
    if (item.equipped) {
      fail(`it is equipped on your ${charName((item.location as { characterId: string }).characterId)}; equip something else in that slot first`);
      continue;
    }

    const steps: TransferStep[] = [];
    const undo: (() => void)[] = [];
    let loc = item.location;
    if (loc.type === 'profile') {
      fail('account-wide items (consumables, mods) are not handled by this tool');
      continue;
    }
    if (loc.type === 'postmaster') {
      if (!space.characterHasRoom(loc.characterId, item.bucketHash)) {
        fail(`no room in your ${charName(loc.characterId)}'s ${item.slot} to pull it from the postmaster`);
        continue;
      }
      const from = loc.characterId;
      steps.push({ action: 'pull-from-postmaster', item, characterId: from });
      space.addToCharacter(from, item.bucketHash);
      undo.push(() => space.removeFromCharacter(from, item.bucketHash));
      loc = { type: 'character', characterId: loc.characterId };
    }

    const already =
      (to.type === 'vault' && loc.type === 'vault') ||
      (to.type === 'character' && loc.type === 'character' && loc.characterId === to.characterId);
    if (already) {
      if (steps.length) plan.steps.push(...steps);
      else plan.alreadyThere.push(item);
      continue;
    }

    if (loc.type === 'character') {
      if (!space.vaultHasRoom()) {
        fail('the vault is full');
        for (const u of undo.reverse()) u();
        continue;
      }
      const from = loc.characterId;
      steps.push({ action: 'to-vault', item, characterId: from });
      space.moveToVault(from, item.bucketHash);
      undo.push(() => space.moveFromVault(from, item.bucketHash));
      loc = { type: 'vault' };
    }
    if (to.type === 'character') {
      if (!space.characterHasRoom(to.characterId, item.bucketHash)) {
        fail(`your ${charName(to.characterId)}'s ${item.slot} is full; move something out first`);
        // Drop this item's provisional steps and give their space back.
        for (const u of undo.reverse()) u();
        continue;
      }
      steps.push({ action: 'from-vault', item, characterId: to.characterId });
      space.moveFromVault(to.characterId, item.bucketHash);
    }
    plan.steps.push(...steps);
  }
  return plan;
}

export interface StepResult {
  item: string;
  itemId?: string;
  action: TransferStep['action'];
  characterId: string;
  ok: boolean;
  error?: string;
}

/** Runs a plan. If a step fails, later steps for the same item are skipped; other items continue. */
export async function executeTransfers(http: HttpClient, account: DestinyAccount, plan: TransferPlan): Promise<StepResult[]> {
  const failedItems = new Set<Item>();
  const results: StepResult[] = [];
  for (const step of plan.steps) {
    const base = { item: step.item.name, itemId: step.item.instanceId, action: step.action, characterId: step.characterId };
    if (failedItems.has(step.item)) {
      results.push({ ...base, ok: false, error: 'skipped because an earlier step for this item failed' });
      continue;
    }
    const body = {
      itemReferenceHash: step.item.hash,
      stackSize: step.item.quantity || 1,
      itemId: step.item.instanceId ?? '0',
      characterId: step.characterId,
      membershipType: account.membershipType,
    };
    try {
      if (step.action === 'pull-from-postmaster') await unwrap(pullFromPostmaster(http, body));
      else await unwrap(transferItem(http, { ...body, transferToVault: step.action === 'to-vault' }));
      results.push({ ...base, ok: true });
    } catch (err) {
      failedItems.add(step.item);
      results.push({ ...base, ok: false, error: (err as Error).message });
    }
  }
  return results;
}

export interface EquipPlan {
  transfers: TransferPlan;
  toEquip: Item[];
  errors: PlanError[];
}

/** Checks class restrictions and exotic limits, and plans any transfers needed before equipping. */
export function planEquip(inv: InventoryModel, defs: Defs, characterId: string, items: Item[]): EquipPlan {
  const character = inv.characters.find((c) => c.id === characterId);
  const errors: PlanError[] = [];
  if (!character) return { transfers: { steps: [], errors: [], alreadyThere: [] }, toEquip: [], errors: [{ itemId: characterId, error: 'unknown character' }] };

  const valid: Item[] = [];
  for (const it of items) {
    const itemId = it.instanceId ?? String(it.hash);
    if (it.kind !== 'weapon' && it.kind !== 'armor' && it.kind !== 'subclass' && it.kind !== 'ghost') {
      errors.push({ item: it, itemId, error: `${it.name}: only weapons, armor, subclasses and ghosts can be equipped here` });
    } else if (it.classType !== 'any' && it.classType !== character.classType) {
      errors.push({ item: it, itemId, error: `${it.name} is ${it.classType} gear and can't be equipped on a ${character.classType}` });
    } else if (it.equipped && it.location.type === 'character' && it.location.characterId !== characterId) {
      errors.push({ item: it, itemId, error: `${it.name} is equipped on another character; equip something else there first` });
    } else {
      valid.push(it);
    }
  }

  // Exotic limits: one exotic weapon and one exotic armor piece, counting what stays equipped.
  for (const kind of ['weapon', 'armor'] as const) {
    const incoming = valid.filter((i) => i.kind === kind && i.isExotic);
    if (incoming.length > 1) {
      for (const it of incoming) errors.push({ item: it, itemId: it.instanceId!, error: `only one exotic ${kind} can be equipped at a time` });
      continue;
    }
    if (incoming.length === 1) {
      const newSlots = new Set(valid.map((i) => i.bucketHash));
      const staying = inv.items.find(
        (i) =>
          i.equipped && i.location.type === 'character' && i.location.characterId === characterId &&
          i.kind === kind && i.isExotic && !newSlots.has(i.bucketHash) && i !== incoming[0],
      );
      if (staying) {
        errors.push({
          item: incoming[0],
          itemId: incoming[0].instanceId!,
          error: `${incoming[0].name} conflicts with the equipped exotic ${staying.name}; also equip a legendary in its ${staying.slot} slot`,
        });
      }
    }
  }

  const ok = valid.filter((v) => !errors.some((e) => e.item === v));
  const needsMove = ok.filter((i) => !(i.location.type === 'character' && i.location.characterId === characterId));
  const transfers = planTransfers(inv, defs, needsMove.map((item) => ({ item, to: { type: 'character', characterId } })));
  const blocked = new Set(transfers.errors.map((e) => e.item));
  return { transfers, toEquip: ok.filter((i) => !blocked.has(i)), errors: [...errors, ...transfers.errors] };
}

export async function executeEquip(
  http: HttpClient,
  account: DestinyAccount,
  characterId: string,
  plan: EquipPlan,
): Promise<{ transfers: StepResult[]; equip: { item: string; itemId: string; ok: boolean; status?: number }[] }> {
  const transfers = await executeTransfers(http, account, plan.transfers);
  const failed = new Set(transfers.filter((t) => !t.ok).map((t) => t.itemId));
  const ids = plan.toEquip.map((i) => i.instanceId!).filter((id) => !failed.has(id));
  if (!ids.length) return { transfers, equip: [] };
  const res = await unwrap(equipItems(http, { itemIds: ids, characterId, membershipType: account.membershipType }));
  const nameOf = (id: string) => plan.toEquip.find((i) => i.instanceId === id)?.name ?? id;
  return {
    transfers,
    equip: res.equipResults.map((r) => ({ item: nameOf(r.itemInstanceId), itemId: r.itemInstanceId, ok: r.equipStatus === 1, status: r.equipStatus })),
  };
}

export async function setLocks(
  http: HttpClient,
  account: DestinyAccount,
  inv: InventoryModel,
  items: Item[],
  locked: boolean,
): Promise<{ item: string; itemId: string; ok: boolean; error?: string }[]> {
  const anyCharacter = inv.characters[0]?.id;
  const out: { item: string; itemId: string; ok: boolean; error?: string }[] = [];
  for (const it of items) {
    const itemId = it.instanceId!;
    if (!it.lockable) {
      out.push({ item: it.name, itemId, ok: false, error: 'item is not lockable' });
      continue;
    }
    if (it.locked === locked) {
      out.push({ item: it.name, itemId, ok: true, error: `already ${locked ? 'locked' : 'unlocked'}` });
      continue;
    }
    const characterId = it.location.type === 'character' || it.location.type === 'postmaster' ? it.location.characterId : anyCharacter;
    try {
      await unwrap(setItemLockState(http, { state: locked, itemId, characterId, membershipType: account.membershipType }));
      out.push({ item: it.name, itemId, ok: true });
    } catch (err) {
      out.push({ item: it.name, itemId, ok: false, error: (err as Error).message });
    }
  }
  return out;
}
