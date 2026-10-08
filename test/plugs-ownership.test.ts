import { describe, expect, it, vi } from 'vitest';
import { applyPlugChanges, livePreparer, POLL_SECONDS, socketOwnership, type ApplyDeps, type PlugChangeRequest } from '../src/sockets/apply.js';
import { findPlugs, planPlugChanges, socketOptions, touchesSubclassPlugs, type PlugResult } from '../src/sockets/plugs.js';
import type { PlugOwnership } from '../src/world/subclassVendors.js';
import { defsFrom, HUNTER, makeInventory, makeItem, plugDef, withHashes } from './helpers.js';

const ASPECT_CATEGORY = 900;
const FRAGMENT_CATEGORY = 901;
const PROWL = 1001;
const TRAPPER = 1002;
const LEECHING = 2001;
const SUBCLASS = 3001;
const ASPECT_SET = 7000;
const FRAGMENT_SET = 7001;

/** A Hunter Void-like subclass with one aspect socket and one fragment socket. */
const defs = defsFrom({
  DestinyInventoryItemDefinition: withHashes({
    [PROWL]: plugDef('On the Prowl', 'hunter.void.aspects', ASPECT_CATEGORY),
    [TRAPPER]: plugDef("Trapper's Ambush", 'hunter.void.aspects', ASPECT_CATEGORY),
    [LEECHING]: plugDef('Echo of Leeching', 'shared.void.fragments', FRAGMENT_CATEGORY),
    [SUBCLASS]: {
      displayProperties: { name: 'Nightstalker', description: '' },
      sockets: {
        socketEntries: [
          { socketTypeHash: 40, reusablePlugSetHash: ASPECT_SET },
          { socketTypeHash: 41, reusablePlugSetHash: FRAGMENT_SET },
        ],
        socketCategories: [{ socketCategoryHash: 50, socketIndexes: [0, 1] }],
      },
    },
  }),
  DestinyVendorDefinition: withHashes({
    10: { displayProperties: { name: 'Aspects' }, enabled: true, itemList: [{ itemHash: PROWL }, { itemHash: TRAPPER }] },
    11: { displayProperties: { name: 'Fragments' }, enabled: true, itemList: [{ itemHash: LEECHING }] },
  }),
  DestinySocketTypeDefinition: withHashes({
    40: { plugWhitelist: [{ categoryHash: ASPECT_CATEGORY, categoryIdentifier: 'hunter.void.aspects' }] },
    41: { plugWhitelist: [{ categoryHash: FRAGMENT_CATEGORY, categoryIdentifier: 'shared.void.fragments' }] },
  }),
  DestinySocketCategoryDefinition: withHashes({ 50: { displayProperties: { name: 'ASPECTS' } } }),
});

const nightstalker = makeItem({ instanceId: 'sc1', kind: 'subclass', hash: SUBCLASS, name: 'Nightstalker', classType: 'hunter', location: { type: 'character', characterId: HUNTER } });

/** The profile as Bungie reports it: which plugs it lets you insert. */
function profile(insertable: number[]) {
  const inv = makeInventory([nightstalker]);
  const listed = (hashes: number[]) => hashes.map((plugItemHash) => ({ plugItemHash, canInsert: insertable.includes(plugItemHash), enabled: true }));
  inv.raw = {
    itemComponents: { sockets: { data: { sc1: { sockets: [{ plugHash: 0, isEnabled: true, isVisible: true }, { plugHash: 0, isEnabled: true, isVisible: true }] } } } },
    profilePlugSets: { data: { plugs: { [ASPECT_SET]: listed([PROWL, TRAPPER]), [FRAGMENT_SET]: listed([LEECHING]) } } },
  } as unknown as typeof inv.raw;
  return inv;
}

const own = (o: PlugOwnership) => o;
const vendorSays = new Map<number, PlugOwnership>([
  [PROWL, own({ owned: true })],
  [TRAPPER, own({ owned: false, price: 'Glimmer x5000' })],
  [LEECHING, own({ owned: false, price: 'Glimmer x10000' })],
]);

describe('socketOptions with vendor ownership', () => {
  const optionOf = (inv: ReturnType<typeof profile>, socket: number, hash: number) => socketOptions(inv, defs, nightstalker, socket, vendorSays).find((o) => o.hash === hash)!;

  it('blocks a fragment the profile calls insertable when the vendor says it is not bought', () => {
    const option = optionOf(profile([PROWL, TRAPPER, LEECHING]), 1, LEECHING);
    expect(option).toMatchObject({ canInsert: false, reasons: ['not bought (costs Glimmer x10000)'] });
  });

  it('offers a bought plug the profile still blocks, flagged as stale', () => {
    const option = optionOf(profile([]), 0, PROWL);
    expect(option).toMatchObject({ canInsert: true, staleProfile: true, reasons: [] });
  });

  it('lists a bought plug the profile omits entirely, flagged as stale', () => {
    const inv = profile([]);
    (inv.raw.profilePlugSets!.data!.plugs as Record<number, unknown[]>)[ASPECT_SET] = [];
    expect(optionOf(inv, 0, PROWL)).toMatchObject({ canInsert: true, staleProfile: true });
  });

  it('does not flag a bought plug the profile allows', () => {
    const option = optionOf(profile([PROWL]), 0, PROWL);
    expect(option.canInsert).toBe(true);
    expect(option.staleProfile).toBeUndefined();
  });

  it('changes nothing without ownership', () => {
    const option = socketOptions(profile([PROWL, TRAPPER, LEECHING]), defs, nightstalker, 1).find((o) => o.hash === LEECHING)!;
    expect(option.canInsert).toBe(true);
  });
});

describe('planPlugChanges with vendor ownership', () => {
  const plan = (insertable: number[], plugName: string) => planPlugChanges(profile(insertable), defs, [{ item: nightstalker, plug: plugName }], new Map([[nightstalker, vendorSays]]));

  it('explains a plug that is not bought, with its price', () => {
    const p = plan([TRAPPER], "Trapper's Ambush");
    expect(p.changes).toEqual([]);
    expect(p.errors[0]).toMatch(/can't be inserted: not bought \(costs Glimmer x5000\)/);
  });

  it('plans a bought plug even when the profile still blocks it', () => {
    const p = plan([], 'On the Prowl');
    expect(p.errors).toEqual([]);
    expect(p.changes.map((c) => [c.request, c.plug.name])).toEqual([[0, 'On the Prowl']]);
  });

  it('plans a bought plug the profile allows', () => {
    expect(plan([PROWL], 'On the Prowl').changes).toHaveLength(1);
  });

  it('still blocks on the profile alone when the vendors say nothing', () => {
    const p = planPlugChanges(profile([]), defs, [{ item: nightstalker, plug: 'On the Prowl' }]);
    expect(p.changes).toEqual([]);
    expect(p.errors[0]).toMatch(/can't be inserted right now/);
    expect(p.errors[0]).toMatch(/No Aspects\/Fragments vendor confirmed whether it is bought/);
  });

  it('does not add that note when a vendor answered, or for plugs that are not aspects or fragments', () => {
    expect(plan([TRAPPER], "Trapper's Ambush").errors[0]).not.toMatch(/No Aspects\/Fragments vendor/);
  });
});

describe('applyPlugChanges', () => {
  /** A scripted game whose first `rejections` inserts are rejected, as when Bungie's data is behind. */
  function game(opts: { rejections?: number; ownership?: Map<number, PlugOwnership>; insertable?: number[] } = {}) {
    let rejectionsLeft = opts.rejections ?? 0;
    const sleeps: number[] = [];
    const executed: string[] = [];
    const deps: ApplyDeps = {
      prepare: vi.fn(async (requests: PlugChangeRequest[]) => ({
        inv: profile(opts.insertable ?? []),
        defs,
        requests: requests.map((r) => ({ ...r, item: nightstalker })),
        ownership: new Map([[nightstalker, opts.ownership ?? vendorSays]]),
      })),
      execute: async (plan): Promise<PlugResult[]> =>
        plan.changes.map((c) => {
          executed.push(c.plug.name);
          const ok = rejectionsLeft-- <= 0;
          return { itemId: 'sc1', plugHash: c.plug.hash, item: c.item.name, socket: c.socketIndex, plug: c.plug.name, ok, error: ok ? undefined : 'Not Yet Unlocked' };
        }),
      sleep: async (ms) => void sleeps.push(ms / 1000),
    };
    return { deps, sleeps, executed };
  }
  const prowl: PlugChangeRequest = { item: 'sc1', plug: 'On the Prowl' };

  it('inserts a bought plug the profile blocks, without waiting', async () => {
    const { deps, sleeps, executed } = game();
    const out = await applyPlugChanges(deps, [prowl]);
    expect(executed).toEqual(['On the Prowl']);
    expect(out.results.map((r) => r.ok)).toEqual([true]);
    expect(out.errors).toEqual([]);
    expect(sleeps).toEqual([]);
  });

  it('reports a rejected insert with the vendor\'s view and does not wait by default', async () => {
    const { deps, sleeps } = game({ rejections: 99 });
    const out = await applyPlugChanges(deps, [prowl]);
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].error).toMatch(/Not Yet Unlocked \(the vendor says it is bought, so Bungie's data may still be catching up/);
    expect(sleeps).toEqual([]);
    expect(out.waitedSeconds).toBe(0);
  });

  it('retries a rejected insert until it goes through and reports what resolved after waiting', async () => {
    const { deps, sleeps, executed } = game({ rejections: 2 });
    const out = await applyPlugChanges(deps, [prowl], { waitSeconds: 120 });
    expect(sleeps).toEqual([POLL_SECONDS, POLL_SECONDS]);
    expect(executed).toEqual(['On the Prowl', 'On the Prowl', 'On the Prowl']);
    expect(out.results.map((r) => r.ok)).toEqual([true]);
    expect(out.waitedSeconds).toBe(30);
    expect(out.resolvedAfterWait).toEqual(['Nightstalker ← On the Prowl']);
  });

  it('stops when the time runs out, trimming the last pause, and keeps the failure', async () => {
    const { deps, sleeps } = game({ rejections: 99 });
    const out = await applyPlugChanges(deps, [prowl], { waitSeconds: 40 });
    expect(sleeps).toEqual([15, 15, 10]);
    expect(out.results[0].ok).toBe(false);
    expect(out.resolvedAfterWait).toEqual([]);
  });

  it('never waits for a plug that is not bought', async () => {
    const { deps, sleeps, executed } = game({ rejections: 99 });
    const out = await applyPlugChanges(deps, [{ item: 'sc1', plug: "Trapper's Ambush" }], { waitSeconds: 120 });
    expect(sleeps).toEqual([]);
    expect(executed).toEqual([]);
    expect(out.errors[0]).toMatch(/not bought \(costs Glimmer x5000\)/);
  });

  it('retries only the requests that were rejected and leaves finished ones alone', async () => {
    const { deps, executed } = game({ rejections: 1 });
    const out = await applyPlugChanges(deps, [{ item: 'sc1', plug: 'Echo of Leeching' }, prowl, { item: 'sc1', plug: "Trapper's Ambush" }], { waitSeconds: 60 });
    // Leeching and Trapper's are not bought; Prowl is rejected once, then goes through alone.
    expect(executed).toEqual(['On the Prowl', 'On the Prowl']);
    expect(out.errors).toHaveLength(2);
    expect(out.results.map((r) => [r.plug, r.ok])).toEqual([['On the Prowl', true]]);
  });

  it('does not wait for a rejected aspect that no vendor shows bought', async () => {
    // Prismatic-like: the vendors say nothing, the profile lets it through, the game rejects it for good.
    const { deps, sleeps, executed } = game({ rejections: 99, ownership: new Map(), insertable: [PROWL] });
    const out = await applyPlugChanges(deps, [prowl], { waitSeconds: 120 });
    expect(executed).toEqual(['On the Prowl']);
    expect(sleeps).toEqual([]);
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].error).toBe('Not Yet Unlocked');
  });

  it('says loading the character may help once the wait has run out', async () => {
    const { deps } = game({ rejections: 99 });
    const out = await applyPlugChanges(deps, [prowl], { waitSeconds: 15 });
    expect(out.results[0].error).toMatch(/still refused it after 15s; loading into the game on that character/);
  });

  it('does not wait or insert on a dry run', async () => {
    const { deps, sleeps, executed } = game({ rejections: 99 });
    const out = await applyPlugChanges(deps, [prowl], { dryRun: true, waitSeconds: 60 });
    expect(sleeps).toEqual([]);
    expect(executed).toEqual([]);
    expect(out.changes.map((c) => c.plug.name)).toEqual(['On the Prowl']);
  });

  it('announces each wait', async () => {
    const { deps } = game({ rejections: 2 });
    const waits: number[] = [];
    await applyPlugChanges({ ...deps, onWait: (waited, total) => void waits.push(waited, total) }, [prowl], { waitSeconds: 120 });
    expect(waits).toEqual([0, 120, 15, 120]);
  });
});

describe('touchesSubclassPlugs', () => {
  it('is true for aspect and fragment sockets and plugs, false for anything else', () => {
    expect(touchesSubclassPlugs(defs, nightstalker, { socket: 0 })).toBe(true);
    expect(touchesSubclassPlugs(defs, nightstalker, { plug: 'On the Prowl' })).toBe(true);
    expect(touchesSubclassPlugs(defs, nightstalker, { plug: 'Echo of Leeching' })).toBe(true);
    expect(touchesSubclassPlugs(defs, nightstalker, { socket: 9 })).toBe(false);
    expect(touchesSubclassPlugs(defs, nightstalker, { plug: 'No Such Plug' })).toBe(false);
    expect(touchesSubclassPlugs(defs, nightstalker, {})).toBe(false);
  });
});

describe('findPlugs', () => {
  it('answers repeated searches from a cache', () => {
    expect(findPlugs(defs, 'On the Prowl')).toBe(findPlugs(defs, 'On the Prowl'));
    expect(findPlugs(defs, 'On the Prowl').map((d) => d.hash)).toEqual([PROWL]);
  });
});

describe('livePreparer', () => {
  function setup() {
    const inv = profile([]);
    const calls = { inventory: 0, refreshed: [] as string[], vendors: [] as (boolean | undefined)[] };
    const prep = livePreparer(
      {
        inventory: async () => (calls.inventory++, inv),
        refreshItem: async (_inv, item) => void calls.refreshed.push(item.instanceId!),
        characterVendorSales: async (_character, _vendor, fresh) => (calls.vendors.push(fresh), []),
      },
      { load: async () => defs },
      () => nightstalker,
    );
    return { prep, calls, inv };
  }

  it('reads the profile and the items once, then only the rejected items on a retry', async () => {
    const { prep, calls, inv } = setup();
    const first = await prep([{ item: 'sc1', plug: 'On the Prowl' }], false);
    expect(first.inv).toBe(inv);
    await prep([{ item: 'sc1', plug: 'On the Prowl' }], true);
    expect(calls.inventory).toBe(1);
    expect(calls.refreshed).toEqual(['sc1', 'sc1']);
  });

  it('reads the vendors fresh, and only for requests that touch aspects or fragments', async () => {
    const { prep, calls } = setup();
    const withAspect = await prep([{ item: 'sc1', plug: 'On the Prowl' }], false);
    expect(calls.vendors.length).toBeGreaterThan(0);
    expect(calls.vendors.every((fresh) => fresh === true)).toBe(true);
    expect(withAspect.ownership?.has(nightstalker)).toBe(true);

    calls.vendors.length = 0;
    const withoutAspect = await prep([{ item: 'sc1', plug: 'Grenade Mod', socket: 9 }], false);
    expect(calls.vendors).toEqual([]);
    expect(withoutAspect.ownership?.size).toBe(0);
  });

  it('gives an empty ownership map when the vendors do not answer, so refusals can say so', async () => {
    const { prep } = setup();
    const prepared = await prep([{ item: 'sc1', plug: 'On the Prowl' }], false);
    expect(prepared.ownership?.get(nightstalker)?.size).toBe(0);
    const p = planPlugChanges(prepared.inv, prepared.defs, prepared.requests, prepared.ownership);
    expect(p.errors[0]).toMatch(/No Aspects\/Fragments vendor confirmed/);
  });
});

describe('socketOwnership', () => {
  const setup = () => {
    const fresh: (boolean | undefined)[] = [];
    return { fresh, vendors: { characterVendorSales: async (_c: string, _v: number, f?: boolean) => (fresh.push(f), []) } };
  };

  it('reads ownership fresh for a visible aspect or fragment socket', async () => {
    const { vendors, fresh } = setup();
    expect(await socketOwnership(vendors, profile([]), defs, nightstalker, 0)).toBeInstanceOf(Map);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((f) => f === true)).toBe(true);
  });

  it('costs no vendor call for a hidden socket, a socket that is not an aspect or fragment, or a missing one', async () => {
    const { vendors, fresh } = setup();
    const hidden = profile([]);
    (hidden.raw.itemComponents!.sockets!.data!.sc1.sockets[1] as { isEnabled: boolean }).isEnabled = false;
    expect(await socketOwnership(vendors, hidden, defs, nightstalker, 1)).toBeUndefined();
    expect(await socketOwnership(vendors, profile([]), defs, nightstalker, 9)).toBeUndefined();
    expect(fresh).toEqual([]);
  });
});

