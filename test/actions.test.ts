import { describe, expect, it, vi } from 'vitest';
import type { HttpClient, HttpClientConfig } from 'bungie-api-ts/http';
import type { DestinyAccount } from '../src/bungie/account.js';
import { Buckets } from '../src/inventory/constants.js';
import { executeTransfers, planEquip, planTransfers } from '../src/vault/actions.js';
import { HUNTER, WARLOCK, fixtureDefs, makeInventory, makeItem } from './helpers.js';

const defs = fixtureDefs();
const onWarlock = { type: 'character' as const, characterId: WARLOCK };
const onHunter = { type: 'character' as const, characterId: HUNTER };

describe('planTransfers', () => {
  it('routes character-to-character moves through the vault', () => {
    const helm = makeItem({ location: onWarlock });
    const plan = planTransfers(makeInventory([helm]), defs, [{ item: helm, to: onHunter }]);
    expect(plan.errors).toEqual([]);
    expect(plan.steps.map((s) => [s.action, s.characterId])).toEqual([
      ['to-vault', WARLOCK],
      ['from-vault', HUNTER],
    ]);
  });

  it('pulls postmaster items before moving them', () => {
    const helm = makeItem({ location: { type: 'postmaster', characterId: WARLOCK } });
    const plan = planTransfers(makeInventory([helm]), defs, [{ item: helm, to: { type: 'vault' } }]);
    expect(plan.steps.map((s) => s.action)).toEqual(['pull-from-postmaster', 'to-vault']);
  });

  it('refuses equipped items and reports items already in place', () => {
    const equipped = makeItem({ location: onWarlock, equipped: true });
    const inVault = makeItem({});
    const plan = planTransfers(makeInventory([equipped, inVault]), defs, [
      { item: equipped, to: { type: 'vault' } },
      { item: inVault, to: { type: 'vault' } },
    ]);
    expect(plan.steps).toEqual([]);
    expect(plan.errors[0].error).toMatch(/equipped/);
    expect(plan.alreadyThere).toEqual([inVault]);
  });

  it('tracks bucket space across a multi-item plan', () => {
    const hunterHelms = Array.from({ length: 8 }, () => makeItem({ location: onHunter }));
    const incoming = [makeItem({}), makeItem({})];
    const plan = planTransfers(makeInventory([...hunterHelms, ...incoming]), defs, incoming.map((item) => ({ item, to: onHunter })));
    expect(plan.steps).toHaveLength(1); // only one free helmet slot (9 unequipped max)
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0].error).toMatch(/full/);
  });

  it('refuses when the vault is full', () => {
    const capacity = defs.bucket(Buckets.Vault)!.itemCount;
    const vault = Array.from({ length: capacity }, () => makeItem({}));
    const helm = makeItem({ location: onWarlock });
    const plan = planTransfers(makeInventory([...vault, helm]), defs, [{ item: helm, to: onHunter }]);
    expect(plan.steps).toEqual([]);
    expect(plan.errors[0].error).toMatch(/vault is full/);
  });
});

describe('planEquip', () => {
  it('rejects gear for another class', () => {
    const hunterHelm = makeItem({ classType: 'hunter' });
    const plan = planEquip(makeInventory([hunterHelm]), defs, WARLOCK, [hunterHelm]);
    expect(plan.toEquip).toEqual([]);
    expect(plan.errors[0].error).toMatch(/hunter gear/);
  });

  it('blocks a second exotic armor piece unless its slot is also being replaced', () => {
    const equippedExoticArms = makeItem({ isExotic: true, hash: 5, bucketHash: Buckets.Gauntlets, slot: 'Gauntlets', location: onWarlock, equipped: true });
    const exoticHelm = makeItem({ isExotic: true, hash: 6 });
    const legendaryArms = makeItem({ bucketHash: Buckets.Gauntlets, slot: 'Gauntlets' });
    const inv = makeInventory([equippedExoticArms, exoticHelm, legendaryArms]);

    const blocked = planEquip(inv, defs, WARLOCK, [exoticHelm]);
    expect(blocked.errors[0].error).toMatch(/conflicts with the equipped exotic/);

    const ok = planEquip(inv, defs, WARLOCK, [exoticHelm, legendaryArms]);
    expect(ok.errors).toEqual([]);
    expect(ok.toEquip).toEqual([exoticHelm, legendaryArms]);
    expect(ok.transfers.steps.map((s) => s.action)).toEqual(['from-vault', 'from-vault']);
  });
});

describe('executeTransfers', () => {
  const account = { membershipType: 3, membershipId: 'm1', displayName: 'me', otherMemberships: [] } as unknown as DestinyAccount;

  it('sends one API call per step and skips later steps of a failed item', async () => {
    const a = makeItem({ location: onWarlock });
    const b = makeItem({ location: onWarlock });
    const plan = planTransfers(makeInventory([a, b]), defs, [
      { item: a, to: onHunter },
      { item: b, to: { type: 'vault' } },
    ]);
    const calls: HttpClientConfig[] = [];
    const http = vi.fn(async (config: HttpClientConfig) => {
      calls.push(config);
      if (calls.length === 1) throw new Error('DestinyItemNotFound');
      return { Response: 0, ErrorCode: 1 };
    }) as unknown as HttpClient;

    const results = await executeTransfers(http, account, plan);
    expect(results.map((r) => [r.item, r.action, r.ok])).toEqual([
      [a.name, 'to-vault', false],
      [a.name, 'from-vault', false],
      [b.name, 'to-vault', true],
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toMatchObject({ itemId: b.instanceId, transferToVault: true, characterId: WARLOCK, membershipType: 3 });
  });
});
