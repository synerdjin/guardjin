import type { DestinyInventoryItemDefinition } from 'bungie-api-ts/destiny2';
import { describe, expect, it } from 'vitest';
import { ARMOR_STATS } from '../src/inventory/constants.js';
import { characterSubclasses, findSubclass, FRAGMENT_CAPACITY_STAT, plugStatBonus, planSubclassSetup, subclassPlugStats, type SubclassPlug, type SubclassSummary } from '../src/inventory/subclass.js';
import { HUNTER, makeInventory, makeItem } from './helpers.js';
import type { Defs } from '../src/manifest/defs.js';

const [WEAPONS, HEALTH, CLASS, GRENADE, , MELEE] = ARMOR_STATS.map((s) => s.hash);
const FRAGMENT_COST = 119204074;

/** Fragment definitions as the manifest ships them: most stats are flagged conditionally active but always apply. */
const stat = (statTypeHash: number, value: number, isConditionallyActive = true) => ({ statTypeHash, value, isConditionallyActive });
const plug = (hash: number, name: string, investmentStats: ReturnType<typeof stat>[]) =>
  ({ hash, displayProperties: { name, description: '' }, investmentStats }) as unknown as DestinyInventoryItemDefinition;

const leeching = plug(1, 'Echo of Leeching', [stat(FRAGMENT_COST, 1, false), stat(HEALTH, 10)]);
const starvation = plug(2, 'Echo of Starvation', [stat(FRAGMENT_COST, 1, false), stat(CLASS, -10)]);
const undermining = plug(3, 'Echo of Undermining', [stat(FRAGMENT_COST, 1, false), stat(GRENADE, -10)]);
const exchange = plug(4, 'Echo of Exchange', [stat(FRAGMENT_COST, 1, false), stat(MELEE, 10, false)]);
const persistence = plug(5, 'Echo of Persistence', [stat(CLASS, -10), stat(WEAPONS, -10), stat(HEALTH, -10)]);
const prowl = plug(10, 'On the Prowl', [stat(FRAGMENT_CAPACITY_STAT, 3, false)]);
const stylish = plug(11, 'Stylish Executioner', [stat(FRAGMENT_CAPACITY_STAT, 2, false)]);

const defsOf = (...defs: DestinyInventoryItemDefinition[]) => ({ item: (h: number) => defs.find((d) => d.hash === h), stat: () => undefined }) as unknown as Defs;
const asPlug = (d: DestinyInventoryItemDefinition, fragmentSlots?: number): SubclassPlug => ({ hash: d.hash, name: d.displayProperties.name, description: '', fragmentSlots });

describe('plugStatBonus', () => {
  it('counts conditionally active fragment stats', () => {
    expect(plugStatBonus(leeching, 'hunter')).toEqual([0, 10, 0, 0, 0, 0]);
    expect(plugStatBonus(starvation, 'hunter')).toEqual([0, 0, -10, 0, 0, 0]);
    expect(plugStatBonus(undermining, 'warlock')).toEqual([0, 0, 0, -10, 0, 0]);
    expect(plugStatBonus(exchange, 'titan')).toEqual([0, 0, 0, 0, 0, 10]);
  });

  it('applies a class-spread penalty only to the character\'s class stat', () => {
    expect(plugStatBonus(persistence, 'hunter')).toEqual([-10, 0, 0, 0, 0, 0]);
    expect(plugStatBonus(persistence, 'titan')).toEqual([0, -10, 0, 0, 0, 0]);
    expect(plugStatBonus(persistence, 'warlock')).toEqual([0, 0, -10, 0, 0, 0]);
  });

  it('keeps an unconditional bonus that happens to match on Weapons, Health and Class', () => {
    const even = plug(6, 'Even', [stat(WEAPONS, 10, false), stat(HEALTH, 10, false), stat(CLASS, 10, false)]);
    expect(plugStatBonus(even, 'hunter')).toEqual([10, 10, 10, 0, 0, 0]);
  });

  it('ignores fragment cost and capacity stats', () => {
    expect(plugStatBonus(prowl, 'hunter')).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('subclassPlugStats', () => {
  const defs = defsOf(leeching, persistence);

  it('lists a class-dependent penalty per class when the class is unknown', () => {
    expect(subclassPlugStats(persistence, defs)).toEqual({ statsByClass: { hunter: { weapons: -10 }, titan: { health: -10 }, warlock: { class: -10 } } });
    expect(subclassPlugStats(persistence, defs, 'warlock')).toEqual({ stats: { class: -10 } });
  });

  it('lists a fixed bonus once', () => {
    expect(subclassPlugStats(leeching, defs)).toEqual({ stats: { health: 10 } });
  });
});

describe('findSubclass', () => {
  const subclassDef = (hash: number, damageType: number) => ({ hash, displayProperties: { name: '' }, talentGrid: { hudDamageType: damageType } }) as unknown as DestinyInventoryItemDefinition;
  const defs = defsOf(subclassDef(201, 4), subclassDef(202, 3), subclassDef(203, 1));
  const onHunter = { type: 'character', characterId: HUNTER } as const;
  const nightstalker = makeItem({ kind: 'subclass', hash: 201, name: 'Nightstalker', location: onHunter });
  const gunslinger = makeItem({ kind: 'subclass', hash: 202, name: 'Gunslinger', location: onHunter, equipped: true });
  const prismatic = makeItem({ kind: 'subclass', hash: 203, name: 'Prismatic', location: onHunter });
  const inv = makeInventory([nightstalker, gunslinger, prismatic]);

  it('defaults to the equipped subclass', () => {
    expect(findSubclass(inv, defs, HUNTER)).toBe(gunslinger);
  });

  it('matches by name or by element', () => {
    expect(findSubclass(inv, defs, HUNTER, 'night')).toBe(nightstalker);
    expect(findSubclass(inv, defs, HUNTER, 'Void')).toBe(nightstalker);
    expect(findSubclass(inv, defs, HUNTER, 'solar')).toBe(gunslinger);
    expect(findSubclass(inv, defs, HUNTER, 'Prismatic')).toBe(prismatic);
  });

  it('lists every subclass, or those matching a name or element', () => {
    expect(characterSubclasses(inv, defs, HUNTER)).toHaveLength(3);
    expect(characterSubclasses(inv, defs, HUNTER, 'Void')).toEqual([nightstalker]);
  });

  it('prefers the equipped subclass among several matches, and finds nothing for an unknown name', () => {
    expect(findSubclass(inv, defs, HUNTER, 'n')).toBe(gunslinger);
    expect(findSubclass(inv, defs, HUNTER, 'Stasis')).toBeUndefined();
  });
});

describe('planSubclassSetup', () => {
  const all = [leeching, starvation, undermining, exchange, persistence, prowl, stylish];
  const defs = defsOf(...all);
  const summary: SubclassSummary = {
    hash: 99,
    name: 'Nightstalker',
    characterId: 'c',
    equipped: false,
    sections: [
      { category: 'ASPECTS', equipped: [asPlug(stylish, 2)], available: [asPlug(stylish, 2), asPlug(prowl, 3)] },
      { category: 'FRAGMENTS', equipped: [asPlug(exchange)], available: [leeching, starvation, undermining, exchange, persistence].map((d) => asPlug(d)) },
    ],
  };

  it('sums the bonuses of the planned fragments instead of the equipped ones', () => {
    const plan = planSubclassSetup(summary, defs, 'hunter', { fragments: ['Echo of Leeching', 'Echo of Starvation', 'Echo of Undermining'] });
    expect(plan.bonus).toEqual([0, 10, -10, -10, 0, 0]);
    expect(plan.fragmentSlots).toEqual({ used: 3, available: 2 });
    expect(plan.warning).toMatch(/3 fragments need 3 slots/);
  });

  it('reports chosen plugs the character has not bought', () => {
    const withOwnership: SubclassSummary = {
      ...summary,
      sections: [
        summary.sections[0],
        {
          ...summary.sections[1],
          available: [
            { ...asPlug(leeching), owned: true },
            { ...asPlug(starvation), owned: false, price: 'Glimmer x10000' },
            { ...asPlug(undermining), locked: "the vendor doesn't offer it" },
          ],
        },
      ],
    };
    const plan = planSubclassSetup(withOwnership, defs, 'hunter', { fragments: ['Echo of Leeching', 'Echo of Starvation', 'Echo of Undermining'] });
    expect(plan.unowned).toEqual([
      { name: 'Echo of Starvation', price: 'Glimmer x10000', locked: undefined },
      { name: 'Echo of Undermining', price: undefined, locked: "the vendor doesn't offer it" },
    ]);
    expect(planSubclassSetup(withOwnership, defs, 'hunter', { fragments: ['Echo of Leeching'] }).unowned).toBeUndefined();
  });

  it('keeps the equipped setup when nothing is planned', () => {
    const plan = planSubclassSetup(summary, defs, 'hunter');
    expect(plan.fragments.map((f) => f.name)).toEqual(['Echo of Exchange']);
    expect(plan.bonus).toEqual([0, 0, 0, 0, 0, 10]);
  });

  it('plans with new aspects and keeps unspecified fragments as equipped', () => {
    const plan = planSubclassSetup(summary, defs, 'hunter', { aspects: ['on the prowl'] });
    expect(plan.aspects.map((a) => a.name)).toEqual(['On the Prowl']);
    expect(plan.fragments.map((f) => f.name)).toEqual(['Echo of Exchange']);
    expect(plan.fragmentSlots).toEqual({ used: 1, available: 3 });
    expect(plan.warning).toBeUndefined();
  });

  it('warns when fragments are planned with no aspects', () => {
    const plan = planSubclassSetup(summary, defs, 'hunter', { aspects: [], fragments: ['Echo of Leeching'] });
    expect(plan.fragmentSlots).toEqual({ used: 1, available: 0 });
    expect(plan.warning).toMatch(/pick aspects that open fragment slots/);
  });

  it('accepts a unique partial name and rejects unknown or ambiguous ones', () => {
    expect(planSubclassSetup(summary, defs, 'hunter', { fragments: ['leech'] }).fragments[0].name).toBe('Echo of Leeching');
    expect(() => planSubclassSetup(summary, defs, 'hunter', { fragments: ['Echo of Nothing'] })).toThrow(/no fragment "Echo of Nothing"/);
    expect(() => planSubclassSetup(summary, defs, 'hunter', { fragments: ['Echo of'] })).toThrow(/matches several fragments/);
  });
});
