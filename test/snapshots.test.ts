import { describe, expect, it } from 'vitest';
import { newerThan, SnapshotStore } from '../src/store/snapshots.js';
import { makeInventory, makeItem } from './helpers.js';

describe('SnapshotStore', () => {
  it('marks the first read as baseline, then dates new drops and notices dismantles', () => {
    const store = new SnapshotStore(':memory:');
    const old = makeItem({ instanceId: '100', name: 'Old Helm' });
    const doomed = makeItem({ instanceId: '101', name: 'Doomed Helm' });
    store.observe(makeInventory([old, doomed]), 1000);
    expect(store.trackingSince()).toBe(1000);
    expect(store.changesSince(0)).toEqual({ added: [], gone: [] });

    const drop = makeItem({ instanceId: '200', name: 'New Helm' });
    store.observe(makeInventory([old, drop]), 2000);
    const { added, gone } = store.changesSince(1500);
    expect(added.map((a) => a.name)).toEqual(['New Helm']);
    expect(gone.map((g) => [g.name, g.goneAt])).toEqual([['Doomed Helm', 2000]]);
    expect(store.seen(['100']).get('100')).toMatchObject({ baseline: true, firstSeenAt: 1000, lastSeenAt: 2000 });
  });

  it('throttles full snapshots and diffs against the right one', () => {
    const store = new SnapshotStore(':memory:');
    const helm = makeItem({ instanceId: '1', locked: false, power: 400 });
    const first = store.maybeSnapshot(makeInventory([helm]), { now: 0, currencies: [{ name: 'Glimmer', quantity: 10 }] });
    expect(first).toBeDefined();
    expect(store.maybeSnapshot(makeInventory([helm]), { now: 60_000 })).toBeUndefined();
    const second = store.maybeSnapshot(makeInventory([{ ...helm, locked: true }]), { now: 60_000, force: true });
    expect(store.snapshotAt(30_000)?.id).toBe(first);
    expect(store.snapshotItems(second!).get('1')).toMatchObject({ locked: true, power: 400 });
    expect(store.snapshotCurrencies(first!).get('Glimmer')).toBe(10);
  });

  it('keeps meta values', () => {
    const store = new SnapshotStore(':memory:');
    store.setMeta('last_triage', '5');
    store.setMeta('last_triage', '6');
    expect(store.getMeta('last_triage')).toBe('6');
  });
});

describe('newerThan', () => {
  it('compares instance ids beyond double precision', () => {
    expect(newerThan('6917530201834705367', '6917530201834705366')).toBe(true);
    expect(newerThan('6917529904056214813', '6917530201834705367')).toBe(false);
  });
});
