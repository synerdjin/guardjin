import { describe, expect, it } from 'vitest';
import { itemSockets, planPlugChanges, type PlugRequest } from '../src/sockets/plugs.js';
import { WARLOCK, fixtureDefs, makeInventory, makeItem } from './helpers.js';

const defs = fixtureDefs();
const HELMET = 2214884208; // New Demotic Cover: 0 general mod, 1-3 head mods, 4 shader, 5 masterwork
const EMPTY_GENERAL = 1980618587;
const EMPTY_HEAD = 1078080765;
const DEFAULT_SHADER = 4248210736;
const UPGRADE_ARMOR = 788990507;
const GRENADE_MOD = 3896141096; // cost 1
const MINOR_GRENADE_MOD = 4021790309;
const ASHES_TO_ASSETS = 856936828; // cost 3
const HEAVY_AMMO_FINDER = 644105; // cost 1
const GENERAL_SET = 731468111;
const HEAD_SET = 2037229815;

function setup(energy = { capacity: 10, used: 3 }) {
  const helm = makeItem({ instanceId: 'helm1', hash: HELMET, location: { type: 'character', characterId: WARLOCK } });
  helm.armor!.energy = { ...energy };
  const inv = makeInventory([helm]);
  const socket = (plugHash: number, isVisible = true) => ({ plugHash, isEnabled: true, isVisible });
  inv.raw = {
    itemComponents: {
      sockets: {
        data: {
          helm1: {
            sockets: [socket(EMPTY_GENERAL), socket(ASHES_TO_ASSETS), socket(EMPTY_HEAD), socket(EMPTY_HEAD, false), socket(DEFAULT_SHADER), socket(UPGRADE_ARMOR)],
          },
        },
      },
    },
    profilePlugSets: {
      data: {
        plugs: {
          [GENERAL_SET]: [
            { plugItemHash: GRENADE_MOD, canInsert: true, enabled: true },
            { plugItemHash: MINOR_GRENADE_MOD, canInsert: false, enabled: true },
          ],
          [HEAD_SET]: [
            { plugItemHash: ASHES_TO_ASSETS, canInsert: true, enabled: true },
            { plugItemHash: HEAVY_AMMO_FINDER, canInsert: true, enabled: true },
          ],
        },
      },
    },
  } as unknown as typeof inv.raw;
  return { inv, helm };
}

const plan = (reqs: Omit<PlugRequest, 'item'>[], energy?: { capacity: number; used: number }) => {
  const { inv, helm } = setup(energy);
  return planPlugChanges(inv, defs, reqs.map((r) => ({ ...r, item: helm })));
};

describe('itemSockets', () => {
  it('lists visible sockets and protects the masterwork socket', () => {
    const { inv, helm } = setup();
    const sockets = itemSockets(inv, defs, helm);
    expect(sockets.map((s) => s.index)).toEqual([0, 1, 2, 4, 5]);
    expect(sockets.find((s) => s.index === 5)?.changeable).toBe(false);
    expect(sockets.filter((s) => s.changeable).map((s) => s.index)).toEqual([0, 1, 2, 4]);
  });
});

describe('planPlugChanges', () => {
  it('puts a mod into the empty socket that accepts it and tracks energy', () => {
    const p = plan([{ plug: 'Grenade Mod' }, { plug: 'Heavy Ammo Finder' }]);
    expect(p.errors).toEqual([]);
    expect(p.changes.map((c) => [c.socketIndex, c.plug.name, c.replaces, c.energy?.used])).toEqual([
      [0, 'Grenade Mod', 'Empty Mod Socket', 4],
      [2, 'Heavy Ammo Finder', 'Empty Mod Socket', 5],
    ]);
  });

  it('reports plugs that are already in place instead of changing anything', () => {
    const p = plan([{ plug: 'Ashes to Assets' }, { plug: 'Grenade Mod' }, { plug: 'Grenade Mod' }]);
    expect(p.changes).toHaveLength(1);
    expect(p.unchanged).toHaveLength(2);
  });

  it('refuses plugs that are not unlocked, do not fit, or exceed energy', () => {
    const p = plan([{ plug: 'Minor Grenade Mod' }, { plug: 'Grenade Mod', socket: 1 }], { capacity: 10, used: 3 });
    expect(p.changes).toEqual([]);
    expect(p.errors[0]).toMatch(/can't be inserted right now/);
    expect(p.errors[1]).toMatch(/no socket 1 on this item accepts it/);

    const tight = plan([{ plug: 'Grenade Mod' }, { plug: 'Ashes to Assets', socket: 2 }], { capacity: 5, used: 3 });
    expect(tight.changes.map((c) => c.plug.name)).toEqual(['Grenade Mod']);
    expect(tight.errors[0]).toMatch(/not enough armor energy \(7\/5/);
  });

  it('never touches masterworks', () => {
    const p = plan([{ plug: 'Upgrade Armor' }, { plug: String(UPGRADE_ARMOR), socket: 5 }]);
    expect(p.changes).toEqual([]);
    expect(p.errors).toHaveLength(2);
    expect(p.errors.every((e) => /not changed by this tool/.test(e))).toBe(true);
  });

  it('removes a mod by name, giving its energy back, and frees the socket for the next request', () => {
    const p = plan([{ plug: 'Ashes to Assets', remove: true }, { plug: 'Heavy Ammo Finder' }, { plug: 'Heavy Ammo Finder', socket: 1 }]);
    expect(p.errors).toEqual([]);
    expect(p.changes.map((c) => [c.socketIndex, c.plug.hash, c.energy?.used])).toEqual([
      [1, EMPTY_HEAD, 0],
      [1, HEAVY_AMMO_FINDER, 1],
    ]);
    // The third request found the mod already placed by the second.
    expect(p.unchanged).toHaveLength(1);
  });

  it('asks which socket to empty when a removal is ambiguous', () => {
    const p = plan([{ remove: true }]);
    expect(p.errors[0]).toMatch(/say which socket to empty: 0: Empty Mod Socket/);
  });
});

describe('recent-write overlay', () => {
  it('keeps a confirmed plug and its energy visible while Bungie\'s read data is stale', async () => {
    const { ProfileService } = await import('../src/inventory/profile.js');
    const { inv, helm } = setup({ capacity: 10, used: 3 });
    const staleSockets = [EMPTY_GENERAL, ASHES_TO_ASSETS, EMPTY_HEAD, EMPTY_HEAD, DEFAULT_SHADER, UPGRADE_ARMOR].map((plugHash) => ({ plugHash, isEnabled: true, isVisible: true }));
    const http = (async () => ({
      Response: {
        sockets: { data: { sockets: staleSockets.map((s) => ({ ...s })) } },
        instance: { data: { energy: { energyCapacity: 10, energyUsed: 3 } } },
      },
      ErrorCode: 1,
    })) as never;
    const profile = new ProfileService(http, { get: async () => ({ membershipType: 3, membershipId: '1' }) } as never, {} as never);

    profile.recordPlug('helm1', 0, GRENADE_MOD, 4);
    await profile.refreshItem(inv, helm);
    const sockets = itemSockets(inv, defs, helm);
    expect(sockets.find((s) => s.index === 0)?.current?.hash).toBe(GRENADE_MOD);
    expect(sockets.find((s) => s.index === 2)?.current?.hash).toBe(EMPTY_HEAD); // untouched sockets keep live data
    expect(helm.armor?.energy).toEqual({ capacity: 10, used: 4 });

    // Planning now sees the mod as already placed, instead of trying to insert it again.
    const p = planPlugChanges(inv, defs, [{ item: helm, plug: 'Grenade Mod' }]);
    expect(p.changes).toEqual([]);
    expect(p.unchanged).toHaveLength(1);
  });
});
