import { describe, expect, it } from 'vitest';
import type { DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import { Buckets } from '../src/inventory/constants.js';
import { buildInventory, namedStats, threeLowest } from '../src/inventory/model.js';
import { fixtureDefs } from './helpers.js';

const defs = fixtureDefs();
const HELMET = 2214884208; // New Demotic Cover (Armor 3.0 warlock helmet, part of a set)
const FATEBRINGER = 2171478765;

const STAT = { weapons: 2996146975, health: 392767087, class: 1943323491, grenade: 1735777505, super: 144602215, melee: 4244567218 };

function socketsFor(itemHash: number, overrides: Record<number, number>) {
  const def = defs.item(itemHash)!;
  return def.sockets!.socketEntries.map((e, i) => ({
    plugHash: overrides[i] ?? e.singleInitialItemHash,
    isEnabled: true,
    isVisible: true,
  }));
}

function profile(): DestinyProfileResponse {
  const warlockClass = Object.values(
    (defs.db.prepare('SELECT json FROM DestinyClassDefinition').all() as { json: string }[]).map((r) => JSON.parse(r.json)),
  ).find((c) => c.classType === 2);
  return {
    characters: {
      data: {
        w1: { characterId: 'w1', classType: 2, classHash: warlockClass.hash, raceHash: 0, light: 450, dateLastPlayed: '2026-09-20T00:00:00Z', stats: {} },
      },
    },
    profileInventory: {
      data: {
        items: [
          { itemHash: HELMET, itemInstanceId: 'helm1', quantity: 1, bucketHash: Buckets.Vault, state: 1 | 4, lockable: true, transferStatus: 0 },
        ],
      },
    },
    characterInventories: { data: { w1: { items: [] } } },
    characterEquipment: {
      data: {
        w1: {
          items: [{ itemHash: FATEBRINGER, itemInstanceId: 'fb1', quantity: 1, bucketHash: Buckets.Kinetic, state: 0, lockable: true, transferStatus: 1 }],
        },
      },
    },
    itemComponents: {
      instances: {
        data: {
          helm1: { gearTier: 4, primaryStat: { statHash: 0, value: 450 } },
          fb1: { damageTypeHash: 3373582085, primaryStat: { statHash: 0, value: 451 } },
        },
      },
      stats: {
        data: {
          // Live stats = rolled (G9 S29 M17) + masterwork (+5 to the 3 lowest: W, H, C) + tuning (+5 H, -5 M) + Grenade Mod (+10 G)
          helm1: {
            stats: {
              [STAT.weapons]: { statHash: STAT.weapons, value: 5 },
              [STAT.health]: { statHash: STAT.health, value: 10 },
              [STAT.class]: { statHash: STAT.class, value: 5 },
              [STAT.grenade]: { statHash: STAT.grenade, value: 19 },
              [STAT.super]: { statHash: STAT.super, value: 29 },
              [STAT.melee]: { statHash: STAT.melee, value: 12 },
            },
          },
        },
      },
      sockets: {
        data: {
          helm1: {
            sockets: socketsFor(HELMET, {
              0: 1435557120, // Grenade Mod (+10)
              5: 788990510, // fully masterworked
              6: 4227065942, // Paragon archetype
              7: 1370696615, // Super 29
              8: 412523243, // Melee 17
              9: 2077748651, // Grenade 9
              11: 388618952, // +Health / -Melee tuning
            }),
          },
          fb1: { sockets: socketsFor(FATEBRINGER, { 1: 839105230, 2: 1087426260, 3: 3418782618, 4: 1015611457 }) },
        },
      },
      reusablePlugs: {
        data: {
          fb1: {
            plugs: {
              1: [
                { plugItemHash: 839105230, canInsert: true, enabled: true },
                { plugItemHash: 1467527085, canInsert: true, enabled: true },
              ],
            },
          },
        },
      },
    },
  } as unknown as DestinyProfileResponse;
}

describe('buildInventory', () => {
  const inv = buildInventory(profile(), defs);

  it('resolves characters and locations', () => {
    expect(inv.characters).toHaveLength(1);
    expect(inv.characters[0].classType).toBe('warlock');
    const helm = inv.byId.get('helm1')!;
    expect(helm.location).toEqual({ type: 'vault' });
    expect(helm.locked).toBe(true);
    expect(helm.masterworked).toBe(true);
    const fb = inv.byId.get('fb1')!;
    expect(fb.equipped).toBe(true);
    expect(fb.location).toEqual({ type: 'character', characterId: 'w1' });
  });

  it('derives Armor 3.0 rolled, mod-free and masterworked stats', () => {
    const helm = inv.byId.get('helm1')!;
    expect(helm.kind).toBe('armor');
    expect(helm.gearTier).toBe(4);
    const a = helm.armor!;
    expect(a.legacy).toBe(false);
    expect(a.archetype).toBe('Paragon');
    expect(a.set?.name).toBeTruthy();
    expect(a.tuning?.name).toBe('+Health / -Melee');
    expect(a.mods.map((m) => m.name)).toEqual(['Grenade Mod']);
    // weapons, health, class, grenade, super, melee
    expect(a.base).toEqual([0, 0, 0, 9, 29, 17]);
    expect(a.noMods).toEqual([5, 10, 5, 9, 29, 12]);
    expect(a.masterworked).toEqual([5, 10, 5, 9, 29, 12]);
    expect(namedStats(a.noMods, defs)).toMatchObject({ Grenade: 9, Super: 29 });
  });

  it('reads weapon perks with selectable options', () => {
    const w = inv.byId.get('fb1')!.weapon!;
    expect(w.element).toBe('Kinetic');
    expect(w.ammo).toBe('primary');
    expect(w.intrinsic?.name).toBe('Adaptive Frame');
    const barrel = w.perks.find((p) => p.socketIndex === 1)!;
    expect(barrel.equipped.name).toBe('Arrowhead Brake');
    expect(barrel.options.map((o) => o.name)).toEqual(['Arrowhead Brake', 'Extended Barrel']);
    expect(w.perks.map((p) => p.equipped.name)).toEqual(['Arrowhead Brake', 'Appended Mag', 'Rewind Rounds', 'Kill Clip']);
  });
});

describe('threeLowest', () => {
  it('breaks ties in stat order', () => {
    expect(threeLowest([5, 5, 5, 5, 1, 9])).toEqual([4, 0, 1]);
  });
});
