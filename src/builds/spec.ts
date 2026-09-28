import { z } from 'zod';
import { ARMOR_BUCKETS, ARMOR_STATS, ARMOR_STAT_KEYS, WEAPON_BUCKETS, type ArmorStatKey } from '../inventory/constants.js';
import type { Character, InventoryModel, Item } from '../inventory/model.js';
import { describeSubclass } from '../inventory/subclass.js';
import type { Defs } from '../manifest/defs.js';
import { characterArtifacts, describeArtifact } from '../progress/artifact.js';
import { CHAMPIONS, CHAMPION_NAMES, championCoverage, type Champion, type ChampionExtras } from './champions.js';

export const ARMOR_SLOT_KEYS = ['helmet', 'gauntlets', 'chest', 'legs', 'classItem'] as const;
export const WEAPON_SLOT_KEYS = ['kinetic', 'energy', 'power'] as const;
type ArmorSlotKey = (typeof ARMOR_SLOT_KEYS)[number];

const names = z.array(z.string());

/** A build as data, saved next to its notes so it can be checked against the live character. */
export const BuildSpecSchema = z.object({
  name: z.string(),
  class: z.enum(['titan', 'hunter', 'warlock']).optional(),
  notes: z.string().optional(),
  subclass: z
    .object({
      name: z.string().describe('e.g. "Voidwalker", "Prismatic"'),
      super: z.string().optional(),
      abilities: names.optional().describe('Class ability, movement, melee, grenade'),
      aspects: names.optional(),
      fragments: names.optional(),
    })
    .optional(),
  exoticArmor: z.string().optional(),
  armor: z
    .object({
      /** Specific pieces by instance id, when the build is tied to exact items. */
      items: names.optional(),
      sets: z.array(z.object({ name: z.string(), pieces: z.number().int().min(1).max(5) })).optional(),
      /** Minimum character stat totals (Armor 3.0 keys: weapons, health, class, grenade, super, melee). */
      stats: z.partialRecord(z.enum(ARMOR_STAT_KEYS as [ArmorStatKey, ...ArmorStatKey[]]), z.number()).optional(),
      mods: z.partialRecord(z.enum(ARMOR_SLOT_KEYS), names).optional(),
      masterworked: z.boolean().optional().describe('Expect every armor piece masterworked (default true)'),
    })
    .optional(),
  weapons: z
    .array(
      z.object({
        slot: z.enum(WEAPON_SLOT_KEYS).optional(),
        name: z.string(),
        id: z.string().optional(),
        perks: names.optional(),
        mod: z.string().optional(),
      }),
    )
    .optional(),
  artifact: z.object({ name: z.string(), perks: names.optional() }).optional(),
  champions: z.array(z.enum(['barrier', 'overload', 'unstoppable'])).optional(),
});
export type BuildSpec = z.infer<typeof BuildSpecSchema>;

const armorSlotKey = (bucketHash: number): ArmorSlotKey | undefined => ARMOR_SLOT_KEYS[(ARMOR_BUCKETS as readonly number[]).indexOf(bucketHash)];
const weaponSlotKey = (bucketHash: number) => WEAPON_SLOT_KEYS[(WEAPON_BUCKETS as readonly number[]).indexOf(bucketHash)];
const lc = (s: string) => s.trim().toLowerCase();
export const EMPTYISH = /^(empty|default)\b/i;

function equippedOn(inv: InventoryModel, characterId: string): Item[] {
  return inv.items.filter((i) => i.equipped && i.location.type === 'character' && i.location.characterId === characterId);
}

/** Current character stats keyed by Armor 3.0 stat key. */
export function characterStats(inv: InventoryModel, characterId: string): Record<ArmorStatKey, number> {
  const raw = inv.raw.characters?.data?.[characterId]?.stats ?? {};
  return Object.fromEntries(ARMOR_STATS.map((s) => [s.key, raw[s.hash] ?? 0])) as Record<ArmorStatKey, number>;
}

function subclassSection(sections: { category: string; equipped: { name: string }[] }[], category: string): string[] {
  return sections.filter((s) => s.category.toUpperCase() === category).flatMap((s) => s.equipped.map((p) => p.name));
}

/** Captures what a character has equipped as a build spec. */
export function exportBuild(inv: InventoryModel, defs: Defs, character: Character, name: string, extras: ChampionExtras): BuildSpec {
  const equipped = equippedOn(inv, character.id);
  const subclass = equipped.find((i) => i.kind === 'subclass');
  const summary = subclass ? describeSubclass(subclass, inv, defs, false) : undefined;
  const armor = equipped.filter((i) => i.kind === 'armor' && armorSlotKey(i.bucketHash));
  const setCounts = new Map<string, number>();
  for (const a of armor) if (a.armor?.set) setCounts.set(a.armor.set.name, (setCounts.get(a.armor.set.name) ?? 0) + 1);
  const artifact = characterArtifacts(inv, character.id).find((a) => a.equipped);
  const coverage = championCoverage(inv, defs, { items: equipped, character, extras });
  const stats = characterStats(inv, character.id);

  return {
    name,
    class: character.classType === 'any' ? undefined : character.classType,
    subclass: summary && {
      name: summary.name,
      super: subclassSection(summary.sections, 'SUPER')[0],
      abilities: subclassSection(summary.sections, 'ABILITIES'),
      aspects: subclassSection(summary.sections, 'ASPECTS'),
      fragments: subclassSection(summary.sections, 'FRAGMENTS'),
    },
    exoticArmor: armor.find((a) => a.isExotic)?.name,
    armor: {
      items: armor.map((a) => a.instanceId!),
      sets: [...setCounts].filter(([, n]) => n >= 2).map(([setName, pieces]) => ({ name: setName, pieces: pieces >= 4 ? 4 : 2 })),
      stats: Object.fromEntries(Object.entries(stats).filter(([, v]) => v > 0)) as Partial<Record<ArmorStatKey, number>>,
      mods: Object.fromEntries(armor.map((a) => [armorSlotKey(a.bucketHash)!, a.armor!.mods.map((m) => m.name)])) as Partial<Record<ArmorSlotKey, string[]>>,
    },
    weapons: equipped
      .filter((i) => i.kind === 'weapon')
      .map((w) => ({
        slot: weaponSlotKey(w.bucketHash),
        name: w.name,
        id: w.instanceId,
        perks: w.weapon?.perks.map((p) => p.equipped.name).filter((n) => !EMPTYISH.test(n)),
        mod: w.weapon?.mod?.name,
      })),
    artifact: artifact && { name: artifact.name, perks: describeArtifact(inv, defs, artifact).perks.map((p) => p.name) },
    champions: CHAMPIONS.filter((c) => coverage.champions[c].covered),
  };
}

export interface AuditIssue {
  area: 'class' | 'subclass' | 'exotic' | 'armor' | 'stats' | 'mods' | 'masterwork' | 'weapons' | 'artifact' | 'champions';
  message: string;
}

export interface AuditResult {
  matches: boolean;
  issues: AuditIssue[];
  /** Ready-to-use inputs for equip_items and apply_plugs (confirm with the user first). */
  suggested: { equip: { id: string; name: string }[]; plugs: { item: string; plug: string; socket?: number; for: string }[] };
}

/** Compares a build spec with what the character has equipped right now. */
export function auditBuild(inv: InventoryModel, defs: Defs, character: Character, spec: BuildSpec, extras: ChampionExtras): AuditResult {
  const issues: AuditIssue[] = [];
  const equip: AuditResult['suggested']['equip'] = [];
  const plugs: AuditResult['suggested']['plugs'] = [];
  const equipped = equippedOn(inv, character.id);
  const owned = (i: Item) => !!i.instanceId && (i.classType === 'any' || i.classType === character.classType) && i.location.type !== 'postmaster';
  const suggestEquip = (item: Item | undefined, why: string) => {
    if (item && !equip.some((e) => e.id === item.instanceId)) equip.push({ id: item.instanceId!, name: item.name });
    if (!item) issues.push({ area: 'weapons', message: `${why}: you don't own it` });
  };

  if (spec.class && spec.class !== character.classType) issues.push({ area: 'class', message: `spec is for a ${spec.class}; this is your ${character.className}` });

  // Subclass
  if (spec.subclass) {
    const want = spec.subclass;
    const current = equipped.find((i) => i.kind === 'subclass');
    const target = lc(current?.name ?? '').includes(lc(want.name))
      ? current
      : inv.items.find((i) => i.kind === 'subclass' && i.location.type === 'character' && i.location.characterId === character.id && lc(i.name).includes(lc(want.name)));
    if (!target) issues.push({ area: 'subclass', message: `no ${want.name} subclass on this character` });
    else {
      if (target !== current) {
        issues.push({ area: 'subclass', message: `equipped subclass is ${current?.name ?? 'none'}, spec wants ${target.name}` });
        equip.push({ id: target.instanceId!, name: target.name });
      }
      const summary = describeSubclass(target, inv, defs, false);
      const check = (category: string, wanted: string[] | undefined) => {
        const haveNames = subclassSection(summary.sections, category);
        const have = haveNames.map(lc);
        for (const w of wanted ?? []) {
          if (have.includes(lc(w))) continue;
          issues.push({ area: 'subclass', message: `${category.toLowerCase()}: ${w} is not equipped` });
          plugs.push({ item: target.instanceId!, plug: w, for: `${target.name} ${category.toLowerCase()}` });
        }
        if (category === 'FRAGMENTS' || category === 'ASPECTS') {
          const extra = haveNames.filter((h) => !(wanted ?? []).map(lc).includes(lc(h)));
          if (wanted && extra.length) issues.push({ area: 'subclass', message: `${category.toLowerCase()} not in the spec: ${extra.join(', ')}` });
        }
      };
      check('SUPER', want.super ? [want.super] : undefined);
      check('ABILITIES', want.abilities);
      check('ASPECTS', want.aspects);
      check('FRAGMENTS', want.fragments);
    }
  }

  // Armor
  const armor = equipped.filter((i) => i.kind === 'armor' && armorSlotKey(i.bucketHash));
  if (spec.exoticArmor) {
    const wornExotic = armor.find((a) => a.isExotic);
    if (!wornExotic || lc(wornExotic.name) !== lc(spec.exoticArmor)) {
      issues.push({ area: 'exotic', message: `exotic armor is ${wornExotic?.name ?? 'none'}, spec wants ${spec.exoticArmor}` });
      const copy = inv.items
        .filter((i) => owned(i) && i.kind === 'armor' && i.isExotic && lc(i.name) === lc(spec.exoticArmor!))
        .sort((a, b) => Number(!!b.armor && !b.armor.legacy) - Number(!!a.armor && !a.armor.legacy) || (b.gearTier ?? 0) - (a.gearTier ?? 0))[0];
      if (copy) equip.push({ id: copy.instanceId!, name: copy.name });
      else issues.push({ area: 'exotic', message: `you don't own ${spec.exoticArmor} for this class` });
    }
  }
  for (const id of spec.armor?.items ?? []) {
    if (armor.some((a) => a.instanceId === id)) continue;
    const item = inv.byId.get(id);
    issues.push({ area: 'armor', message: item ? `${item.name} [${id}] is not equipped` : `armor piece ${id} no longer exists` });
    if (item && !equip.some((e) => e.id === id)) equip.push({ id, name: item.name });
  }
  for (const s of spec.armor?.sets ?? []) {
    const count = armor.filter((a) => a.armor?.set && lc(a.armor.set.name).includes(lc(s.name))).length;
    if (count < s.pieces) issues.push({ area: 'armor', message: `${s.name}: ${count}/${s.pieces} pieces equipped` });
  }
  if (spec.armor?.stats) {
    const stats = characterStats(inv, character.id);
    const statName = (k: ArmorStatKey) => defs.stat(ARMOR_STATS.find((s) => s.key === k)!.hash)?.displayProperties.name ?? k;
    for (const [k, target] of Object.entries(spec.armor.stats) as [ArmorStatKey, number][]) {
      if (stats[k] < target) issues.push({ area: 'stats', message: `${statName(k)} ${stats[k]} (target ${target}, ${target - stats[k]} short)` });
    }
  }
  for (const [slot, wanted] of Object.entries(spec.armor?.mods ?? {}) as [ArmorSlotKey, string[]][]) {
    const piece = armor.find((a) => armorSlotKey(a.bucketHash) === slot);
    if (!piece) continue;
    const have = piece.armor!.mods.map((m) => lc(m.name));
    for (const w of wanted) {
      const at = have.indexOf(lc(w));
      if (at >= 0) {
        have.splice(at, 1);
        continue;
      }
      issues.push({ area: 'mods', message: `${piece.name}: ${w} missing` });
      plugs.push({ item: piece.instanceId!, plug: w, for: `${slot} mod` });
    }
  }
  if (spec.armor && spec.armor.masterworked !== false) {
    const notMw = armor.filter((a) => !a.masterworked).map((a) => a.name);
    if (notMw.length) issues.push({ area: 'masterwork', message: `armor not masterworked: ${notMw.join(', ')} (masterwork in game)` });
  }

  // Weapons
  const weapons = equipped.filter((i) => i.kind === 'weapon');
  for (const w of spec.weapons ?? []) {
    const worn = weapons.find((x) => (w.id ? x.instanceId === w.id : lc(x.name) === lc(w.name)));
    if (!worn) {
      const copy = w.id
        ? inv.byId.get(w.id)
        : inv.items.filter((i) => owned(i) && i.kind === 'weapon' && lc(i.name) === lc(w.name)).sort((a, b) => (b.gearTier ?? 0) - (a.gearTier ?? 0) || (b.power ?? 0) - (a.power ?? 0))[0];
      issues.push({ area: 'weapons', message: `${w.name} is not equipped` });
      suggestEquip(copy, w.name);
      continue;
    }
    if (worn.power !== undefined && worn.power <= 10) issues.push({ area: 'weapons', message: `${worn.name} is a legacy weapon stuck at power 10; replace it with a current copy` });
    for (const perk of w.perks ?? []) {
      const column = worn.weapon?.perks.find((c) => c.options.some((o) => lc(o.name) === lc(perk)));
      if (!column) issues.push({ area: 'weapons', message: `${worn.name}: this roll has no ${perk}` });
      else if (lc(column.equipped.name) !== lc(perk)) {
        issues.push({ area: 'weapons', message: `${worn.name}: ${perk} is available but ${column.equipped.name} is selected` });
        plugs.push({ item: worn.instanceId!, plug: perk, socket: column.socketIndex, for: `${worn.name} perk` });
      }
    }
    if (w.mod && lc(worn.weapon?.mod?.name ?? '') !== lc(w.mod)) {
      issues.push({ area: 'mods', message: `${worn.name}: weapon mod is ${worn.weapon?.mod?.name ?? 'empty'}, spec wants ${w.mod}` });
      plugs.push({ item: worn.instanceId!, plug: w.mod, for: `${worn.name} mod` });
    }
    if (!worn.masterworked) issues.push({ area: 'masterwork', message: `${worn.name} is not masterworked${worn.isExotic ? ' (its catalyst is not finished)' : ''}` });
  }

  // Artifact
  if (spec.artifact) {
    const artifacts = characterArtifacts(inv, character.id);
    const target = artifacts.find((a) => lc(a.name).includes(lc(spec.artifact!.name)));
    const current = artifacts.find((a) => a.equipped);
    if (!target) issues.push({ area: 'artifact', message: `no artifact named ${spec.artifact.name} on this character` });
    else {
      if (target !== current) {
        issues.push({ area: 'artifact', message: `equipped artifact is ${current?.name ?? 'none'}, spec wants ${target.name}` });
        equip.push({ id: target.instanceId!, name: target.name });
      }
      const active = describeArtifact(inv, defs, target).perks.map((p) => lc(p.name));
      for (const p of spec.artifact.perks ?? []) {
        if (active.includes(lc(p))) continue;
        issues.push({ area: 'artifact', message: `${target.name}: ${p} is not active` });
        plugs.push({ item: target.instanceId!, plug: p, for: 'artifact perk' });
      }
    }
  }

  // Champions
  if (spec.champions?.length) {
    const report = championCoverage(inv, defs, { items: equipped, character, extras });
    const missing = (spec.champions as Champion[]).filter((c) => !report.champions[c].covered);
    if (missing.length) issues.push({ area: 'champions', message: `no current answer to ${missing.map((c) => CHAMPION_NAMES[c]).join(', ')} (champion_coverage with scope "owned" suggests weapons)` });
  }

  return { matches: issues.length === 0, issues, suggested: { equip, plugs } };
}
