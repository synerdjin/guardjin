import { describe, expect, it, vi } from 'vitest';
import { clipPair, patchReports, yourGameUpdates } from '../src/builds/patchChanges.js';
import { diffPlugs } from '../src/manifest/diff.js';
import { SnapshotStore, type ManifestUpdate } from '../src/store/snapshots.js';
import { EMPTY_PLUG } from '../src/loadouts/loadouts.js';
import { WARLOCK, defsFrom, fixtureDefs, helmetFixture, makeInventory, makeItem, socketStates, withHashes } from './helpers.js';

const BIG_HASH = 3896141096; // above 2^31: manifest tables store it as a negative id

const plug = (name: string, description: string, extra: object = {}) => ({ displayProperties: { name, description }, plug: { plugCategoryIdentifier: 'frames' }, ...extra });
const perk = (description: string, isDisplayable = true) => ({ displayProperties: { name: 'Perk', description }, isDisplayable });
const stat = (name: string) => ({ displayProperties: { name } });

function manifest(items: Record<number, object>, perks: Record<number, object> = {}) {
  return defsFrom({
    DestinyInventoryItemDefinition: withHashes(items),
    DestinySandboxPerkDefinition: withHashes(perks),
    DestinyStatDefinition: withHashes({ 7: stat('Weapons'), 8: stat('Class') }),
  }).db;
}

describe('diffPlugs', () => {
  it('lists plugs whose description, perk text or stats changed, with before and after', () => {
    const before = manifest(
      {
        [BIG_HASH]: plug('Frenzy', 'Damage rises   while in combat.'),
        101: { ...plug('Echo', ''), perks: [{ perkHash: 900 }] },
        102: plug('Leeching', 'Heals.', { investmentStats: [{ statTypeHash: 7, value: 10 }] }),
        103: plug('Same', 'Unchanged.'),
        104: { displayProperties: { name: 'A Gun', description: 'Old flavor' } },
      },
      { 900: perk('Old perk text.') },
    );
    const after = manifest(
      {
        [BIG_HASH]: plug('Frenzy', 'Damage rises by 5% while in combat.'),
        101: { ...plug('Echo', ''), perks: [{ perkHash: 900 }] },
        102: plug('Leeching', 'Heals.', { investmentStats: [{ statTypeHash: 7, value: 5 }, { statTypeHash: 8, value: -10 }] }),
        103: plug('Same', 'Unchanged.'),
        104: { displayProperties: { name: 'A Gun', description: 'New flavor' } },
        105: plug('Brand New', 'Added in the update.'),
      },
      { 900: perk('New perk text.') },
    );
    expect(diffPlugs(before, after).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { hash: 101, name: 'Echo', before: 'Old perk text.', after: 'New perk text.' },
      { hash: BIG_HASH, name: 'Frenzy', before: 'Damage rises while in combat.', after: 'Damage rises by 5% while in combat.' },
      { hash: 102, name: 'Leeching', before: 'Stats: Weapons +10 | Heals.', after: 'Stats: Weapons +5, Class -10 | Heals.' },
    ]);
  });

  it('reports a plug that gains or loses all its text, and skips shaders and ornaments', () => {
    const shader = (description: string) => ({ ...plug('Gloss', description), plug: { plugCategoryIdentifier: 'shader' } });
    const ornament = (description: string) => ({ ...plug('Skin', description), plug: { plugCategoryIdentifier: 'armor_skins_hunter_chest' } });
    const before = manifest({ 1: plug('Quiet', ''), 2: plug('Loud', 'Says something.'), 3: shader('Old.'), 4: ornament('Old.') });
    const after = manifest({ 1: plug('Quiet', 'Now explained.'), 2: plug('Loud', ''), 3: shader('New.'), 4: ornament('New.') });
    expect(diffPlugs(before, after)).toEqual([
      { hash: 1, name: 'Quiet', before: '(nothing)', after: 'Now explained.' },
      { hash: 2, name: 'Loud', before: 'Says something.', after: '(nothing)' },
    ]);
  });

  it('ignores whitespace-only edits and perks the game does not display', () => {
    const before = manifest({ 1: plug('A', 'Same text.'), 2: { ...plug('B', ''), perks: [{ perkHash: 900 }] } }, { 900: perk('Hidden before.', false) });
    const after = manifest({ 1: plug('A', ' Same\ntext. '), 2: { ...plug('B', ''), perks: [{ perkHash: 900 }] } }, { 900: perk('Hidden after.', false) });
    expect(diffPlugs(before, after)).toEqual([]);
  });
});

describe('clipPair', () => {
  it('keeps the first difference of long texts in view', () => {
    const same = 'x'.repeat(500);
    const [before, after] = clipPair(`${same} heals 10`, `${same} heals 5`);
    expect(before).toMatch(/^….*heals 10$/);
    expect(after).toMatch(/^….*heals 5$/);
    expect(before.length).toBeLessThanOrEqual(400);
    expect(clipPair('short', 'shorter')).toEqual(['short', 'shorter']);
    expect(clipPair('a'.repeat(1000), 'b').map((s) => s.length)).toEqual([400, 1]);
  });
});

describe('manifest changes in the store', () => {
  const change = (hash: number) => ({ hash, name: `Plug ${hash}`, before: 'a', after: 'b' });

  it('records an update per version, newest first, and keeps the last five', () => {
    const store = new SnapshotStore(':memory:');
    for (let v = 1; v <= 6; v++) store.recordManifestChanges(`v${v}`, `v${v - 1}`, [change(v), change(v + 100)], v * 1000);
    const all = store.manifestUpdates();
    expect(all.map((u) => u.version)).toEqual(['v6', 'v5', 'v4', 'v3', 'v2']);
    expect(all[0]).toMatchObject({ previousVersion: 'v5', at: 6000 });
    expect(all[0].changes.map((c) => c.hash).sort((a, b) => a - b)).toEqual([6, 106]);
    expect(store.manifestUpdates(5000).map((u) => u.version)).toEqual(['v6']);
  });
});

describe('patchReports', () => {
  const { HELMET, EMPTY_GENERAL, EMPTY_HEAD, DEFAULT_SHADER, UPGRADE_ARMOR, ASHES_TO_ASSETS, HEAVY_AMMO_FINDER, GRENADE_MOD } = helmetFixture;
  const defs = fixtureDefs();
  const onWarlock = { type: 'character', characterId: WARLOCK } as const;
  const change = (hash: number, name: string) => ({ hash, name, before: 'old', after: 'new' });
  const update = (changes: ReturnType<typeof change>[]): ManifestUpdate => ({ version: 'v2', previousVersion: 'v1', at: Date.UTC(2026, 9, 6), changes });

  function inventory(opts: { equipped: boolean; exotic?: boolean }) {
    const helm = makeItem({ instanceId: 'helm', hash: HELMET, name: 'Helm', location: onWarlock, equipped: opts.equipped, isExotic: opts.exotic });
    const inv = makeInventory([helm]);
    inv.raw = {
      itemComponents: { sockets: { data: { helm: { sockets: socketStates([EMPTY_GENERAL, ASHES_TO_ASSETS, EMPTY_HEAD, EMPTY_HEAD, DEFAULT_SHADER, UPGRADE_ARMOR]) } } } },
      characterLoadouts: {
        data: { [WARLOCK]: { loadouts: [{ items: [] }, { nameHash: 0, items: [{ itemInstanceId: 'helm', plugItemHashes: [GRENADE_MOD, EMPTY_PLUG, HEAVY_AMMO_FINDER] }] }] } },
      },
    } as unknown as typeof inv.raw;
    return inv;
  }

  it('reports changes to plugs worn, saved in a loadout or on an owned exotic, and counts the rest', () => {
    const [report] = patchReports(inventory({ equipped: true }), defs, [
      update([change(ASHES_TO_ASSETS, 'Ashes to Assets'), change(GRENADE_MOD, 'Grenade Kickstart'), change(555, 'Unrelated')]),
    ]);
    expect(report).toMatchObject({ version: 'v2', previousVersion: 'v1', at: '2026-10-06T00:00:00.000Z', otherChanges: 1 });
    expect(report.changedInYourGear.map((c) => [c.name, c.usedBy])).toEqual([
      ['Ashes to Assets', ['Helm (equipped on Warlock)']],
      ['Grenade Kickstart', ['Warlock loadout 1: Loadout 2 (Helm)']],
    ]);
  });

  it('includes owned exotics even when they are not worn', () => {
    const ashes = [update([change(ASHES_TO_ASSETS, 'Ashes to Assets')])];
    expect(patchReports(inventory({ equipped: false, exotic: true }), defs, ashes)[0].changedInYourGear[0].usedBy).toEqual(['Helm (exotic you own)']);
    expect(patchReports(inventory({ equipped: false }), defs, ashes)[0].changedInYourGear).toEqual([]);
  });

  it('reports each stored update, newest first, against one walk of the gear', () => {
    const store = new SnapshotStore(':memory:');
    store.recordManifestChanges('v2', 'v1', [change(HEAVY_AMMO_FINDER, 'Heavy Ammo Finder')], 5000);
    store.recordManifestChanges('v3', 'v2', [change(ASHES_TO_ASSETS, 'Ashes to Assets'), change(HEAVY_AMMO_FINDER, 'Heavy Ammo Finder')], 6000);
    const reports = patchReports(inventory({ equipped: true }), defs, store.manifestUpdates());
    expect(reports.map((r) => [r.version, r.changedInYourGear.map((c) => c.name)])).toEqual([
      ['v3', ['Ashes to Assets', 'Heavy Ammo Finder']],
      ['v2', ['Heavy Ammo Finder']],
    ]);
    expect(patchReports(inventory({ equipped: true }), defs, store.manifestUpdates(6000))).toEqual([]);
  });

  it('yourGameUpdates keeps only updates that touch your gear and never throws', () => {
    const store = new SnapshotStore(':memory:');
    store.recordManifestChanges('v2', 'v1', [change(555, 'Unrelated')], 5000);
    expect(yourGameUpdates(store, inventory({ equipped: true }), defs)).toBeUndefined();
    store.recordManifestChanges('v3', 'v2', [change(ASHES_TO_ASSETS, 'Ashes to Assets')], 6000);
    expect(yourGameUpdates(store, inventory({ equipped: true }), defs)?.map((r) => r.version)).toEqual(['v3']);
    const broken = { manifestUpdates: () => { throw new Error('locked'); } } as unknown as SnapshotStore;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(yourGameUpdates(broken, inventory({ equipped: true }), defs)).toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
