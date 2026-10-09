import { describe, expect, it } from 'vitest';
import { defsFrom, plugDef, withHashes } from './helpers.js';

const ORB_LINE = 'Collecting an Orb of Power causes you to gain 1 temporary Armor Charge.';

const perkText: Record<string, string> = {
  // Surge
  100: 'Your Void weapons gain a small bonus to damage while you have any Armor Charge. Your Armor Charge now decays over time.',
  101: 'Your Arc weapons gain a small bonus to damage while you have any Armor Charge. Your Armor Charge now decays over time.',
  // Font
  110: 'You gain a bonus to your class stat while you have any Armor Charge. Your Armor Charge decays over time.',
  111: 'You gain a bonus to your melee stat while you have any Armor Charge. Your Armor Charge decays over time.',
  // Kickstart
  120: 'When your grenade energy is fully expended, your Armor Charge is consumed and you gain grenade energy for each Armor Charge used.',
  121: 'When your class ability energy is fully expended, your Armor Charge is consumed and you gain class ability energy for each Armor Charge used.',
};

// Each mod exists twice, as in the manifest: a copy with the shared description and one with none.
const mods = [
  { family: 'Surge', name: 'Void Weapon Surge', perk: 100, hashes: [1000, 1001] },
  { family: 'Surge', name: 'Arc Weapon Surge', perk: 101, hashes: [1010, 1011] },
  { family: 'Font', name: 'Class Font', perk: 110, hashes: [1100, 1101] },
  { family: 'Font', name: 'Melee Font', perk: 111, hashes: [1110, 1111] },
  { family: 'Kickstart', name: 'Grenade Kickstart', perk: 120, hashes: [1200, 1201] },
  { family: 'Kickstart', name: 'Utility Kickstart', perk: 121, hashes: [1210, 1211] },
];

const plug = (name: string, category: string, description: string, ...perkHashes: number[]) => ({
  ...plugDef(name, category),
  displayProperties: { name, description },
  perks: perkHashes.map((perkHash) => ({ perkHash })),
});

const defs = defsFrom({
  DestinySandboxPerkDefinition: withHashes(
    Object.fromEntries(
      Object.entries({ ...perkText, 900: 'Deprecated Perk', 901: 'Does a thing.', 902: '+5 Health ▲ / -5 Class ▼', 903: 'Reduces incoming Arc damage from combatants.' }).map(([h, description]) => [h, { isDisplayable: true, displayProperties: { description } }]),
    ),
  ),
  DestinyInventoryItemDefinition: withHashes({
    ...Object.fromEntries(mods.flatMap((m) => m.hashes.map((h, i) => [h, plug(m.name, 'enhancements.v2_legs', i === 0 ? ORB_LINE : '', m.perk)]))),
    2000: plug('Bolt Scavenger', 'frames', 'Recovering a bolt increases reload speed and handling for an improved duration.', 100),
    2001: plug('Empty Frame', 'frames', '', 100),
    2002: plug('Hive Armaments', 'enhancements.season_opulence', 'This mod has been deprecated and no longer functions.', 900),
    2003: plug('Plain Mod', 'enhancements.universal', 'Does a thing.'),
    2004: plug('Repeating Mod', 'enhancements.universal', 'Does a thing.', 901, 901),
    2005: plug('+Health / -Class', 'core.gear_systems.armor_tiering.plugs.tuning.mods', "Increases this armor's Tuned stat at the cost of a small amount of the Class stat.", 902),
    2006: plug('Tier 2 Armor', 'v400.plugs.armor.masterworks.stat.resistance_2', 'Slightly improved resistance.', 903),
  }),
});

describe('describePlug for armor mods', () => {
  it('puts the mod-specific effect from the perk in front of the shared description', () => {
    const text = defs.describePlug(defs.item(1000));
    expect(text).toBe(`${perkText[100]} ${ORB_LINE}`);
  });

  it('leads with the mod-specific effect in both copies of a mod', () => {
    for (const m of mods) {
      const [withShared, withoutShared] = m.hashes.map((h) => defs.describePlug(defs.item(h)));
      expect(withoutShared).toBe(perkText[m.perk]);
      expect(withShared.startsWith(perkText[m.perk])).toBe(true);
    }
  });

  it.each(['Surge', 'Font', 'Kickstart'])('gives no two %s mods the same description', (family) => {
    const members = mods.filter((m) => m.family === family);
    for (const copy of [0, 1]) {
      const texts = members.map((m) => defs.describePlug(defs.item(m.hashes[copy])));
      expect(new Set(texts).size).toBe(members.length);
    }
  });

  it('keeps only the own text for weapon plugs', () => {
    expect(defs.describePlug(defs.item(2000))).toBe('Recovering a bolt increases reload speed and handling for an improved duration.');
    expect(defs.describePlug(defs.item(2001))).toBe(perkText[100]);
  });

  it('keeps the own text when an armor plug has no displayable perk', () => {
    expect(defs.describePlug(defs.item(2003))).toBe('Does a thing.');
  });

  it('ends a perk text without punctuation before the own text', () => {
    expect(defs.describePlug(defs.item(2002))).toBe('Deprecated Perk. This mod has been deprecated and no longer functions.');
  });

  it('drops perk text that repeats another piece', () => {
    expect(defs.describePlug(defs.item(2004))).toBe('Does a thing.');
  });

  it('leads with the perk for tuning mods and armor masterworks', () => {
    expect(defs.describePlug(defs.item(2005))).toBe("+5 Health ▲ / -5 Class ▼ Increases this armor's Tuned stat at the cost of a small amount of the Class stat.");
    expect(defs.describePlug(defs.item(2006))).toBe('Reduces incoming Arc damage from combatants. Slightly improved resistance.');
  });
});
