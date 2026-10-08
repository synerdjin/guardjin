import type { DestinyVendorSaleItemComponent } from 'bungie-api-ts/destiny2';
import type { HttpClient, HttpClientConfig } from 'bungie-api-ts/http';
import { describe, expect, it, vi } from 'vitest';
import type { AccountService } from '../src/bungie/account.js';
import { describeSubclass, SUBCLASS_STAT_PLUG, type SubclassSummary } from '../src/inventory/subclass.js';
import { ProfileService } from '../src/inventory/profile.js';
import type { ManifestLoader } from '../src/manifest/manifest.js';
import { loadSubclassOwnership, subclassVendorIndex, subclassVendors } from '../src/world/subclassVendors.js';
import { defsFrom, HUNTER, makeInventory, makeItem, plugDef, withHashes } from './helpers.js';

const VOID_ASPECTS = 'hunter.void.aspects';
const VOID_FRAGMENTS = 'shared.void.fragments';
const GLIMMER = 3159615086;
const PROWL = 1001;
const TRAPPER = 1002;
const LEECHING = 2001;
const MERCY = 2002;
const SUBCLASS = 3001;

const sells = (name: string, enabled: boolean, ...hashes: number[]) => ({ displayProperties: { name }, enabled, failureStrings: ['', 'Requires Guardian Rank 3'], itemList: hashes.map((itemHash) => ({ itemHash })) });

/** Two plug categories sold by two vendors (plus a disabled duplicate and an unrelated vendor) and a subclass that sockets them. */
const defs = defsFrom({
  DestinyInventoryItemDefinition: withHashes({
    [PROWL]: plugDef('On the Prowl', VOID_ASPECTS),
    [TRAPPER]: plugDef("Trapper's Ambush", VOID_ASPECTS),
    [LEECHING]: plugDef('Echo of Leeching', VOID_FRAGMENTS),
    [MERCY]: plugDef('Ember of Mercy', 'shared.solar.fragments'),
    [GLIMMER]: { displayProperties: { name: 'Glimmer', description: '' } },
    [SUBCLASS]: {
      displayProperties: { name: 'Nightstalker', description: '' },
      sockets: {
        socketEntries: [{ socketTypeHash: 40 }, { socketTypeHash: 41 }],
        socketCategories: [
          { socketCategoryHash: 50, socketIndexes: [0] },
          { socketCategoryHash: 51, socketIndexes: [1] },
        ],
      },
    },
  }),
  DestinyVendorDefinition: withHashes({
    10: sells('Aspects', true, PROWL, TRAPPER),
    11: sells('Fragments', true, LEECHING),
    12: sells('Fragments', true, LEECHING),
    13: sells('Aspects', false, MERCY),
    14: sells('Xûr', true, MERCY),
  }),
  DestinySocketTypeDefinition: withHashes({
    40: { plugWhitelist: [{ categoryIdentifier: VOID_ASPECTS }] },
    41: { plugWhitelist: [{ categoryIdentifier: VOID_FRAGMENTS }] },
  }),
  DestinySocketCategoryDefinition: withHashes({ 50: { displayProperties: { name: 'ASPECTS' } }, 51: { displayProperties: { name: 'FRAGMENTS' } } }),
});

const nightstalker = makeItem({ kind: 'subclass', hash: SUBCLASS, name: 'Nightstalker', classType: 'hunter', location: { type: 'character', characterId: HUNTER } });
const section = (summary: SubclassSummary, category: string) => summary.sections.find((s) => s.category === category)!;

/** Sale entries as Bungie returns them: owned = NoUnlock status plus the Owned augment; not owned = purchasable. */
const sale = (itemHash: number, owned: boolean, costs: { itemHash: number; quantity: number }[] = [], blockedBy?: number) =>
  ({ itemHash, saleStatus: owned || blockedBy !== undefined ? 8 : 0, augments: owned ? 128 : 0, failureIndexes: owned ? [0] : blockedBy !== undefined ? [blockedBy] : [], costs }) as unknown as DestinyVendorSaleItemComponent;
const glimmer = (quantity: number) => [{ itemHash: GLIMMER, quantity }];

/** A profile whose vendors answer with the given sales (or fail). */
const profileWith = (sales: Record<number, DestinyVendorSaleItemComponent[]>, failing: number[] = []) => ({
  characterVendorSales: async (_c: string, vendorHash: number) => {
    if (failing.includes(vendorHash)) throw new Error('vendor unavailable');
    return sales[vendorHash] ?? [];
  },
});

describe('SUBCLASS_STAT_PLUG', () => {
  it.each(['hunter.void.aspects', 'warlock.stasis.totems', 'shared.stasis.trinkets', 'shared.prism.fragments'])('matches %s', (category) => {
    expect(SUBCLASS_STAT_PLUG.test(category)).toBe(true);
  });

  it.each(['hunter.void.supers', 'shared.void.fragment_sockets', 'armor_stats'])('does not match %s', (category) => {
    expect(SUBCLASS_STAT_PLUG.test(category)).toBe(false);
  });
});

describe('subclass vendors', () => {
  it('indexes plug categories by every enabled Aspects/Fragments vendor that sells them', () => {
    const index = subclassVendorIndex(defs);
    expect(index.get(VOID_ASPECTS)).toEqual([10]);
    expect(index.get(VOID_FRAGMENTS)).toEqual([11, 12]);
    expect(index.has('shared.solar.fragments')).toBe(false);
  });

  it('groups the vendors per category a subclass sockets', () => {
    expect(subclassVendors(nightstalker, defs)).toEqual([[10], [11, 12]]);
  });
});

describe('loadSubclassOwnership', () => {
  it('reads owned from the Owned augment and the price of what is not owned', async () => {
    const profile = profileWith({ 10: [sale(PROWL, true), sale(TRAPPER, false, glimmer(5000))], 11: [sale(LEECHING, true)] });
    const ownership = await loadSubclassOwnership(profile, defs, HUNTER, nightstalker);
    expect(ownership.get(PROWL)).toEqual({ owned: true, price: undefined, locked: undefined });
    expect(ownership.get(TRAPPER)).toEqual({ owned: false, price: 'Glimmer x5000', locked: undefined });
    expect(ownership.get(LEECHING)?.owned).toBe(true);
  });

  it('does not treat a cost as proof of not owning', async () => {
    const profile = profileWith({ 10: [sale(PROWL, true, glimmer(5000)), sale(TRAPPER, true)] });
    expect((await loadSubclassOwnership(profile, defs, HUNTER, nightstalker)).get(PROWL)?.owned).toBe(true);
  });

  it('says why a plug that is not owned cannot be bought yet', async () => {
    const profile = profileWith({ 10: [sale(PROWL, true), sale(TRAPPER, false, glimmer(5000), 1)] });
    expect((await loadSubclassOwnership(profile, defs, HUNTER, nightstalker)).get(TRAPPER)).toEqual({ owned: false, price: 'Glimmer x5000', locked: 'Requires Guardian Rank 3' });
  });

  it('keeps plugs the vendor defines but does not offer, with ownership unknown', async () => {
    const profile = profileWith({ 10: [sale(PROWL, true)] });
    const trapper = (await loadSubclassOwnership(profile, defs, HUNTER, nightstalker)).get(TRAPPER);
    expect(trapper?.owned).toBeUndefined();
    expect(trapper?.locked).toMatch(/doesn't offer it/);
  });

  it('falls back to the next vendor of a category when one fails or has no stock', async () => {
    const failing = profileWith({ 10: [sale(PROWL, true), sale(TRAPPER, true)], 12: [sale(LEECHING, false, glimmer(10000))] }, [11]);
    expect((await loadSubclassOwnership(failing, defs, HUNTER, nightstalker)).get(LEECHING)?.owned).toBe(false);
    const empty = profileWith({ 11: [], 12: [sale(LEECHING, true)] });
    expect((await loadSubclassOwnership(empty, defs, HUNTER, nightstalker)).get(LEECHING)?.owned).toBe(true);
  });

  it('passes fresh through to the vendor cache', async () => {
    const characterVendorSales = vi.fn(async () => [] as DestinyVendorSaleItemComponent[]);
    await loadSubclassOwnership({ characterVendorSales }, defs, HUNTER, nightstalker, true);
    expect(characterVendorSales).toHaveBeenCalledWith(HUNTER, 10, true);
  });
});

describe('describeSubclass with ownership', () => {
  const inv = makeInventory([nightstalker]);

  it('lists vendor aspects the profile leaves out, with owned and price, and counts them', () => {
    const ownership = new Map([
      [PROWL, { owned: true }],
      [TRAPPER, { owned: false, price: 'Glimmer x5000' }],
      [LEECHING, { owned: true }],
    ]);
    const summary = describeSubclass(nightstalker, inv, defs, true, ownership);
    expect(section(summary, 'ASPECTS').available?.map((p) => [p.name, p.owned, p.price])).toEqual([
      ['On the Prowl', true, undefined],
      ["Trapper's Ambush", false, 'Glimmer x5000'],
    ]);
    expect(section(summary, 'ASPECTS').owned).toBe('1/2');
    expect(section(summary, 'FRAGMENTS').owned).toBe('1/1');
    expect(summary.ownershipNote).toBeUndefined();
  });

  it('marks a section unknown when only the other vendor answered', () => {
    const profileListed = makeInventory([nightstalker]);
    profileListed.raw = { itemComponents: { reusablePlugs: { data: { [nightstalker.instanceId!]: { plugs: { 0: [{ plugItemHash: PROWL, canInsert: true, enabled: true }] } } } } } } as unknown as typeof profileListed.raw;
    const summary = describeSubclass(nightstalker, profileListed, defs, true, new Map([[LEECHING, { owned: true }]]));
    expect(section(summary, 'ASPECTS').owned).toBe('unknown');
    expect(section(summary, 'FRAGMENTS').owned).toBe('1/1');
    expect(summary.ownershipNote).toBeUndefined();
  });

  it('counts options the vendor does not list as unknown', () => {
    const profileListed = makeInventory([nightstalker]);
    profileListed.raw = { itemComponents: { reusablePlugs: { data: { [nightstalker.instanceId!]: { plugs: { 0: [{ plugItemHash: TRAPPER, canInsert: true, enabled: true }] } } } } } } as unknown as typeof profileListed.raw;
    const summary = describeSubclass(nightstalker, profileListed, defs, true, new Map([[PROWL, { owned: true }]]));
    expect(section(summary, 'ASPECTS').owned).toBe('1/1 (1 unknown)');
  });

  it('notes when ownership could not be determined for options the profile lists', () => {
    const profileOnly = makeInventory([nightstalker]);
    profileOnly.raw = { itemComponents: { reusablePlugs: { data: { [nightstalker.instanceId!]: { plugs: { 0: [{ plugItemHash: PROWL, canInsert: true, enabled: true }] } } } } } } as unknown as typeof profileOnly.raw;
    const summary = describeSubclass(nightstalker, profileOnly, defs, true, new Map());
    expect(section(summary, 'ASPECTS').available?.map((p) => p.name)).toEqual(['On the Prowl']);
    expect(summary.ownershipNote).toMatch(/ownership unknown/);
  });

  it('adds no ownership fields when it was not requested', () => {
    expect(describeSubclass(nightstalker, inv, defs, true).sections.every((s) => s.owned === undefined)).toBe(true);
  });
});

describe('ProfileService.characterVendorSales', () => {
  const account = { get: async () => ({ membershipType: 3, membershipId: 'm' }) } as unknown as AccountService;
  const setup = (fail = false) => {
    const http = vi.fn(async (_config: HttpClientConfig) => {
      if (fail) throw new Error('down');
      return { Response: { sales: { data: { 0: sale(PROWL, true) } } }, ErrorCode: 1 };
    });
    return { http, profile: new ProfileService(http as unknown as HttpClient, account, {} as ManifestLoader) };
  };

  it('caches per character and vendor, shares concurrent reads, keeps the cache across inventory invalidation, and refetches when fresh', async () => {
    const { http, profile } = setup();
    const [a, b] = await Promise.all([profile.characterVendorSales(HUNTER, 10), profile.characterVendorSales(HUNTER, 10)]);
    expect(a).toEqual([sale(PROWL, true)]);
    expect(b).toBe(a);
    await profile.characterVendorSales(HUNTER, 11);
    expect(http).toHaveBeenCalledTimes(2);
    profile.invalidate();
    await profile.characterVendorSales(HUNTER, 10);
    expect(http).toHaveBeenCalledTimes(2);
    await profile.characterVendorSales(HUNTER, 10, true);
    expect(http).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed read', async () => {
    const { http, profile } = setup(true);
    await expect(profile.characterVendorSales(HUNTER, 10)).rejects.toThrow();
    await expect(profile.characterVendorSales(HUNTER, 10)).rejects.toThrow();
    expect(http).toHaveBeenCalledTimes(2);
  });
});
