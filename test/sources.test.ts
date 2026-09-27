import { describe, expect, it } from 'vitest';
import { readOnlySql } from '../src/tools/sources.js';
import { fixtureDefs } from './helpers.js';

describe('readOnlySql', () => {
  it('accepts one SELECT or WITH statement', () => {
    expect(readOnlySql('select 1;')).toBe('select 1');
    expect(readOnlySql("WITH x AS (SELECT 'a;b' AS v) SELECT replace(v, ';', '') FROM x")).toContain('WITH');
  });

  it('rejects writes and multiple statements', () => {
    expect(() => readOnlySql('DELETE FROM owned_items')).toThrow(/SELECT/);
    expect(() => readOnlySql('SELECT 1; SELECT 2')).toThrow(/one statement/);
    expect(() => readOnlySql('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toThrow(/read-only/);
  });
});

describe('sid/uid SQL helpers', () => {
  it('convert between unsigned hashes and signed ids', () => {
    const row = fixtureDefs().db.prepare('SELECT sid(3454344768) AS s, uid(-840622528) AS u').get() as { s: number; u: number };
    expect(row).toEqual({ s: 3454344768 | 0, u: 3454344768 });
  });
});
