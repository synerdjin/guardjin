import { describe, expect, it } from 'vitest';
import { paginate } from '../src/tools/util.js';

describe('paginate', () => {
  const items = Array.from({ length: 7 }, (_, i) => i);

  it('points to the next page while items remain', () => {
    expect(paginate(items, 0, 3)).toEqual({ total: 7, offset: 0, returned: 3, nextOffset: 3, items: [0, 1, 2] });
    expect(paginate(items, 3, 3)).toMatchObject({ returned: 3, nextOffset: 6, items: [3, 4, 5] });
  });

  it('leaves nextOffset unset on the last page', () => {
    expect(paginate(items, 6, 3)).toMatchObject({ returned: 1, nextOffset: undefined, items: [6] });
    expect(paginate(items, 4, 3).nextOffset).toBeUndefined();
  });

  it('returns nothing past the end', () => {
    expect(paginate(items, 10, 3)).toMatchObject({ returned: 0, nextOffset: undefined, items: [] });
  });
});
