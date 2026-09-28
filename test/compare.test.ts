import { describe, expect, it } from 'vitest';
import { assertComparable, buildComparison } from '../src/tools/compare.js';
import { makeItem } from './helpers.js';

const entries = [
  { label: 'The Call · 408 · A / B', stats: { 'Blast Radius': 41, Magazine: 18, Handling: 50, 'Rounds Per Minute': 120 }, perks: ['Quick Launch', 'Tactical Mag', 'A'] },
  { label: 'The Call · 400 · A / C', stats: { 'Blast Radius': 51, Magazine: 9, Handling: 50, 'Rounds Per Minute': 140 }, perks: ['Confined Launch', 'Tactical Mag', 'A'] },
  { label: 'The Call · 402 · D / E', stats: { 'Blast Radius': 46, Magazine: 12, Handling: 50, 'Rounds Per Minute': 130 }, perks: ['Quick Launch', 'Tactical Mag', 'D'] },
];

describe('buildComparison', () => {
  const c = buildComparison(entries);

  it('keeps the item order and marks the single best value', () => {
    const blast = c.statRows.find((r) => r.stat === 'Blast Radius')!;
    expect(blast).toEqual({ stat: 'Blast Radius', values: [41, 51, 46], best: 1 });
    expect(c.statRows.find((r) => r.stat === 'Magazine')).toEqual({ stat: 'Magazine', values: [18, 9, 12], best: 0 });
  });

  it('puts identical stats after differing ones and gives no best to RPM or ties', () => {
    expect(c.statRows.map((r) => r.stat)).toEqual(['Blast Radius', 'Magazine', 'Rounds Per Minute', 'Handling']);
    expect(c.statRows.find((r) => r.stat === 'Rounds Per Minute')!.best).toBeUndefined();
    expect(c.statRows.find((r) => r.stat === 'Handling')!.best).toBeUndefined();
    const tie = buildComparison([entries[0], entries[0], entries[1]]).statRows.find((r) => r.stat === 'Magazine')!;
    expect(tie.best).toBeUndefined();
  });

  it('treats lower charge and draw time as better', () => {
    const r = buildComparison([
      { label: 'a', stats: { 'Charge Time': 540 }, perks: [] },
      { label: 'b', stats: { 'Charge Time': 460 }, perks: [] },
    ]);
    expect(r.statRows[0].best).toBe(1);
  });

  it('aligns perk columns and describes the differences by label', () => {
    expect(c.perkRows[0]).toEqual({ column: 1, values: ['Quick Launch', 'Confined Launch', 'Quick Launch'] });
    expect(c.differences).toContain('Blast Radius: 51 (The Call · 400 · A / C) vs 41 (The Call · 408 · A / B)');
    expect(c.differences.some((d) => d.startsWith('Column 2'))).toBe(false);
    expect(c.differences.some((d) => d.startsWith('Column 3'))).toBe(true);
  });
});

describe('assertComparable', () => {
  it('rejects weapons mixed with armor', () => {
    expect(() => assertComparable([makeItem({ kind: 'weapon' }), makeItem({ kind: 'armor' })])).toThrow(/weapons with armor/);
  });

  it('accepts items of one kind and rejects other kinds', () => {
    expect(assertComparable([makeItem({ kind: 'weapon' }), makeItem({ kind: 'weapon' })])).toBe('weapon');
    expect(() => assertComparable([makeItem({ kind: 'ghost' }), makeItem({ kind: 'ghost' })])).toThrow(/Only weapons or armor/);
  });
});
