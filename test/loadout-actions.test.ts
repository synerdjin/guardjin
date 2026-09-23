import { describe, expect, it } from 'vitest';
import { chooseIdentifiers, loadoutNames, planEquipLoadout, resolveSlot } from '../src/loadouts/actions.js';
import { UserError } from '../src/errors.js';
import { Buckets } from '../src/inventory/constants.js';
import { WARLOCK, fixtureDefs, makeInventory, makeItem } from './helpers.js';

const defs = fixtureDefs();
const GAMMA = 752612101;
const constants = defs.loadoutConstants()!;

const empty = { colorHash: 0, iconHash: 0, nameHash: 0, items: [] };
const saved = (ids: string[], nameHash = GAMMA) => ({ colorHash: 11, iconHash: 22, nameHash, items: ids.map((itemInstanceId) => ({ itemInstanceId, plugItemHashes: [] })) });

function setup(loadouts: unknown[]) {
  const inv = makeInventory([
    makeItem({ instanceId: 'on', name: 'Equipped Helm', equipped: true, location: { type: 'character', characterId: WARLOCK } }),
    makeItem({ instanceId: 'vault', name: 'Vault Gloves', location: { type: 'vault' } }),
  ]);
  inv.raw = { characterLoadouts: { data: { [WARLOCK]: { loadouts } } } } as unknown as typeof inv.raw;
  return inv;
}

describe('resolveSlot', () => {
  const inv = setup([saved(['on']), empty, saved(['vault'], constants.loadoutNameHashes[0])]);

  it('finds slots by index or by name', () => {
    expect(resolveSlot(inv, defs, WARLOCK, 0).loadout?.name).toBe('Gamma');
    expect(resolveSlot(inv, defs, WARLOCK, 'gamma').index).toBe(0);
    expect(resolveSlot(inv, defs, WARLOCK, '1').loadout).toBeUndefined();
  });

  it('defaults to the first empty slot only when asked to', () => {
    expect(resolveSlot(inv, defs, WARLOCK, undefined, { preferEmpty: true }).index).toBe(1);
    expect(() => resolveSlot(inv, defs, WARLOCK, undefined)).toThrow(UserError);
    const full = setup([saved(['on'])]);
    expect(() => resolveSlot(full, defs, WARLOCK, undefined, { preferEmpty: true })).toThrow(/All 1 loadout slots are in use/);
  });

  it('rejects out-of-range indexes and unknown names', () => {
    expect(() => resolveSlot(inv, defs, WARLOCK, 3)).toThrow(/out of range; this character has slots 0-2/);
    expect(() => resolveSlot(inv, defs, WARLOCK, 'Raid')).toThrow(/No saved loadout is named "Raid"/);
  });
});

describe('chooseIdentifiers', () => {
  const inv = setup([saved(['on']), empty]);

  it('keeps an existing loadout\'s identifiers unless a new name is given', () => {
    const slot = resolveSlot(inv, defs, WARLOCK, 0);
    expect(chooseIdentifiers(inv, defs, slot, undefined)).toEqual({ nameHash: GAMMA, iconHash: 22, colorHash: 11 });
    expect(chooseIdentifiers(inv, defs, slot, 'raid').nameHash).toBe(loadoutNames(defs).find((n) => n.name === 'Raid')!.hash);
  });

  it('uses the game defaults for an empty slot', () => {
    const slot = resolveSlot(inv, defs, WARLOCK, 1);
    expect(chooseIdentifiers(inv, defs, slot, undefined)).toEqual({
      nameHash: constants.loadoutNameHashes[1],
      iconHash: constants.loadoutIconHashes[1],
      colorHash: constants.loadoutColorHashes[1],
    });
  });

  it('only accepts the preset names', () => {
    expect(() => chooseIdentifiers(inv, defs, resolveSlot(inv, defs, WARLOCK, 0), 'My Build')).toThrow(/Choose one of: Alpha, Beta, Gamma/);
  });
});

describe('planEquipLoadout', () => {
  it('moves items from elsewhere first and counts missing ones', () => {
    const inv = setup([saved(['on', 'vault', 'gone'])]);
    const plan = planEquipLoadout(inv, defs, resolveSlot(inv, defs, WARLOCK, 0));
    expect(plan.transfers.steps.map((s) => [s.item.name, s.action])).toEqual([['Vault Gloves', 'from-vault']]);
    expect(plan.missing).toEqual(['gone']);
    expect(plan.alreadyActive).toBe(false);
  });

  it('refuses an empty slot', () => {
    const inv = setup([empty]);
    expect(() => planEquipLoadout(inv, defs, resolveSlot(inv, defs, WARLOCK, 0))).toThrow(/slot 0 is empty/);
  });

  it('warns when a loadout exotic conflicts with an exotic that stays equipped', () => {
    // Observed live: the game skipped an exotic kinetic because an exotic energy weapon stayed equipped
    // (the loadout's energy item had been dismantled), and did so without an error.
    const exoticEnergy = makeItem({ instanceId: 'lance', name: 'Graviton Lance', kind: 'weapon', isExotic: true, slot: 'Energy Weapons', bucketHash: Buckets.Energy, equipped: true, location: { type: 'character', characterId: WARLOCK } });
    const exoticKinetic = makeItem({ instanceId: 'arb', name: 'Arbalest', kind: 'weapon', isExotic: true, slot: 'Kinetic Weapons', bucketHash: Buckets.Kinetic, location: { type: 'vault' } });
    const inv = makeInventory([exoticEnergy, exoticKinetic]);
    inv.raw = { characterLoadouts: { data: { [WARLOCK]: { loadouts: [saved(['arb', 'gone'])] } } } } as unknown as typeof inv.raw;
    const plan = planEquipLoadout(inv, defs, resolveSlot(inv, defs, WARLOCK, 0));
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatch(/Arbalest conflicts with the equipped exotic Graviton Lance/);

    // With no other exotic in play there is nothing to warn about.
    const clean = makeInventory([exoticKinetic]);
    clean.raw = inv.raw;
    expect(planEquipLoadout(clean, defs, resolveSlot(clean, defs, WARLOCK, 0)).conflicts).toEqual([]);
  });
});
