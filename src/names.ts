/** The form names are compared in: trimmed, lowercased, curly apostrophes straightened. */
export const normName = (s: string) => s.trim().toLowerCase().replace(/’/g, "'");

/** Entries whose name equals the query, or else every entry whose name contains it. */
export function matchByName<T>(pool: T[], nameOf: (t: T) => string, query: string): T[] {
  const q = normName(query);
  const exact = pool.filter((t) => normName(nameOf(t)) === q);
  return exact.length ? exact : pool.filter((t) => normName(nameOf(t)).includes(q));
}
