import { describe, expect, it } from 'vitest';
import { Buckets } from '../src/inventory/constants.js';
import { DEFAULT_RULES, triage, type KeepRules } from '../src/vault/triage.js';
import { fixtureDefs, makeInventory, makeItem } from './helpers.js';

const defs = fixtureDefs();
const rules: KeepRules = { ...DEFAULT_RULES, keepTopPowerPerSlot: 0 };
const set = { hash: 1, name: 'Techsec' };
const other = { hash: 2, name: 'Eutechnology' };
const decide = (items: ReturnType<typeof makeItem>[], candidates = items, r = rules, loadoutItemIds?: Set<string>) =>
  Object.fromEntries(triage(makeInventory(items), defs, candidates, r, { loadoutItemIds }).map((d) => [d.item.name, `${d.action}:${d.rule}`]));

describe('triage armor', () => {
  it('keeps T4–T5, yields T4 to a T5 of the same set and archetype, and keeps a lone T3 set piece', () => {
    const t5 = makeItem({ name: 'T5', gearTier: 5, set });
    const t4same = makeItem({ name: 'T4 same', gearTier: 4, set });
    const t4other = makeItem({ name: 'T4 other', gearTier: 4, set: other });
    const t3lone = makeItem({ name: 'T3 lone', gearTier: 3, set: { hash: 3, name: 'Lone' } });
    const t3dupe = makeItem({ name: 'T3 dupe', gearTier: 3, set });
    const t2 = makeItem({ name: 'T2', gearTier: 2 });
    expect(decide([t5, t4same, t4other, t3lone, t3dupe, t2])).toEqual({
      T5: 'keep:armor-tier',
      'T4 same': 'dismantle:armor-tier',
      'T4 other': 'keep:armor-tier',
      'T3 lone': 'keep:only-set-piece',
      'T3 dupe': 'dismantle:armor-tier',
      T2: 'dismantle:armor-tier',
    });
  });

  it('dismantles legacy armor unless it is top power, and keeps loadout pieces', () => {
    const legacy = makeItem({ name: 'Legacy', power: 300 });
    legacy.armor!.legacy = true;
    const inLoadout = makeItem({ name: 'Loadout T1', gearTier: 1 });
    expect(decide([legacy, inLoadout], undefined, rules, new Set([inLoadout.instanceId!]))).toEqual({
      Legacy: 'dismantle:legacy-armor',
      'Loadout T1': 'keep:loadout',
    });
    expect(decide([legacy], undefined, { ...rules, keepTopPowerPerSlot: 1 })).toEqual({ Legacy: 'keep:top-power' });
  });
});

describe('triage exotics', () => {
  it('keeps one copy, preferring new-gen over legacy', () => {
    const legacy = makeItem({ name: 'Nezarec', hash: 9, isExotic: true });
    legacy.armor!.legacy = true;
    const newGen = makeItem({ name: 'Nezarec', hash: 9, isExotic: true, gearTier: 2 });
    const out = triage(makeInventory([legacy, newGen]), defs, [legacy, newGen], rules);
    expect(out.map((d) => [d.item === newGen ? 'new' : 'legacy', d.action])).toEqual([
      ['legacy', 'dismantle'],
      ['new', 'keep'],
    ]);
  });

  it('sends exotic class items to review', () => {
    const bond = makeItem({ name: 'Solipsism', isExotic: true, bucketHash: Buckets.ClassItem });
    expect(decide([bond])).toEqual({ Solipsism: 'review:exotic-class-item' });
  });
});

describe('triage weapons', () => {
  const perkCol = (names: string[]) => ({ socketIndex: 3, equipped: { hash: 1, name: names[0] }, options: names.map((n, i) => ({ hash: i + 1, name: n })) });
  const weapon = (id: string, gearTier: number | undefined, perks: string[], power = 400) =>
    makeItem({ instanceId: id, kind: 'weapon', name: 'Bug-Out Bag', gearTier, power, weapon: { perks: [perkCol(perks)] } });

  it('keeps the highest tier copy, reviews copies with a preferred perk the best lacks', () => {
    const t5 = weapon('1', 5, ['Kill Clip']);
    const t3 = weapon('2', 3, ['Kill Clip']);
    const t2 = weapon('3', 2, ['Repulsor Brace']);
    const out = Object.fromEntries(triage(makeInventory([t5, t3, t2]), defs, [t5, t3, t2], rules).map((d) => [d.item.instanceId, d.action]));
    expect(out).toEqual({ 1: 'keep', 2: 'dismantle', 3: 'review' });
  });

  it('handles power-10 legacy weapons', () => {
    const only = weapon('1', undefined, ['Kill Clip'], 10);
    expect(triage(makeInventory([only]), defs, [only], rules)[0]).toMatchObject({ action: 'review', rule: 'power-ten' });
    const tiered = weapon('2', 4, ['Kill Clip']);
    expect(triage(makeInventory([only, tiered]), defs, [only], rules)[0]).toMatchObject({ action: 'dismantle', rule: 'power-ten' });
  });
});
