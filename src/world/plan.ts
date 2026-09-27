import type { Defs } from '../manifest/defs.js';
import type { Champion } from '../builds/champions.js';
import { activityKind } from './activity.js';

export interface ActivityCandidate {
  activityHash: number;
  name: string;
  recommendedLight?: number;
  modifierHashes: number[];
  source: 'available' | 'weekly';
  canLead?: boolean;
}

export interface ActivityRequirements {
  champions: Champion[];
  /** Elements of combatant shields ("Shielded Foes"). */
  shields: string[];
  /** Elements with bonus outgoing damage ("Void Surge"). */
  surges: string[];
  /** Elements with increased incoming damage ("Solar Threat"). */
  threats: string[];
  /** Weapon types with bonus damage ("Overcharged Fusion Rifle"). */
  overcharged: string[];
  /** Loadout restrictions: equipment locked, Notswap, fixed power. */
  restrictions: string[];
  other: { name: string; description?: string }[];
}

const ELEMENTS = ['Arc', 'Solar', 'Void', 'Stasis', 'Strand', 'Kinetic'];
const clean = (s: string | undefined) => (s ?? '').replace(/\{var:\d+\}%?\s*/g, '').replace(/\s+/g, ' ').trim();

/** Reads what an activity's modifiers demand: champions, shields, surges, threats and loadout rules. */
export function readModifiers(defs: Defs, modifierHashes: number[]): ActivityRequirements {
  const out: ActivityRequirements = { champions: [], shields: [], surges: [], threats: [], overcharged: [], restrictions: [], other: [] };
  const add = <T>(list: T[], v: T) => {
    if (!list.includes(v)) list.push(v);
  };
  for (const h of modifierHashes) {
    const m = defs.get<{ displayProperties?: { name?: string; description?: string } }>('DestinyActivityModifierDefinition', h);
    const name = m?.displayProperties?.name?.trim();
    const description = m?.displayProperties?.description ?? '';
    if (!name) continue;
    if (/champion/i.test(name) || /champions?\b/i.test(description)) {
      const found = [...description.matchAll(/\b(Barrier|Overload|Unstoppable)\b/g)].map((x) => x[1].toLowerCase() as Champion);
      const fromName = name.match(/Champions?:\s*(Barrier|Overload|Unstoppable)/i)?.[1]?.toLowerCase() as Champion | undefined;
      for (const c of fromName ? [fromName, ...found] : found) add(out.champions, c);
      if (found.length || fromName) continue;
    }
    const surge = name.match(/^(\w+) Surge$/);
    const threat = name.match(/^(\w+) Threat$/);
    const overcharged = name.match(/^Overcharged (.+)$/);
    if (/Shielded Foes|Shields$/i.test(name) || /\bShields\b/.test(description)) {
      const els = [...description.matchAll(/\[(\w+)\]/g)].map((x) => x[1]).filter((e) => ELEMENTS.includes(e));
      if (els.length) {
        for (const e of els) add(out.shields, e);
        continue;
      }
    }
    if (surge && ELEMENTS.includes(surge[1])) add(out.surges, surge[1]);
    else if (threat && ELEMENTS.includes(threat[1])) add(out.threats, threat[1]);
    else if (overcharged) add(out.overcharged, overcharged[1]);
    else if (/Equipment Locked|Locked Loadout|Notswap|Mettle/i.test(`${name} ${description}`)) add(out.restrictions, `${name}: ${clean(description)}`);
    else if (!/^(A Challenge Awaits|Boosts Gained|Exotic Drop Rate Boosts Gained)/i.test(name) && !/^A challenge awaits/i.test(description)) {
      if (!out.other.some((o) => o.name === name)) out.other.push({ name, description: clean(description) || undefined });
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Picks the activity a query means: every word of the query in its name (or its kind, e.g.
 * "nightfall"), preferring ones with more modifiers (the harder, featured versions).
 */
export function matchActivities(defs: Defs, candidates: ActivityCandidate[], query: string): ActivityCandidate[] {
  const words = norm(query).split(' ').filter(Boolean);
  const byName = new Set<ActivityCandidate>();
  const scored = candidates.flatMap((c) => {
    const kind = activityKind(defs, c.activityHash) ?? '';
    if (words.every((w) => norm(c.name).includes(w))) byName.add(c);
    const hay = `${norm(c.name)} ${norm(kind === 'lostSector' ? 'lost sector' : kind)}`;
    return words.every((w) => hay.includes(w)) ? [c] : [];
  });
  const seen = new Set<string>();
  return scored
    .sort(
      (a, b) =>
        Number(byName.has(b)) - Number(byName.has(a)) ||
        b.modifierHashes.length - a.modifierHashes.length ||
        (b.recommendedLight ?? 0) - (a.recommendedLight ?? 0),
    )
    .filter((c) => {
      const key = `${c.name}:${c.modifierHashes.join(',')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
