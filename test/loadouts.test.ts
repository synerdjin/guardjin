import { describe, expect, it } from 'vitest';
import { buildLoadouts, checkSave, overlayPlugWrites } from '../src/loadouts/loadouts.js';
import { WARLOCK, fixtureDefs, makeInventory, makeItem } from './helpers.js';

const defs = fixtureDefs();
const GAMMA = 752612101; // loadout name "Gamma"
const FATEBRINGER = 2171478765; // used here as a stand-in plug with a known name
const EMPTY_PLUG = 2166136261;
const HEAVY_AMMO_FINDER = 644105;

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

describe('overlayPlugWrites', () => {
  const loadoutWith = (plugs: number[]) => buildLoadouts(inventoryWith([saved([{ itemInstanceId: 'a', plugItemHashes: plugs }])]), defs)[0];
  const wrote = (socket: number, plug: number) => (id: string) => (id === 'a' ? new Map([[socket, plug]]) : undefined);

  it('replaces the plug at a written socket and renames it', () => {
    const stale = loadoutWith([EMPTY_PLUG, HEAVY_AMMO_FINDER]);
    const { loadout, patched } = overlayPlugWrites(stale, wrote(1, FATEBRINGER), defs);
    expect(patched).toBe(true);
    expect(loadout.items[0].plugHashes).toEqual([EMPTY_PLUG, FATEBRINGER]);
    expect(loadout.items[0].plugs).toEqual(['Fatebringer']);
    expect(stale.items[0].plugs).toEqual(['Heavy Ammo Finder']);
  });

  it('leaves sockets the loadout does not record, such as weapon perks', () => {
    const r = overlayPlugWrites(loadoutWith([EMPTY_PLUG, HEAVY_AMMO_FINDER]), wrote(0, FATEBRINGER), defs);
    expect(r.patched).toBe(false);
    expect(r.loadout.items[0].plugHashes).toEqual([EMPTY_PLUG, HEAVY_AMMO_FINDER]);
  });

  it('is not patched when the loadout already holds the written plugs', () => {
    expect(overlayPlugWrites(loadoutWith([EMPTY_PLUG, FATEBRINGER]), wrote(1, FATEBRINGER), defs).patched).toBe(false);
  });

  it('changes nothing without recent writes', () => {
    const r = overlayPlugWrites(loadoutWith([FATEBRINGER]), () => undefined, defs);
    expect(r.patched).toBe(false);
    expect(r.loadout.items[0].plugs).toEqual(['Fatebringer']);
  });
});

describe('checkSave', () => {
  const slot = buildLoadouts(inventoryWith([saved([{ itemInstanceId: 'a', plugItemHashes: [HEAVY_AMMO_FINDER] }])]), defs)[0];
  const none = () => undefined;

  it('confirms a slot that shows the expected name and items', () => {
    expect(checkSave(slot, { name: 'Gamma', itemIds: ['a'] }, none, defs)).toEqual({ saved: slot, confirmed: true, modsPending: false });
  });

  it('shows nothing while the slot still has its old name or items', () => {
    expect(checkSave(slot, { name: 'Beta', itemIds: ['a'] }, none, defs)).toEqual({ confirmed: false, modsPending: false });
    expect(checkSave(slot, { name: 'Gamma', itemIds: ['b'] }, none, defs)).toEqual({ confirmed: false, modsPending: false });
    expect(checkSave(undefined, { name: 'Gamma', itemIds: [] }, none, defs)).toEqual({ confirmed: false, modsPending: false });
  });

  it('shows the mods we wrote, unconfirmed, while the slot still has the old ones', () => {
    const r = checkSave(slot, { name: 'Gamma', itemIds: ['a'] }, () => new Map([[0, FATEBRINGER]]), defs);
    expect(r.confirmed).toBe(false);
    expect(r.modsPending).toBe(true);
    expect(r.saved?.items[0].plugs).toEqual(['Fatebringer']);
  });
});
