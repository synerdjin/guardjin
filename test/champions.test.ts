import { describe, expect, it } from 'vitest';
import { championCoverage, championsInText, itemChampions, loadOverrides, plugChampions, stunRules, verbsInText } from '../src/builds/champions.js';
import type { InventoryModel } from '../src/inventory/model.js';
import { defsFrom, fixtureDefs, makeInventory, makeItem, withHashes } from './helpers.js';

const defs = fixtureDefs();
const AGGRESSIVE_FRAME = 2159352803; // hidden "[Stagger] Unstoppable" perk
const RAPID_FIRE_FRAME = 2164888232; // hidden "[Disruption] Overload" perk
const VOLTSHOT = 2173046394;
const EXTENDED_MAG = 2420895100;

/** Inventory whose raw profile has the given sockets for each item. */
function withSockets(items: ReturnType<typeof makeItem>[], sockets: Record<string, number[]>): InventoryModel {
  const inv = makeInventory(items);
  const data = Object.fromEntries(Object.entries(sockets).map(([id, hashes]) => [id, { sockets: hashes.map((plugHash) => ({ plugHash, isEnabled: true, isVisible: true })) }]));
  inv.raw = { itemComponents: { sockets: { data } } } as unknown as InventoryModel['raw'];
  return inv;
}

describe('championsInText', () => {
  it('reads "Strong against" and "stun … Champions" wording', () => {
    expect(championsInText('Fires slugs. Strong against [Shield-Piercing] Barrier Champions.')).toEqual(['barrier']);
    expect(championsInText('Fusion Grenades explode on impact, and stun Unstoppable Champions.')).toEqual(['unstoppable']);
    expect(championsInText('This shockwave can stun [Stagger] Unstoppable Champions.')).toEqual(['unstoppable']);
  });

  it('ignores effects that only react to a stun', () => {
    expect(championsInText('Immediately regain your melee charge when you or an ally stuns an [Stagger] Unstoppable Champion.')).toEqual([]);
    expect(championsInText('Gain a stack of Armor Charge when you stun a Champion.')).toEqual([]);
  });
});

describe('stunRules', () => {
  const rules = stunRules(defs);

  it('parses the game’s stun rules from the champion triumphs', () => {
    const byChampion = (c: string) => rules.filter((r) => r.champion === c).map((r) => r.verb).sort();
    expect(byChampion('overload')).toEqual(['jolt', 'slow', 'suppress']);
    expect(byChampion('barrier')).toEqual(['radiant', 'unraveling rounds', 'volatile rounds']);
    expect(byChampion('unstoppable')).toEqual(['blind', 'ignition', 'shatter', 'suspend']);
  });

  it('matches verb forms but not look-alikes', () => {
    const verbs = (t: string) => verbsInText(t, rules).map((r) => r.verb);
    expect(verbs('Combatants affected by Soul Siphon are suppressed.')).toEqual(['suppress']);
    expect(verbs('Ignitions deal more damage.')).toEqual(['ignition']);
    expect(verbs('Grants your Void weapons Volatile rounds.')).toEqual(['volatile rounds']);
    expect(verbs('This weapon slowly reloads itself; reloads much slower.')).toEqual([]);
    expect(verbs('Nova Bomb travels slowly. Detonations shatter into smaller seeker projectiles.')).toEqual([]);
    expect(verbs('Detonates near a target, making them volatile.')).toEqual([]);
  });

  it('counts freezing as an Unstoppable stun with the overrides file, but not perks that only react to frozen targets', () => {
    const freeze = loadOverrides().verbs!.find((r) => r.verb === 'freeze')!;
    expect(freeze).toMatchObject({ champion: 'unstoppable', element: 'Stasis' });
    const verbs = (t: string) => verbsInText(t, [...rules, freeze]).map((r) => r.verb);
    expect(verbs('Direct hits with Stasis arrows freeze combatants and slow opposing Guardians.')).toEqual(['slow', 'freeze']);
    expect(verbs('Landing nearly all Stasis pellets will freeze targets.')).toEqual(['freeze']);
    expect(verbs('Freezes the target in a block of ice.')).toEqual(['freeze']);
    expect(verbs('Defeating a frozen target with this weapon grants you Frost Armor.')).toEqual([]);
  });
});

describe('plugChampions', () => {
  it('finds the hidden champion trait on weapon frames', () => {
    expect(plugChampions(defs, defs.item(AGGRESSIVE_FRAME))).toEqual(['unstoppable']);
    expect(plugChampions(defs, defs.item(RAPID_FIRE_FRAME))).toEqual(['overload']);
    expect(plugChampions(defs, defs.item(EXTENDED_MAG))).toEqual([]);
  });
});

describe('plug overrides', () => {
  const CHILL_CLIP = 2978966579;
  const GUN = 9001;
  const mini = defsFrom({
    DestinyInventoryItemDefinition: withHashes({
      [GUN]: { displayProperties: { name: 'Test Gun', description: '' } },
      [CHILL_CLIP]: { displayProperties: { name: 'Chill Clip', description: 'Direct hits cause a detonation that slows nearby targets.' }, plug: { plugCategoryIdentifier: 'frames' } },
    }),
  });
  const gun = makeItem({ kind: 'weapon', hash: GUN, name: 'Test Gun', instanceId: 'gun1' });
  const inv = withSockets([gun], { gun1: [CHILL_CLIP] });

  it('grants the champion to every item rolled with the plug, marked as an override with its note', () => {
    const overrides = { plugs: { [CHILL_CLIP]: { champion: 'unstoppable' as const, note: 'confirmed in play' } } };
    const report = championCoverage(inv, mini, { items: [gun], extras: { overrides } });
    expect(report.champions.unstoppable.by).toEqual([{ champion: 'unstoppable', kind: 'override', via: 'Test Gun: Chill Clip', confidence: 'high', note: 'confirmed in play' }]);
    expect(championCoverage(inv, mini, { items: [gun] }).champions.unstoppable.covered).toBe(false);
  });

  it('ships Chill Clip and its enhanced version in the overrides file', () => {
    const plugs = loadOverrides().plugs!;
    expect(plugs['2978966579']?.champion).toBe('unstoppable');
    expect(plugs['344235611']?.champion).toBe('unstoppable');
    expect(plugChampions(mini, mini.item(CHILL_CLIP))).toEqual([]);
  });
});

describe('championCoverage', () => {
  it('combines frames, perk verbs and overrides, and reports gaps', () => {
    const fusion = makeItem({ kind: 'weapon', name: 'TAHOMA 01', hash: 111 });
    const shotgun = makeItem({ kind: 'weapon', name: 'One Small Step', hash: 222 });
    const inv = withSockets([fusion, shotgun], { [fusion.instanceId!]: [AGGRESSIVE_FRAME, EXTENDED_MAG], [shotgun.instanceId!]: [RAPID_FIRE_FRAME, VOLTSHOT] });
    const report = championCoverage(inv, defs, { items: [fusion, shotgun] });
    expect(report.gaps).toEqual(['barrier']);
    expect(report.champions.unstoppable.by[0]).toMatchObject({ kind: 'frame', via: 'TAHOMA 01: Aggressive Frame', confidence: 'high' });
    const overload = report.champions.overload.by.map((b) => [b.via, b.confidence]);
    expect(overload).toEqual([
      ['One Small Step: Rapid-Fire Frame', 'high'],
      ['One Small Step: Voltshot', 'medium'],
    ]);

    expect(itemChampions(inv, defs, shotgun, { overrides: { items: { 222: { champion: 'barrier' } } } })).toEqual([
      { champion: 'barrier', kind: 'override', via: 'One Small Step', confidence: 'high', note: 'data/champion-overrides.json' },
    ]);
    expect(itemChampions(inv, defs, shotgun, { extendedBreaker: { 222: 485622768 } }).map((s) => s.champion)).toEqual(['barrier', 'overload']);
  });
});
