import { describe, expect, it } from 'vitest';
import { evaluateRoll, parseWishlist } from '../src/vault/wishlist.js';
import { fixtureDefs, makeItem } from './helpers.js';

const defs = fixtureDefs();
const FATEBRINGER = 2171478765;
// Perk hashes from the Fatebringer plug sets in the fixture manifest
const ARROWHEAD = 839105230;
const EXTENDED_BARREL = 1467527085;
const APPENDED_MAG = 1087426260;
const KILLING_WIND = 2450788523;
const KILL_CLIP = 1015611457;
const OPENING_SHOT = 47981717;

const TEXT = `title: Test wishlist
description: for tests

//notes: PvE pick. Kill Clip is the star.
dimwishlist:item=${FATEBRINGER}&perks=${ARROWHEAD},${KILL_CLIP}
dimwishlist:item=${FATEBRINGER}&perks=${APPENDED_MAG},${KILLING_WIND},${KILL_CLIP}

dimwishlist:item=-${FATEBRINGER}&perks=${OPENING_SHOT}#notes:Opening Shot is bad on this
dimwishlist:item=-69420&perks=999999
not a wishlist line
`;

const fatebringer = (columns: number[][]) =>
  makeItem({
    kind: 'weapon',
    hash: FATEBRINGER,
    name: 'Fatebringer',
    weapon: {
      perks: columns.map((opts, i) => ({
        socketIndex: i + 1,
        equipped: { hash: opts[0], name: defs.item(opts[0])!.displayProperties.name },
        options: opts.map((h) => ({ hash: h, name: defs.item(h)!.displayProperties.name })),
      })),
    },
  });

describe('parseWishlist', () => {
  const wl = parseWishlist(TEXT);

  it('parses entries, trash entries and notes', () => {
    expect(wl.title).toBe('Test wishlist');
    expect(wl.size).toBe(4);
    const entries = wl.entries.get(FATEBRINGER)!;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ perks: [ARROWHEAD, KILL_CLIP], trash: false, notes: 'PvE pick. Kill Clip is the star.' });
    expect(entries[2]).toMatchObject({ trash: true, notes: 'Opening Shot is bad on this' });
    expect(wl.entries.get(-69420)).toHaveLength(1);
  });
});

describe('evaluateRoll', () => {
  const wl = parseWishlist(TEXT);

  it('matches wishlist rolls using any selectable option', () => {
    const r = evaluateRoll(fatebringer([[EXTENDED_BARREL, ARROWHEAD], [APPENDED_MAG], [KILLING_WIND], [KILL_CLIP]]), wl, defs);
    expect(r.verdict).toBe('wishlist');
    expect(r.matchedPerks).toEqual(['Appended Mag', 'Killing Wind', 'Kill Clip']);
    expect(r.notes?.[0].note).toContain('Kill Clip');
  });

  it('flags trash rolls', () => {
    const r = evaluateRoll(fatebringer([[EXTENDED_BARREL], [APPENDED_MAG], [KILLING_WIND], [OPENING_SHOT]]), wl, defs);
    expect(r.verdict).toBe('trash');
  });

  it('reports listed weapons whose roll is not on the list', () => {
    const r = evaluateRoll(fatebringer([[EXTENDED_BARREL], [APPENDED_MAG], [KILLING_WIND], [2450788523]]), wl, defs);
    expect(r.verdict).toBe('not-on-wishlist');
  });

  it('returns unknown for weapons the list does not cover', () => {
    const other = fatebringer([[ARROWHEAD]]);
    other.hash = 12345;
    expect(evaluateRoll(other, parseWishlist(`dimwishlist:item=${FATEBRINGER}&perks=${ARROWHEAD}`), defs).verdict).toBe('unknown');
  });
});

describe('titles, sources and notes', () => {
  const long = `Recommended perks: Kill Clip. ${'x'.repeat(1500)} END`;
  const wl = parseWishlist(`title:Compiled list
description:many authors

// taken from somewhere

title:PvE Podcast - Hand Cannons
description:first section

// Fatebringer - PvE Minor god 1
// (Arrowhead Brake), (Appended Mag)
//notes:Minor pick
dimwishlist:item=${FATEBRINGER}&perks=${ARROWHEAD},${KILLING_WIND}

// Fatebringer - PvE Boss god 1
//notes:${long}
dimwishlist:item=${FATEBRINGER}&perks=${APPENDED_MAG},${KILL_CLIP}

title:Garden of Salvation raid weapons breakdown
//notes:Raid pick
dimwishlist:item=${FATEBRINGER}&perks=${KILL_CLIP}
`);
  const roll = fatebringer([[EXTENDED_BARREL, ARROWHEAD], [APPENDED_MAG], [KILLING_WIND], [KILL_CLIP]]);

  it('keeps the first title as the file title and records each entry\'s block', () => {
    expect(wl.title).toBe('Compiled list');
    expect(wl.entries.get(FATEBRINGER)!.map((e) => e.source)).toEqual([
      'PvE Podcast - Hand Cannons › Fatebringer - PvE Minor god 1',
      'PvE Podcast - Hand Cannons › Fatebringer - PvE Boss god 1',
      'Garden of Salvation raid weapons breakdown',
    ]);
  });

  it('returns notes from the best-matching entries first, capped at 1200 characters', () => {
    const r = evaluateRoll(roll, wl, defs);
    // Boss matches two equipped perks; minor and raid one each, and the minor entry is more specific (two perks).
    expect(r.notes?.map((n) => n.source)).toEqual([
      'PvE Podcast - Hand Cannons › Fatebringer - PvE Boss god 1',
      'PvE Podcast - Hand Cannons › Fatebringer - PvE Minor god 1',
      'Garden of Salvation raid weapons breakdown',
    ]);
    expect(r.notes![0].note).toHaveLength(1201);
    expect(r.notes![0].note.startsWith('Recommended perks: Kill Clip.')).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it('returns full notes on request', () => {
    const r = evaluateRoll(roll, wl, defs, { fullNotes: true });
    expect(r.notes![0].note).toBe(long);
    expect(r.truncated).toBeUndefined();
  });
});
