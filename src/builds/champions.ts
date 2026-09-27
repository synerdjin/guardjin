import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DestinyInventoryItemDefinition, DestinyRecordDefinition } from 'bungie-api-ts/destiny2';
import { WEAPON_BUCKETS } from '../inventory/constants.js';
import type { Character, InventoryModel, Item } from '../inventory/model.js';
import { describeSubclass, type SubclassPlug } from '../inventory/subclass.js';
import type { Defs } from '../manifest/defs.js';
import { characterArtifacts } from '../progress/artifact.js';

export type Champion = 'barrier' | 'overload' | 'unstoppable';
export const CHAMPIONS: Champion[] = ['barrier', 'overload', 'unstoppable'];
export const CHAMPION_NAMES: Record<Champion, string> = { barrier: 'Barrier', overload: 'Overload', unstoppable: 'Unstoppable' };

/** DestinyBreakerTypeDefinition hashes and the older breakerType enum. */
const BREAKER_HASH: Record<number, Champion> = { 485622768: 'barrier', 2611060930: 'overload', 3178805705: 'unstoppable' };
const BREAKER_ENUM: Record<number, Champion> = { 1: 'barrier', 2: 'overload', 3: 'unstoppable' };
const TAG: Record<string, Champion> = { 'shield-piercing': 'barrier', disruption: 'overload', stagger: 'unstoppable' };
const WORD: Record<string, Champion> = { barrier: 'barrier', overload: 'overload', unstoppable: 'unstoppable' };

export type ChampionSourceKind = 'weapon' | 'frame' | 'perk' | 'artifact' | 'subclass' | 'exotic-armor' | 'community' | 'override';

export interface ChampionSource {
  champion: Champion;
  kind: ChampionSourceKind;
  /** The item, plug or ability that provides it. */
  via: string;
  /** high = the game marks it (breaker type, champion trait, "Strong against"); medium = inferred from ability text. */
  confidence: 'high' | 'medium';
  note?: string;
}

export interface StunRule {
  champion: Champion;
  element: string;
  verb: string;
  pattern: RegExp;
}

export interface ChampionExtras {
  /** DIM extended-breaker: item hash → breaker type hash. */
  extendedBreaker?: Record<string, number>;
  /** Hand-maintained overrides: item hash → champion or "none". */
  overrides?: Record<string, Champion | 'none'>;
}

let overridesCache: Record<string, Champion | 'none'> | undefined;

/** data/champion-overrides.json from the project folder (same relative path from src/ and dist/). */
export function loadOverrides(): Record<string, Champion | 'none'> {
  if (overridesCache) return overridesCache;
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'champion-overrides.json');
    overridesCache = (JSON.parse(readFileSync(file, 'utf8')) as { items?: Record<string, Champion | 'none'> }).items ?? {};
  } catch {
    overridesCache = {};
  }
  return overridesCache;
}

/** Champion types a text grants: "Strong against [Stagger] Unstoppable Champions", "stun Barrier Champions". */
export function championsInText(text: string): Champion[] {
  const out = new Set<Champion>();
  const patterns = [
    /strong against\s*(?:\[([^\]]+)\]\s*)?(barrier|overload|unstoppable)?/gi,
    /\bstun\s+(?:\[([^\]]+)\]\s*)?(barrier|overload|unstoppable)\s+champions?/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const c = (m[2] && WORD[m[2].toLowerCase()]) || (m[1] && TAG[m[1].toLowerCase()]);
      if (c) out.add(c);
    }
  }
  return [...out];
}

const ruleCache = new WeakMap<Defs, StunRule[]>();
const STOP = new Set(['you', 'them', 'damage', 'with', 'an', 'a', 'are', 'have', 'the']);

/**
 * The game's own stun rules, read from the "Stun … Champions" triumphs: each line like
 * "[Void] when you suppress them" becomes a verb to look for in ability text.
 */
export function stunRules(defs: Defs): StunRule[] {
  const cached = ruleCache.get(defs);
  if (cached) return cached;
  const rules: StunRule[] = [];
  let rows: { json: string | Uint8Array }[] = [];
  try {
    rows = defs.db
      .prepare(
        `SELECT json FROM DestinyRecordDefinition
         WHERE json_extract(CAST(json AS TEXT), '$.displayProperties.description') LIKE 'Stun % Champions.%'`,
      )
      .all() as { json: string | Uint8Array }[];
  } catch {
    rows = [];
  }
  for (const row of rows) {
    const def = JSON.parse(typeof row.json === 'string' ? row.json : new TextDecoder().decode(row.json)) as DestinyRecordDefinition;
    const text = def.displayProperties.description;
    const champion = WORD[(text.match(/^Stun (\w+) Champions/)?.[1] ?? '').toLowerCase()];
    if (!champion) continue;
    for (const m of text.matchAll(/\[(Arc|Void|Solar|Strand|Stasis)\]\s*when you ([^;\n.]+)/g)) {
      const words = m[2].toLowerCase().split(/[^a-z]+/).filter(Boolean);
      const at = words.findIndex((w) => !STOP.has(w));
      if (at < 0) continue;
      const word = words[at];
      rules.push({ champion, element: m[1], verb: words[at + 1] === 'rounds' ? `${word} rounds` : word, pattern: verbPattern(word, words[at + 1] === 'rounds') });
    }
  }
  ruleCache.set(defs, rules);
  return rules;
}

/**
 * Matches the verb's own forms ("suppressed", "ignites", "jolt") but not look-alikes such as "slower",
 * "slowly", "slow-moving" or "shatter into"; "volatile rounds" must be the phrase, since a volatile
 * target is not the same as volatile rounds.
 */
function verbPattern(word: string, rounds: boolean): RegExp {
  if (rounds) return new RegExp(`\\b${word.replace(/ing$/, '')}(?:ing)? rounds\\b`, 'i');
  const base = word.replace(/(ion|ing)$/, '');
  return new RegExp(`\\b${base}(?:e|es|s|ed|ing|ion|ions)?\\b(?!-|\\s+into\\b)`, 'i');
}

/** Stun verbs (suppress, blind, volatile rounds…) that a piece of ability text mentions. */
export function verbsInText(text: string, rules: StunRule[]): StunRule[] {
  return rules.filter((r) => r.pattern.test(text));
}

/** Champion types a single plug grants: its breaker type, a hidden champion trait perk, or its text. */
export function plugChampions(defs: Defs, plug: DestinyInventoryItemDefinition | undefined): Champion[] {
  if (!plug) return [];
  const out = new Set<Champion>();
  const byHash = plug.breakerTypeHash ? BREAKER_HASH[plug.breakerTypeHash] : undefined;
  if (byHash) out.add(byHash);
  for (const p of plug.perks ?? []) {
    const name = defs.sandboxPerk(p.perkHash)?.displayProperties?.name ?? '';
    const tag = name.match(/\[(Shield-Piercing|Disruption|Stagger)\]/i)?.[1];
    if (tag) out.add(TAG[tag.toLowerCase()]);
  }
  for (const c of championsInText(defs.describePlug(plug))) out.add(c);
  return [...out];
}

function socketPlugs(inv: InventoryModel, defs: Defs, item: Item): DestinyInventoryItemDefinition[] {
  const sockets = item.instanceId ? inv.raw.itemComponents?.sockets?.data?.[item.instanceId]?.sockets : undefined;
  return (sockets ?? []).flatMap((s) => {
    const d = s.plugHash && s.isEnabled !== false ? defs.item(s.plugHash) : undefined;
    return d ? [d] : [];
  });
}

/** What champions a weapon or exotic armor piece handles on its own (not counting the artifact). */
export function itemChampions(inv: InventoryModel, defs: Defs, item: Item, extras: ChampionExtras = {}): ChampionSource[] {
  const out: ChampionSource[] = [];
  const add = (s: ChampionSource) => {
    if (!out.some((o) => o.champion === s.champion && o.via === s.via)) out.push(s);
  };
  const override = extras.overrides?.[String(item.hash)];
  if (override === 'none') return [];
  if (override) return [{ champion: override, kind: 'override', via: item.name, confidence: 'high', note: 'data/champion-overrides.json' }];

  const def = defs.item(item.hash);
  const own = (def?.breakerTypeHash && BREAKER_HASH[def.breakerTypeHash]) || (def?.breakerType && BREAKER_ENUM[def.breakerType]);
  if (own) add({ champion: own, kind: item.kind === 'armor' ? 'exotic-armor' : 'weapon', via: item.name, confidence: 'high' });
  const community = extras.extendedBreaker?.[String(item.hash)];
  if (community && BREAKER_HASH[community]) add({ champion: BREAKER_HASH[community], kind: 'community', via: item.name, confidence: 'high', note: 'DIM extended-breaker data' });

  for (const plug of socketPlugs(inv, defs, item)) {
    const cat = plug.plug?.plugCategoryIdentifier ?? '';
    if (/shader|ornament|tracker|masterwork|memento/i.test(cat)) continue;
    const kind: ChampionSourceKind = item.kind === 'armor' ? 'exotic-armor' : cat === 'intrinsics' ? 'frame' : 'perk';
    for (const c of plugChampions(defs, plug)) add({ champion: c, kind, via: `${item.name}: ${plug.displayProperties.name}`, confidence: 'high' });
  }
  return out;
}

/** Stun verbs in a weapon's perks or an armor piece's exotic perk (e.g. Voltshot jolts, Incandescent ignites). */
function itemVerbSources(inv: InventoryModel, defs: Defs, item: Item, rules: StunRule[]): ChampionSource[] {
  const out: ChampionSource[] = [];
  for (const plug of socketPlugs(inv, defs, item)) {
    const cat = plug.plug?.plugCategoryIdentifier ?? '';
    // Traits, frames and origin perks; barrels and magazines only describe handling ("reloads slower").
    if (item.kind === 'weapon' && !/^(intrinsics|frames|origins)$/.test(cat)) continue;
    if (item.kind === 'armor' && cat !== 'intrinsics') continue;
    for (const r of verbsInText(defs.describePlug(plug), rules)) {
      out.push({
        champion: r.champion,
        kind: item.kind === 'armor' ? 'exotic-armor' : 'perk',
        via: `${item.name}: ${plug.displayProperties.name}`,
        confidence: 'medium',
        note: `mentions "${r.verb}" (${r.element}); stuns if that effect lands on the champion`,
      });
    }
  }
  return out;
}

function subclassSources(plugs: SubclassPlug[], rules: StunRule[], kind: ChampionSourceKind, prefix = ''): ChampionSource[] {
  const out: ChampionSource[] = [];
  for (const p of plugs) {
    for (const c of championsInText(p.description)) out.push({ champion: c, kind, via: `${prefix}${p.name}`, confidence: 'high' });
    for (const r of verbsInText(p.description, rules)) {
      out.push({ champion: r.champion, kind, via: `${prefix}${p.name}`, confidence: 'medium', note: `mentions "${r.verb}" (${r.element}); stuns if that effect lands on the champion` });
    }
  }
  return out;
}

export interface CoverageReport {
  champions: Record<Champion, { covered: boolean; by: ChampionSource[] }>;
  gaps: Champion[];
}

/** Champion coverage of a set of items plus (optionally) a character's subclass and artifact. */
export function championCoverage(
  inv: InventoryModel,
  defs: Defs,
  opts: { items: Item[]; character?: Character; extras?: ChampionExtras },
): CoverageReport {
  const rules = stunRules(defs);
  const sources: ChampionSource[] = [];
  for (const item of opts.items) {
    if (item.kind !== 'weapon' && !(item.kind === 'armor' && item.isExotic)) continue;
    sources.push(...itemChampions(inv, defs, item, opts.extras), ...itemVerbSources(inv, defs, item, rules));
  }
  if (opts.character) {
    const equipped = inv.items.filter((i) => i.equipped && i.location.type === 'character' && i.location.characterId === opts.character!.id);
    const subclass = equipped.find((i) => i.kind === 'subclass');
    if (subclass) {
      const summary = describeSubclass(subclass, inv, defs, false);
      sources.push(...subclassSources(summary.sections.flatMap((s) => s.equipped), rules, 'subclass'));
    }
    const artifact = characterArtifacts(inv, opts.character.id).find((a) => a.equipped);
    if (artifact) {
      const perks = socketPlugs(inv, defs, artifact).filter((p) => p.plug?.plugCategoryIdentifier === 'artifact_perks' && !/^(empty|reset)\b/i.test(p.displayProperties.name));
      sources.push(
        ...subclassSources(
          perks.map((p) => ({ hash: p.hash, name: p.displayProperties.name, description: defs.describePlug(p) })),
          rules,
          'artifact',
          `${artifact.name}: `,
        ),
      );
    }
  }

  const champions = Object.fromEntries(CHAMPIONS.map((c) => [c, { covered: false, by: [] as ChampionSource[] }])) as CoverageReport['champions'];
  for (const s of sources) {
    const entry = champions[s.champion];
    if (entry.by.some((b) => b.via === s.via)) continue;
    entry.by.push(s);
    entry.covered = true;
  }
  for (const c of CHAMPIONS) sortSources(champions[c]);
  return { champions, gaps: CHAMPIONS.filter((c) => !champions[c].covered) };
}

function sortSources(e: { by: ChampionSource[] }): void {
  e.by.sort((a, b) => Number(a.confidence === 'medium') - Number(b.confidence === 'medium'));
}

/** The champion type a weapon handles, from game data only (cheap enough for list views). */
export function weaponChampion(inv: InventoryModel, defs: Defs, item: Item): string | undefined {
  if (item.kind !== 'weapon') return undefined;
  const found = [...new Set(itemChampions(inv, defs, item, { overrides: loadOverrides() }).map((s) => CHAMPION_NAMES[s.champion]))];
  return found.length ? found.join(', ') : undefined;
}

/** Owned weapons (usable by the character, not equipped) that handle a champion type, strongest first. */
export function ownedChampionWeapons(inv: InventoryModel, defs: Defs, character: Character, champion: Champion, extras: ChampionExtras, limit = 8) {
  return inv.items
    .filter(
      (i) =>
        i.kind === 'weapon' && i.instanceId && !(i.equipped && i.location.type === 'character' && i.location.characterId === character.id) &&
        i.location.type !== 'postmaster' && (WEAPON_BUCKETS as readonly number[]).includes(i.bucketHash),
    )
    .map((i) => ({ item: i, via: itemChampions(inv, defs, i, extras).find((s) => s.champion === champion) }))
    .filter((x) => x.via)
    .sort((a, b) => Number(b.item.isExotic === false) - Number(a.item.isExotic === false) || (b.item.power ?? 0) - (a.item.power ?? 0))
    .slice(0, limit);
}
