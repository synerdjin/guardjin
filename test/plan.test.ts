import { describe, expect, it } from 'vitest';
import { matchActivities, readModifiers } from '../src/world/plan.js';
import { fixtureDefs } from './helpers.js';

const defs = fixtureDefs();
const DESERT_PERPETUAL = 1044919065;

describe('matchActivities', () => {
  it('matches every query word and prefers name matches with more modifiers', () => {
    const c = (name: string, mods: number, hash = 1) => ({ activityHash: hash, name, modifierHashes: Array.from({ length: mods }, (_, i) => i), source: 'available' as const });
    const list = [c('Nightfall: Advanced', 2), c('Nightfall: Master', 5), c('Duality: Master', 3), c('The Desert Perpetual: Standard', 1, DESERT_PERPETUAL)];
    expect(matchActivities(defs, list, 'nightfall').map((m) => m.name)).toEqual(['Nightfall: Master', 'Nightfall: Advanced']);
    expect(matchActivities(defs, list, 'duality master').map((m) => m.name)).toEqual(['Duality: Master']);
    // "raid" matches through the activity type, not the name
    expect(matchActivities(defs, list, 'raid').map((m) => m.name)).toEqual(['The Desert Perpetual: Standard']);
  });
});

describe('readModifiers', () => {
  it('reads champions, shields, surges, threats and loadout locks', () => {
    // Champion Foes, Shielded Foes, Void Surge, Solar Threat, Master Modifiers, Famine
    const req = readModifiers(defs, [197794292, 2288210988, 3196075844, 3517267764, 3623371497, 965929096]);
    expect(req).toMatchObject({
      champions: ['barrier', 'overload'],
      shields: ['Arc', 'Solar', 'Void'],
      surges: ['Void'],
      threats: ['Solar'],
      overcharged: [],
      other: [{ name: 'Famine', description: 'All ammunition drops are significantly reduced.' }],
    });
    expect(req.restrictions).toEqual(['Master Modifiers: Extra Champions Locked Loadout Extra Shields']);
  });

  it('returns empty requirements for unknown modifiers', () => {
    expect(readModifiers(defs, [123])).toEqual({ champions: [], shields: [], surges: [], threats: [], overcharged: [], restrictions: [], other: [] });
  });
});
