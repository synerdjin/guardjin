import { describe, expect, it } from 'vitest';
import type { PerkColumn } from '../src/inventory/model.js';
import type { Defs } from '../src/manifest/defs.js';
import { briefItem, itemLabel } from '../src/tools/util.js';
import { fixtureDefs, makeInventory, makeItem } from './helpers.js';

// Minimal definitions: hash -> [name, itemTypeDisplayName]
const PLUGS: Record<number, [string, string]> = {
  1: ['Arrowhead Brake', 'Barrel'],
  2: ['Appended Mag', 'Magazine'],
  3: ['Reconstruction', 'Trait'],
  4: ['Golden Tricorn', 'Trait'],
  5: ['Vorpal Weapon', 'Enhanced Trait'],
  6: ['Veist Stinger', 'Origin Trait'],
  7: ['Empty Traits Socket', 'Trait'],
};
const stubDefs = {
  item: (hash: number) => (PLUGS[hash] ? { displayProperties: { name: PLUGS[hash][0] }, itemTypeDisplayName: PLUGS[hash][1] } : undefined),
} as unknown as Pick<Defs, 'item'>;

const col = (hash: number, i: number): PerkColumn => ({ socketIndex: i, equipped: { hash, name: PLUGS[hash][0] }, options: [{ hash, name: PLUGS[hash][0] }] });
const weapon = (perks: number[], p: Parameters<typeof makeItem>[0] = {}) =>
  makeItem({ kind: 'weapon', name: 'The Call', power: 400, weapon: { perks: perks.map(col) }, ...p });

describe('itemLabel', () => {
  it('uses the two trait columns of a weapon', () => {
    expect(itemLabel(weapon([1, 2, 3, 4, 6]), stubDefs)).toBe('The Call · 400 · Reconstruction / Golden Tricorn');
  });

  it('counts enhanced traits and skips origin traits and empty sockets', () => {
    expect(itemLabel(weapon([1, 2, 6, 3, 5]), stubDefs)).toBe('The Call · 400 · Reconstruction / Vorpal Weapon');
    expect(itemLabel(weapon([1, 2, 7, 4]), stubDefs)).toBe('The Call · 400 · Golden Tricorn');
  });

  it('adds tier, locked and equipped flags', () => {
    expect(itemLabel(weapon([3, 4], { power: 408, gearTier: 5, locked: true, equipped: true }), stubDefs)).toBe(
      'The Call · 408 · T5 · Reconstruction / Golden Tricorn · locked · equipped',
    );
  });

  it('omits power when the item has none', () => {
    const item = weapon([3, 4]);
    item.power = undefined;
    expect(itemLabel(item, stubDefs)).toBe('The Call · Reconstruction / Golden Tricorn');
  });

  it('labels armor by archetype and stat total', () => {
    const helm = makeItem({ name: 'Helm', power: 450, gearTier: 3, stats6: [30, 20, 10, 5, 5, 5] });
    expect(itemLabel(helm, stubDefs)).toBe('Helm · 450 · T3 · Paragon 75');
    expect(itemLabel(helm, stubDefs, [35, 25, 15, 5, 5, 5])).toBe('Helm · 450 · T3 · Paragon 90');
  });

  it('labels exotic armor by its exotic perk', () => {
    const exotic = makeItem({ name: 'Spacewalk Gloves', power: 450, isExotic: true, stats6: [10, 10, 10, 10, 10, 10] });
    exotic.armor!.intrinsic = { hash: 99, name: 'Spacewalk' };
    expect(itemLabel(exotic, stubDefs)).toBe('Spacewalk Gloves · 450 · Spacewalk 60');
  });
});

describe('briefItem', () => {
  it('puts the label right after the id', () => {
    const defs = fixtureDefs();
    const perk = (hash: number) => ({ hash, name: defs.item(hash)!.displayProperties.name });
    const fb = makeItem({
      kind: 'weapon',
      hash: 2171478765,
      name: 'Fatebringer',
      power: 451,
      locked: true,
      weapon: { perks: [839105230, 1087426260, 2450788523, 1015611457].map((h, i) => ({ socketIndex: i + 1, equipped: perk(h), options: [perk(h)] })) },
    });
    const out = briefItem(fb, makeInventory([fb]), defs);
    expect(Object.keys(out).slice(0, 2)).toEqual(['id', 'label']);
    expect(out.label).toBe('Fatebringer · 451 · Killing Wind / Kill Clip · locked');
  });
});
