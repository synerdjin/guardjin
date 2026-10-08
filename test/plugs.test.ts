import { describe, expect, it } from 'vitest';
import { currentPlugProgress, itemSockets, planPlugChanges, socketOptions, type PlugRequest } from '../src/sockets/plugs.js';
import { WARLOCK, fixtureDefs, helmetFixture, makeInventory, makeItem } from './helpers.js';

const defs = fixtureDefs();
const { HELMET, EMPTY_GENERAL, EMPTY_HEAD, DEFAULT_SHADER, UPGRADE_ARMOR, GRENADE_MOD, MINOR_GRENADE_MOD, ASHES_TO_ASSETS, HEAVY_AMMO_FINDER, GENERAL_SET, HEAD_SET } = helmetFixture;

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
    const profile = new ProfileService(http, { get: async () => ({ membershipType: 3, membershipId: '1' }) } as never, { load: async () => defs } as never);

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

  it('rebuilds the item from live data, keeping its location and equipped state', async () => {
    const { ProfileService } = await import('../src/inventory/profile.js');
    const { inv, helm } = setup({ capacity: 10, used: 3 });
    const live = {
      item: { data: { itemHash: HELMET, itemInstanceId: 'helm1', quantity: 1, bucketHash: 3448274439, state: 0, lockable: true, transferStatus: 0 } },
      sockets: { data: { sockets: [EMPTY_GENERAL, ASHES_TO_ASSETS, EMPTY_HEAD, EMPTY_HEAD, DEFAULT_SHADER, UPGRADE_ARMOR].map((plugHash) => ({ plugHash, isEnabled: true, isVisible: true })) } },
      instance: { data: { energy: { energyCapacity: 10, energyUsed: 3 }, primaryStat: { statHash: 0, value: 777 } } },
    };
    const http = (async () => ({ Response: live, ErrorCode: 1 })) as never;
    const profile = new ProfileService(http, { get: async () => ({ membershipType: 3, membershipId: '1' }) } as never, { load: async () => defs } as never);
    helm.equipped = true;

    profile.recordPlug('helm1', 0, GRENADE_MOD, 4);
    await profile.refreshItem(inv, helm);
    expect(helm).toMatchObject({ power: 777, equipped: true, location: { type: 'character', characterId: WARLOCK } });
    expect(helm.armor?.energy).toEqual({ capacity: 10, used: 4 });
    expect(inv.byId.get('helm1')).toBe(helm);
  });
});

describe('plug details', () => {
  const ENEMIES_DEFEATED = 3725354261; // objective "Enemies Defeated"

  it('shows unlock progress for blocked options', () => {
    const { inv, helm } = setup();
    (inv.raw.profilePlugSets!.data!.plugs as Record<number, unknown[]>)[GENERAL_SET] = [
      { plugItemHash: MINOR_GRENADE_MOD, canInsert: false, enabled: true, insertFailIndexes: [], plugObjectives: [{ objectiveHash: ENEMIES_DEFEATED, progress: 45, completionValue: 100, complete: false, visible: true }] },
    ];
    const option = socketOptions(inv, defs, helm, 0).find((o) => o.hash === MINOR_GRENADE_MOD)!;
    expect(option.canInsert).toBe(false);
    expect(option.progress).toEqual([{ description: 'Enemies Defeated', progress: '45/100' }]);
  });

  it('gives no reasons or progress for options that can be inserted', () => {
    const { inv, helm } = setup();
    const option = socketOptions(inv, defs, helm, 0).find((o) => o.hash === GRENADE_MOD)!;
    expect(option).toMatchObject({ canInsert: true, reasons: [], progress: [] });
  });

  it('reads progress on the plug currently in a socket', () => {
    const { inv, helm } = setup();
    (inv.raw.itemComponents as unknown as Record<string, unknown>).plugObjectives = {
      data: { helm1: { objectivesPerPlug: { [ASHES_TO_ASSETS]: [{ objectiveHash: ENEMIES_DEFEATED, progress: 6029, completionValue: 1, complete: true, visible: true }] } } },
    };
    expect(currentPlugProgress(inv, defs, helm, ASHES_TO_ASSETS)).toEqual([{ description: 'Enemies Defeated', progress: '6029/1', complete: true }]);
    expect(currentPlugProgress(inv, defs, helm, GRENADE_MOD)).toEqual([]);
  });
});
