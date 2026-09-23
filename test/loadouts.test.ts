import { describe, expect, it } from 'vitest';
import { buildLoadouts } from '../src/loadouts/loadouts.js';
import { WARLOCK, fixtureDefs, makeInventory, makeItem } from './helpers.js';

const defs = fixtureDefs();
const GAMMA = 752612101; // loadout name "Gamma"
const FATEBRINGER = 2171478765; // used here as a stand-in plug with a known name
const EMPTY_PLUG = 2166136261;

function inventoryWith(loadouts: unknown[]) {
  const inv = makeInventory([
    makeItem({ instanceId: 'a', name: 'Arbalest', kind: 'weapon', equipped: true, location: { type: 'character', characterId: WARLOCK } }),
    makeItem({ instanceId: 'b', name: 'Helm', equipped: true, location: { type: 'character', characterId: WARLOCK } }),
    makeItem({ instanceId: 'v', name: 'Vaulted', location: { type: 'vault' } }),
  ]);
  inv.raw = { characterLoadouts: { data: { [WARLOCK]: { loadouts } } } } as unknown as typeof inv.raw;
  return inv;
}
const saved = (items: { itemInstanceId: string; plugItemHashes?: number[] }[]) => ({
  colorHash: 0,
  iconHash: 0,
  nameHash: GAMMA,
  items: items.map((i) => ({ plugItemHashes: [], ...i })),
});

describe('buildLoadouts', () => {
  it('names loadouts, keeps slot indexes, and skips empty slots', () => {
    const inv = inventoryWith([saved([]), saved([{ itemInstanceId: 'a' }])]);
    const [l] = buildLoadouts(inv, defs);
    expect(buildLoadouts(inv, defs)).toHaveLength(1);
    expect(l).toMatchObject({ index: 1, name: 'Gamma', characterId: WARLOCK });
  });

  it('treats slots holding only placeholder items (id "0") as empty', () => {
    const inv = inventoryWith([saved([{ itemInstanceId: '0' }]), saved([{ itemInstanceId: 'a' }])]);
    expect(buildLoadouts(inv, defs).map((l) => l.index)).toEqual([1]);
  });

  it('marks a loadout active only when every item is equipped on that character', () => {
    const inv = inventoryWith([saved([{ itemInstanceId: 'a' }, { itemInstanceId: 'b' }]), saved([{ itemInstanceId: 'a' }, { itemInstanceId: 'v' }])]);
    expect(buildLoadouts(inv, defs).map((l) => l.active)).toEqual([true, false]);
  });

  it('flags items that no longer exist instead of dropping them', () => {
    const inv = inventoryWith([saved([{ itemInstanceId: 'a' }, { itemInstanceId: 'gone' }])]);
    const [l] = buildLoadouts(inv, defs);
    expect(l.items.map((i) => [i.id, i.missing, i.equipped])).toEqual([
      ['a', false, true],
      ['gone', true, false],
    ]);
    expect(l.active).toBe(false);
  });

  it('resolves plug names and drops the empty-socket sentinel', () => {
    const inv = inventoryWith([saved([{ itemInstanceId: 'a', plugItemHashes: [EMPTY_PLUG, FATEBRINGER, 0] }])]);
    expect(buildLoadouts(inv, defs)[0].items[0].plugs).toEqual(['Fatebringer']);
  });
});
