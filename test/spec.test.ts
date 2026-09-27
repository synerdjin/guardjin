import { describe, expect, it } from 'vitest';
import { auditBuild, BuildSpecSchema } from '../src/builds/spec.js';
import { ARMOR_STATS } from '../src/inventory/constants.js';
import type { InventoryModel } from '../src/inventory/model.js';
import { characters, fixtureDefs, makeInventory, makeItem, WARLOCK } from './helpers.js';

const defs = fixtureDefs();
const onWarlock = { type: 'character' as const, characterId: WARLOCK };

function setup() {
  const helm = makeItem({ name: 'Helm', location: onWarlock, equipped: true, masterworked: false });
  helm.armor!.mods = [{ hash: 1, name: 'Weapons Mod' }];
  const gun = makeItem({
    kind: 'weapon',
    name: 'Bug-Out Bag',
    location: onWarlock,
    equipped: true,
    power: 10,
    weapon: {
      perks: [{ socketIndex: 3, equipped: { hash: 1, name: 'Kill Clip' }, options: [{ hash: 1, name: 'Kill Clip' }, { hash: 2, name: 'Repulsor Brace' }] }],
      mod: { hash: 5, name: 'Backup Mag' },
    },
  });
  const spareGun = makeItem({ kind: 'weapon', name: 'Python', gearTier: 4 });
  const inv: InventoryModel = makeInventory([helm, gun, spareGun]);
  const stats = Object.fromEntries(ARMOR_STATS.map((s) => [s.hash, s.key === 'grenade' ? 150 : 50]));
  inv.raw = { characters: { data: { [WARLOCK]: { stats } } } } as unknown as InventoryModel['raw'];
  return { inv, helm, gun, spareGun };
}

describe('auditBuild', () => {
  it('lists differences and the changes that close them', () => {
    const { inv, helm, gun, spareGun } = setup();
    const spec = BuildSpecSchema.parse({
      name: 'Test',
      class: 'warlock',
      armor: { stats: { grenade: 150, weapons: 100 }, mods: { helmet: ['Weapons Mod', 'Harmonic Siphon'] } },
      weapons: [
        { name: 'Bug-Out Bag', perks: ['Repulsor Brace', 'Demolitionist'], mod: 'Counterbalance Stock' },
        { name: 'Python' },
        { name: 'Not Owned' },
      ],
    });
    const result = auditBuild(inv, defs, characters[0], spec, {});
    expect(result.matches).toBe(false);
    expect(result.issues.map((i) => i.message)).toEqual([
      'Weapons 50 (target 100, 50 short)',
      'Helm: Harmonic Siphon missing',
      'armor not masterworked: Helm (masterwork in game)',
      'Bug-Out Bag is a legacy weapon stuck at power 10; replace it with a current copy',
      'Bug-Out Bag: Repulsor Brace is available but Kill Clip is selected',
      'Bug-Out Bag: this roll has no Demolitionist',
      'Bug-Out Bag: weapon mod is Backup Mag, spec wants Counterbalance Stock',
      'Python is not equipped',
      'Not Owned is not equipped',
      "Not Owned: you don't own it",
    ]);
    expect(result.suggested.equip).toEqual([{ id: spareGun.instanceId, name: 'Python' }]);
    expect(result.suggested.plugs).toEqual([
      { item: helm.instanceId, plug: 'Harmonic Siphon', for: 'helmet mod' },
      { item: gun.instanceId, plug: 'Repulsor Brace', socket: 3, for: 'Bug-Out Bag perk' },
      { item: gun.instanceId, plug: 'Counterbalance Stock', for: 'Bug-Out Bag mod' },
    ]);
  });

  it('flags a spec for another class', () => {
    const { inv } = setup();
    const result = auditBuild(inv, defs, characters[0], BuildSpecSchema.parse({ name: 'x', class: 'hunter' }), {});
    expect(result.issues).toEqual([{ area: 'class', message: 'spec is for a hunter; this is your Warlock' }]);
  });

  it('rejects malformed specs', () => {
    expect(BuildSpecSchema.safeParse({ name: 'x', armor: { stats: { luck: 5 } } }).success).toBe(false);
  });
});
