import { describe, expect, it } from 'vitest';
import { championCoverage, championsInText, itemChampions, plugChampions, stunRules, verbsInText } from '../src/builds/champions.js';
import type { InventoryModel } from '../src/inventory/model.js';
import { fixtureDefs, makeInventory, makeItem } from './helpers.js';

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
});

describe('plugChampions', () => {
  it('finds the hidden champion trait on weapon frames', () => {
    expect(plugChampions(defs, defs.item(AGGRESSIVE_FRAME))).toEqual(['unstoppable']);
    expect(plugChampions(defs, defs.item(RAPID_FIRE_FRAME))).toEqual(['overload']);
    expect(plugChampions(defs, defs.item(EXTENDED_MAG))).toEqual([]);
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

    expect(itemChampions(inv, defs, shotgun, { overrides: { 222: 'barrier' } })).toEqual([
      { champion: 'barrier', kind: 'override', via: 'One Small Step', confidence: 'high', note: 'data/champion-overrides.json' },
    ]);
    expect(itemChampions(inv, defs, shotgun, { extendedBreaker: { 222: 485622768 } }).map((s) => s.champion)).toEqual(['barrier', 'overload']);
  });
});
