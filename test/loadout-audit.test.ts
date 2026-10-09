import { describe, expect, it } from 'vitest';
import { auditLoadout, auditSavedLoadout } from '../src/builds/loadoutAudit.js';
import { Buckets } from '../src/inventory/constants.js';
import { FRAGMENT_CAPACITY_STAT } from '../src/inventory/subclass.js';
import { EMPTY_PLUG, type Loadout, type LoadoutItem } from '../src/loadouts/loadouts.js';
import type { PlugOwnership } from '../src/world/subclassVendors.js';
import { vi } from 'vitest';
import { WARLOCK, defsFrom, fixtureDefs, helmetFixture, makeInventory, makeItem, plugDef, socketStates, withHashes } from './helpers.js';

const defs = fixtureDefs();
const { HELMET, EMPTY_GENERAL, EMPTY_HEAD, DEFAULT_SHADER, UPGRADE_ARMOR, GRENADE_MOD, ASHES_TO_ASSETS, HEAVY_AMMO_FINDER } = helmetFixture;
const onWarlock = { type: 'character', characterId: WARLOCK } as const;

/** The helmet as worn: a head mod in socket 1, the other mod slots empty. */
const LIVE_HELM = [EMPTY_GENERAL, ASHES_TO_ASSETS, EMPTY_HEAD, EMPTY_HEAD, DEFAULT_SHADER, UPGRADE_ARMOR];
/** A fully modded helmet, as worn and as saved (masterwork sockets aren't saved). */
const FULL_HELM = [GRENADE_MOD, ASHES_TO_ASSETS, HEAVY_AMMO_FINDER, HEAVY_AMMO_FINDER, DEFAULT_SHADER, UPGRADE_ARMOR];
const FULL_HELM_SAVED = [GRENADE_MOD, ASHES_TO_ASSETS, HEAVY_AMMO_FINDER, HEAVY_AMMO_FINDER, DEFAULT_SHADER, EMPTY_PLUG];
/** What a loadout saves for LIVE_HELM. */
const LIVE_HELM_SAVED = [EMPTY_PLUG, ASHES_TO_ASSETS, EMPTY_PLUG, EMPTY_PLUG, DEFAULT_SHADER, EMPTY_PLUG];

const saved = (id: string, plugHashes: number[], equipped: boolean): LoadoutItem => ({ id, name: id, plugs: [], plugHashes, equipped, missing: false });
const loadout = (items: LoadoutItem[]): Loadout => ({ index: 1, characterId: WARLOCK, name: 'Beta', items, active: false });

function helmet(opts: { energy?: { capacity: number; used: number }; masterworked?: boolean; equipped?: boolean } = {}) {
  const helm = makeItem({ instanceId: 'helm', hash: HELMET, name: 'Helm', location: onWarlock, masterworked: opts.masterworked ?? true, equipped: opts.equipped ?? true });
  helm.armor!.energy = opts.energy ?? { capacity: 10, used: 3 };
  return helm;
}

/** Audits `savedItems` against items whose live sockets are given per instance id. */
function audit(items: ReturnType<typeof makeItem>[], live: Record<string, number[]>, savedItems: LoadoutItem[], auditDefs = defs, ownership?: Map<number, PlugOwnership>) {
  const inv = makeInventory(items);
  inv.raw = { itemComponents: { sockets: { data: Object.fromEntries(Object.entries(live).map(([id, plugs]) => [id, { sockets: socketStates(plugs) }])) } } } as unknown as typeof inv.raw;
  return auditLoadout(inv, auditDefs, loadout(savedItems), ownership);
}

describe('auditLoadout gaps', () => {
  it('is clean when the saved loadout is complete and worn as saved', () => {
    const a = audit([helmet()], { helm: FULL_HELM }, [saved('helm', FULL_HELM_SAVED, true)]);
    expect(a).toMatchObject({ gaps: [], drift: [], resaveSuggested: false });
  });

  it('reports empty armor mod slots only when the piece has energy to fill them', () => {
    const a = audit([helmet()], { helm: LIVE_HELM }, [saved('helm', LIVE_HELM_SAVED, true)]);
    expect(a.gaps.map((g) => g.message)).toEqual([
      'Helm: mod slot 0 is empty (7 armor energy free)',
      'Helm: mod slot 2 is empty (7 armor energy free)',
      'Helm: mod slot 3 is empty (7 armor energy free)',
    ]);
    // Ashes to Assets (3) fills a 3-energy piece.
    expect(audit([helmet({ energy: { capacity: 3, used: 3 } })], { helm: LIVE_HELM }, [saved('helm', LIVE_HELM_SAVED, true)]).gaps).toEqual([]);
  });

  it('counts energy as equipping the loadout would leave it, not as the piece is modded now', () => {
    // Worn with every slot filled (6 energy), but the loadout only saves Ashes to Assets (3) and empties the rest.
    const savedSparse = [EMPTY_GENERAL, ASHES_TO_ASSETS, EMPTY_HEAD, EMPTY_HEAD, DEFAULT_SHADER, EMPTY_PLUG];
    const a = audit([helmet({ energy: { capacity: 7, used: 6 }, equipped: false })], { helm: FULL_HELM }, [saved('helm', savedSparse, false)]);
    expect(a.gaps).toEqual([]); // the slots are saved as empty plugs, so nothing is left unsaved and empty
    const unsaved = [EMPTY_PLUG, ASHES_TO_ASSETS, EMPTY_PLUG, EMPTY_PLUG, DEFAULT_SHADER, EMPTY_PLUG];
    const live = [EMPTY_GENERAL, ASHES_TO_ASSETS, EMPTY_HEAD, HEAVY_AMMO_FINDER, DEFAULT_SHADER, UPGRADE_ARMOR];
    // Equipping keeps Heavy Ammo Finder (unsaved socket): 3 + 1 = 4 of 7 used, 3 free, two slots still empty.
    expect(audit([helmet({ energy: { capacity: 7, used: 7 } })], { helm: live }, [saved('helm', unsaved, true)]).gaps.map((g) => g.message)).toEqual([
      'Helm: mod slot 0 is empty (3 armor energy free)',
      'Helm: mod slot 2 is empty (3 armor energy free)',
    ]);
  });

  it('does not call a slot empty when the loadout saved a mod for it', () => {
    expect(audit([helmet()], { helm: LIVE_HELM }, [saved('helm', FULL_HELM_SAVED, true)]).gaps).toEqual([]);
  });

  it('reports unmasterworked pieces, power-10 weapons and items that no longer exist', () => {
    const gun = makeItem({ instanceId: 'gun', kind: 'weapon', name: 'Old Gun', power: 10, location: onWarlock, equipped: true });
    const exotic = makeItem({ instanceId: 'ex', kind: 'weapon', name: 'Exo', isExotic: true, masterworked: false, location: onWarlock, equipped: true });
    const gone: LoadoutItem = { id: 'gone', plugs: ['Weapons Mod', 'Innervation'], plugHashes: [], equipped: false, missing: true };
    const a = audit([helmet({ masterworked: false, energy: { capacity: 3, used: 3 } }), gun, exotic], { helm: LIVE_HELM }, [saved('helm', LIVE_HELM_SAVED, true), saved('gun', [], true), saved('ex', [], true), gone]);
    expect(a.gaps.map((g) => g.message)).toEqual([
      'Helm is not masterworked',
      'Old Gun is a legacy weapon stuck at power 10; replace it with a current copy',
      'Exo is not masterworked (its catalyst is not finished)',
      'an item no longer exists (dismantled or deleted); it carried Weapons Mod, Innervation: re-save the slot without it',
    ]);
  });
});

describe('auditLoadout drift', () => {
  it('flags a mod that was swapped after saving, suggests putting it back, and says to re-save', () => {
    const a = audit([helmet()], { helm: [GRENADE_MOD, ASHES_TO_ASSETS, HEAVY_AMMO_FINDER, EMPTY_HEAD, DEFAULT_SHADER, UPGRADE_ARMOR] }, [saved('helm', FULL_HELM_SAVED, true)]);
    expect(a.drift).toEqual([{ area: 'plugs', message: 'Helm: ARMOR MODS 3 is Empty Mod Socket, saved Heavy Ammo Finder' }]);
    expect(a.suggested.plugs).toEqual([{ item: 'helm', plug: 'Heavy Ammo Finder', socket: 3, for: 'Helm armor mods' }]);
    expect(a.resaveSuggested).toBe(true);
  });

  it('flags saved pieces that are not worn, names what is worn instead, and suggests equipping them', () => {
    const other = makeItem({ instanceId: 'other', name: 'Other Helm', bucketHash: Buckets.Helmet, location: onWarlock, equipped: true });
    const a = audit([helmet({ equipped: false }), other], {}, [saved('helm', [], false)]);
    expect(a.drift).toEqual([{ area: 'equipped', message: 'Helm is not equipped (you are wearing Other Helm)' }]);
    expect(a.suggested.equip).toEqual([{ id: 'helm', name: 'Helm' }]);
    expect(a.resaveSuggested).toBe(true);
  });

  it('does not suggest re-saving when a piece has simply been taken off', () => {
    const a = audit([helmet({ equipped: false })], {}, [saved('helm', [], false)]);
    expect(a.drift).toHaveLength(1);
    expect(a.resaveSuggested).toBe(false);
  });

  it('ignores shaders and ornaments', () => {
    const a = audit([helmet()], { helm: [EMPTY_GENERAL, ASHES_TO_ASSETS, EMPTY_HEAD, EMPTY_HEAD, 999, UPGRADE_ARMOR] }, [saved('helm', LIVE_HELM_SAVED, true)]);
    expect(a.drift).toEqual([]);
  });
});

describe('auditLoadout subclass', () => {
  const SUBCLASS = 3001;
  const [PROWL, STYLISH, LEECHING, STARVATION, EXCHANGE] = [1001, 1002, 2001, 2002, 2003];
  const capacity = (value: number) => ({ investmentStats: [{ statTypeHash: FRAGMENT_CAPACITY_STAT, value, isConditionallyActive: false }] });
  const subDefs = defsFrom({
    DestinyInventoryItemDefinition: withHashes({
      [PROWL]: { ...plugDef('On the Prowl', 'hunter.void.aspects'), ...capacity(2) },
      [STYLISH]: { ...plugDef('Stylish Executioner', 'hunter.void.aspects'), ...capacity(1) },
      [LEECHING]: plugDef('Echo of Leeching', 'shared.void.fragments'),
      [STARVATION]: plugDef('Echo of Starvation', 'shared.void.fragments'),
      [EXCHANGE]: plugDef('Echo of Exchange', 'shared.void.fragments'),
      [SUBCLASS]: {
        displayProperties: { name: 'Nightstalker', description: '' },
        sockets: {
          socketEntries: [{ socketTypeHash: 40 }, { socketTypeHash: 40 }, { socketTypeHash: 41 }, { socketTypeHash: 41 }, { socketTypeHash: 41 }],
          socketCategories: [
            { socketCategoryHash: 50, socketIndexes: [0, 1] },
            { socketCategoryHash: 51, socketIndexes: [2, 3, 4] },
          ],
        },
      },
    }),
    DestinySocketCategoryDefinition: withHashes({ 50: { displayProperties: { name: 'ASPECTS' } }, 51: { displayProperties: { name: 'FRAGMENTS' } } }),
    DestinySocketTypeDefinition: withHashes({ 40: { plugWhitelist: [{ categoryIdentifier: 'hunter.void.aspects' }] }, 41: { plugWhitelist: [{ categoryIdentifier: 'shared.void.fragments' }] } }),
    DestinyVendorDefinition: withHashes({ 10: { displayProperties: { name: 'Aspects' }, enabled: true, itemList: [{ itemHash: PROWL }] } }),
  });
  const sub = makeItem({ instanceId: 'sc', kind: 'subclass', hash: SUBCLASS, name: 'Nightstalker', bucketHash: Buckets.Subclass, location: onWarlock, equipped: true });
  const run = (hashes: number[], ownership?: Map<number, PlugOwnership>) => audit([sub], { sc: hashes }, [saved('sc', hashes, true)], subDefs, ownership);

  it('reports fragment slots the saved aspects open but the loadout leaves unused', () => {
    expect(run([PROWL, STYLISH, LEECHING, STARVATION, EXCHANGE]).gaps).toEqual([]);
    expect(run([PROWL, STYLISH, LEECHING, EMPTY_PLUG, EMPTY_PLUG]).gaps.map((g) => g.message)).toEqual(['2 fragment slots unused (the aspects open 3, 1 saved)']);
    expect(run([STYLISH, EMPTY_PLUG, LEECHING, STARVATION, EMPTY_PLUG]).gaps).toEqual([]);
  });

  it('reports saved aspects and fragments the character has not bought, with the price', () => {
    const ownership = new Map<number, PlugOwnership>([
      [PROWL, { owned: true }],
      [LEECHING, { owned: false, price: 'Glimmer x10000' }],
    ]);
    expect(run([PROWL, STYLISH, LEECHING, STARVATION, EXCHANGE], ownership).gaps.map((g) => g.message)).toEqual(['Echo of Leeching is not bought (costs Glimmer x10000)']);
  });

  it('reports a saved fragment whose socket the current aspects leave disabled', () => {
    const inv = makeInventory([sub]);
    const states = socketStates([PROWL, STYLISH, LEECHING, STARVATION, EXCHANGE]);
    states[4] = { ...states[4], plugHash: 0, isEnabled: false };
    inv.raw = { itemComponents: { sockets: { data: { sc: { sockets: states } } } } } as unknown as typeof inv.raw;
    const a = auditLoadout(inv, subDefs, loadout([saved('sc', [PROWL, STYLISH, LEECHING, STARVATION, EXCHANGE], true)]));
    expect(a.drift.map((d) => d.message)).toEqual(['Nightstalker: FRAGMENTS 4 is disabled now, saved Echo of Exchange']);
    expect(a.gaps).toEqual([]); // the saved fragment still counts toward the slots the saved aspects open
  });

  it('audits a saved slot for audit_build, reading the vendors cached unless refreshed, and says how to resolve drift', async () => {
    const inv = makeInventory([sub]);
    const hashes = [PROWL, STYLISH, LEECHING, STARVATION, EXCHANGE];
    inv.raw = {
      itemComponents: { sockets: { data: { sc: { sockets: socketStates([STYLISH, PROWL, LEECHING, STARVATION, EXCHANGE]) } } } },
      characterLoadouts: { data: { [WARLOCK]: { loadouts: [{ nameHash: 0, colorHash: 0, iconHash: 0, items: [{ itemInstanceId: 'sc', plugItemHashes: hashes }] }] } } },
    } as unknown as typeof inv.raw;
    const characterVendorSales = vi.fn(async () => []);
    const out = await auditSavedLoadout({ characterVendorSales }, inv, subDefs, 0, { characterId: WARLOCK });
    expect(characterVendorSales).toHaveBeenCalledWith(WARLOCK, 10, false);
    expect(out).toMatchObject({ loadout: '0: Loadout 1', character: 'Warlock', matches: false, resaveSuggested: true });
    expect(out.note).toMatch(/re-save slot 0 .*equip_loadout with loadout 0 and character Warlock/);

    await auditSavedLoadout({ characterVendorSales }, inv, subDefs, 0, { characterId: WARLOCK, refresh: true });
    expect(characterVendorSales).toHaveBeenLastCalledWith(WARLOCK, 10, true);
  });
});
