import { DatabaseSync } from 'node:sqlite';
import { plugText } from './defs.js';

/** A plug (perk, mod, aspect, fragment, exotic intrinsic...) whose text or stats differ between two manifest versions. */
export interface PatchChange {
  hash: number;
  name: string;
  before: string;
  after: string;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Shader and ornament plug categories ("shader", "armor_skins_hunter_chest", "…hand_cannon1_skins"): looks, not gameplay. */
const COSMETIC_CATEGORY = /^shader$|skins/;

type Stat = { statTypeHash: number; value: number };

/**
 * What each non-cosmetic plug in a manifest says and does, keyed by its (unsigned) hash: its stat
 * bonuses and the text the game shows, as one string ('' for neither) so two versions compare directly.
 */
function plugSummaries(db: DatabaseSync, statNames: Map<number, string>): Map<number, { name: string; summary: string }> {
  const perks = new Map<number, { isDisplayable: boolean; displayProperties: { description?: string } }>();
  for (const r of db
    .prepare(
      `SELECT id, json_extract(j, '$.displayProperties.description') AS d FROM (SELECT id, CAST(json AS TEXT) AS j FROM DestinySandboxPerkDefinition)
       WHERE json_extract(j, '$.isDisplayable') = 1`,
    )
    .all() as { id: number; d: string | null }[]) {
    if (r.d) perks.set(r.id >>> 0, { isDisplayable: true, displayProperties: { description: r.d } });
  }

  const out = new Map<number, { name: string; summary: string }>();
  const rows = db
    .prepare(
      `SELECT id, json_extract(j, '$.displayProperties.name', '$.displayProperties.description', '$.perks', '$.investmentStats', '$.plug.plugCategoryIdentifier') AS f
       FROM (SELECT id, CAST(json AS TEXT) AS j FROM DestinyInventoryItemDefinition) WHERE json_type(j, '$.plug') = 'object'`,
    )
    .all() as { id: number; f: string }[];
  for (const r of rows) {
    const [name, description, plugPerks, investmentStats, category] = JSON.parse(r.f) as [
      string | null,
      string | null,
      { perkHash: number }[] | null,
      Stat[] | null,
      string | null,
    ];
    if (COSMETIC_CATEGORY.test(category ?? '')) continue;
    const text = squash(plugText({ displayProperties: { description }, perks: plugPerks, plug: { plugCategoryIdentifier: category } }, (h) => perks.get(h)));
    const stats = (investmentStats ?? [])
      .filter((s) => s.value)
      .sort((a, b) => a.statTypeHash - b.statTypeHash)
      .map((s) => `${statNames.get(s.statTypeHash) ?? s.statTypeHash} ${s.value > 0 ? '+' : ''}${s.value}`)
      .join(', ');
    // Stats first, so clipping a long description never hides a stat change.
    out.set(r.id >>> 0, { name: name ?? '', summary: [stats && `Stats: ${stats}`, text].filter(Boolean).join(' | ') });
  }
  return out;
}

function statNames(db: DatabaseSync): Map<number, string> {
  const names = new Map<number, string>();
  for (const r of db.prepare(`SELECT id, json_extract(CAST(json AS TEXT), '$.displayProperties.name') AS n FROM DestinyStatDefinition`).all() as {
    id: number;
    n: string | null;
  }[]) {
    if (r.n) names.set(r.id >>> 0, r.n);
  }
  return names;
}

/**
 * Plugs present in both manifests whose description or stats differ. Added and removed plugs are
 * not listed: this answers "did the text on something I use change".
 */
export function diffPlugs(prev: DatabaseSync, next: DatabaseSync): PatchChange[] {
  const names = statNames(next);
  const before = plugSummaries(prev, names);
  const changes: PatchChange[] = [];
  for (const [hash, a] of plugSummaries(next, names)) {
    const b = before.get(hash);
    if (b && b.summary !== a.summary) changes.push({ hash, name: a.name || b.name, before: b.summary || '(nothing)', after: a.summary || '(nothing)' });
  }
  return changes;
}

/** Compares two manifest database files. */
export function diffManifestFiles(prevFile: string, nextFile: string): PatchChange[] {
  const prev = new DatabaseSync(prevFile, { readOnly: true });
  try {
    const next = new DatabaseSync(nextFile, { readOnly: true });
    try {
      return diffPlugs(prev, next);
    } finally {
      next.close();
    }
  } finally {
    prev.close();
  }
}
