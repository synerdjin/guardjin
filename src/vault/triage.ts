import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARMOR_BUCKETS, Buckets, WEAPON_BUCKETS } from '../inventory/constants.js';
import { statTotal, type InventoryModel, type Item } from '../inventory/model.js';
import type { Defs } from '../manifest/defs.js';
import { weaponTierRank } from './analysis.js';
import { evaluateRoll, type Wishlist } from './wishlist.js';

/** Keep rules, stored in ~/.guardjin/keep-rules.json so they can be tuned without code changes. */
export interface KeepRules {
  armor: {
    /** Legendary armor at or above this tier is kept. */
    keepTierAtLeast: number;
    /** A kept-tier piece still goes when a higher-tier piece of the same set, archetype, class and slot exists. */
    yieldToHigherTierSameSetArchetype: boolean;
    /** Tier just below keepTierAtLeast is kept only when it is your only piece of that set in that slot. */
    keepLowerTierIfOnlyPieceOfSet: boolean;
    /** Pre-Armor 3.0 legendary armor is dismantled. */
    dismantleLegacy: boolean;
  };
  exotics: {
    /** Keep one copy of each exotic; prefer Armor 3.0 (new-gen) copies over legacy ones. */
    oneCopy: boolean;
  };
  weapons: {
    /** Keep one copy per legendary weapon (highest tier, then preferred perks, wishlist, power). */
    oneCopy: boolean;
    /** Perks that make a copy worth keeping (a second copy is kept when it has one the best copy lacks). */
    preferredPerks: string[];
    /** Legendary weapons stuck at power 10 are dismantled unless they are your only copy. */
    dismantlePowerTen: boolean;
  };
  /** The top N items by power in each slot are kept as infusion fuel. */
  keepTopPowerPerSlot: number;
  /** Items saved in an in-game loadout are kept. */
  keepLoadoutItems: boolean;
}

export const DEFAULT_RULES: KeepRules = {
  armor: { keepTierAtLeast: 4, yieldToHigherTierSameSetArchetype: true, keepLowerTierIfOnlyPieceOfSet: true, dismantleLegacy: true },
  exotics: { oneCopy: true },
  weapons: { oneCopy: true, preferredPerks: ['Destabilizing Rounds', 'Repulsor Brace', 'Incandescent', 'Demolitionist'], dismantlePowerTen: true },
  keepTopPowerPerSlot: 2,
  keepLoadoutItems: true,
};

export function loadRules(homeDir: string): { rules: KeepRules; file: string; created: boolean } {
  const file = join(homeDir, 'keep-rules.json');
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULT_RULES, null, 2));
    return { rules: DEFAULT_RULES, file, created: true };
  }
  const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<KeepRules>;
  return {
    rules: {
      ...DEFAULT_RULES,
      ...saved,
      armor: { ...DEFAULT_RULES.armor, ...saved.armor },
      exotics: { ...DEFAULT_RULES.exotics, ...saved.exotics },
      weapons: { ...DEFAULT_RULES.weapons, ...saved.weapons },
    },
    file,
    created: false,
  };
}

export type TriageAction = 'keep' | 'dismantle' | 'review';

export interface TriageDecision {
  item: Item;
  action: TriageAction;
  rule: string;
  reason: string;
}

const isGear = (i: Item) =>
  !!i.instanceId && (i.kind === 'weapon' || i.kind === 'armor') && i.location.type !== 'profile' &&
  ([...ARMOR_BUCKETS, ...WEAPON_BUCKETS] as number[]).includes(i.bucketHash);

const tierText = (i: Item) => (i.gearTier ? `T${i.gearTier}` : i.power !== undefined && i.power <= 10 ? 'legacy' : 'untiered');

/**
 * Applies the keep rules to `candidates`, comparing each against everything you own (locked items
 * included). Every candidate gets exactly one decision; the first rule that decides wins.
 */
export function triage(
  inv: InventoryModel,
  defs: Defs,
  candidates: Item[],
  rules: KeepRules,
  opts: { wishlist?: Wishlist; loadoutItemIds?: Set<string> } = {},
): TriageDecision[] {
  const gear = inv.items.filter(isGear);
  const preferred = new Set(rules.weapons.preferredPerks.map((p) => p.toLowerCase()));
  const perkNames = (i: Item) => new Set((i.weapon?.perks ?? []).flatMap((c) => c.options.map((o) => o.name.toLowerCase())));
  const preferredCount = (i: Item) => [...perkNames(i)].filter((p) => preferred.has(p)).length;
  const verdictRank = (i: Item) => {
    if (!opts.wishlist) return 0;
    return { wishlist: 3, unknown: 2, 'not-on-wishlist': 1, trash: 0 }[evaluateRoll(i, opts.wishlist, defs).verdict];
  };

  // Top-N power per slot (per class for armor).
  const topPower = new Set<Item>();
  if (rules.keepTopPowerPerSlot > 0) {
    const groups = new Map<string, Item[]>();
    for (const i of gear) {
      const key = `${i.bucketHash}:${i.kind === 'armor' ? i.classType : ''}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    for (const list of groups.values()) {
      for (const i of [...list].sort((a, b) => (b.power ?? 0) - (a.power ?? 0)).slice(0, rules.keepTopPowerPerSlot)) topPower.add(i);
    }
  }

  const bestOf = (list: Item[], score: (i: Item) => number[]) =>
    [...list].sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      for (let k = 0; k < sa.length; k++) if (sb[k] !== sa[k]) return sb[k] - sa[k];
      return (a.instanceId ?? '').localeCompare(b.instanceId ?? '');
    })[0];

  const decide = (item: Item): TriageDecision => {
    const d = (action: TriageAction, rule: string, reason: string): TriageDecision => ({ item, action, rule, reason });

    if (rules.keepLoadoutItems && opts.loadoutItemIds?.has(item.instanceId!)) return d('keep', 'loadout', 'saved in an in-game loadout');
    if (item.equipped) return d('keep', 'equipped', 'currently equipped');

    // Exotics: one copy each, new-gen preferred.
    if (item.isExotic && rules.exotics.oneCopy) {
      if (item.kind === 'armor' && item.bucketHash === Buckets.ClassItem) return d('review', 'exotic-class-item', 'exotic class items roll different perk pairs; compare perks by hand');
      const copies = gear.filter((g) => g.hash === item.hash || (g.name === item.name && g.kind === item.kind && g.isExotic));
      if (copies.length === 1) return d('keep', 'exotic-one-copy', 'your only copy of this exotic');
      const best = bestOf(copies, (c) => [
        c.kind === 'armor' ? Number(!c.armor?.legacy) : 0,
        weaponTierRank(c),
        c.kind === 'armor' ? statTotal(c.armor!.masterworked) : 0,
        Number(c.locked),
        c.power ?? 0,
      ]);
      if (best === item) return d('keep', 'exotic-one-copy', `best of ${copies.length} copies`);
      const why = item.armor?.legacy && !best.armor?.legacy ? `legacy copy; you own a new-gen ${tierText(best)} copy` : `you own a better copy (${tierText(best)}${best.locked ? ', locked' : ''})`;
      return d('dismantle', 'exotic-one-copy', why);
    }

    if (item.kind === 'armor') {
      const a = item.armor!;
      if (a.legacy && rules.armor.dismantleLegacy) {
        return topPower.has(item) ? d('keep', 'top-power', 'legacy armor, but one of your highest-power pieces in this slot (infusion fuel)') : d('dismantle', 'legacy-armor', 'pre-Armor 3.0 legendary armor');
      }
      const tier = item.gearTier ?? 0;
      const sameSlot = gear.filter((g) => g !== item && g.kind === 'armor' && !g.isExotic && g.bucketHash === item.bucketHash && g.classType === item.classType);
      if (tier >= rules.armor.keepTierAtLeast) {
        if (rules.armor.yieldToHigherTierSameSetArchetype) {
          const better = sameSlot.find((g) => (g.gearTier ?? 0) > tier && g.armor?.set?.hash === a.set?.hash && g.armor?.archetype === a.archetype);
          if (better) return d('dismantle', 'armor-tier', `T${tier}, but you own a T${better.gearTier} ${a.set?.name ?? ''} ${a.archetype ?? ''} piece for this slot`.replace(/\s+/g, ' '));
        }
        return d('keep', 'armor-tier', `T${tier} armor`);
      }
      if (topPower.has(item)) return d('keep', 'top-power', 'one of your highest-power pieces in this slot (infusion fuel)');
      if (tier === rules.armor.keepTierAtLeast - 1 && rules.armor.keepLowerTierIfOnlyPieceOfSet) {
        const sameSet = sameSlot.some((g) => a.set && g.armor?.set?.hash === a.set.hash);
        if (a.set && !sameSet) return d('keep', 'only-set-piece', `your only ${a.set.name} piece for this slot`);
        return d('dismantle', 'armor-tier', `T${tier}${a.set ? `; you own other ${a.set.name} pieces for this slot` : ' without a set bonus'}`);
      }
      return d('dismantle', 'armor-tier', `T${tier || '?'} armor`);
    }

    // Legendary weapons.
    if (item.kind === 'weapon') {
      const copies = gear.filter((g) => g.kind === 'weapon' && g.name === item.name);
      if (rules.weapons.dismantlePowerTen && item.power !== undefined && item.power <= 10 && !item.gearTier) {
        if (copies.length === 1) return d('review', 'power-ten', 'stuck at power 10, but your only copy; keep only if the roll is unique');
        return d('dismantle', 'power-ten', 'legacy weapon stuck at power 10 and you own another copy');
      }
      if (topPower.has(item)) return d('keep', 'top-power', 'one of your highest-power weapons in this slot (infusion fuel)');
      if (!rules.weapons.oneCopy || copies.length === 1) return d('keep', 'weapon-one-copy', 'your only copy');
      const best = bestOf(copies, (c) => [weaponTierRank(c), preferredCount(c), verdictRank(c), Number(c.crafted), c.power ?? 0]);
      if (best === item) return d('keep', 'weapon-one-copy', `best of ${copies.length} copies (${tierText(item)})`);
      const extra = rules.weapons.preferredPerks.filter((p) => perkNames(item).has(p.toLowerCase()) && !perkNames(best).has(p.toLowerCase()));
      if (extra.length) return d('review', 'weapon-one-copy', `the best copy (${tierText(best)}) lacks ${extra.join(', ')}; keep only if it fills a different role`);
      return d('dismantle', 'weapon-one-copy', `you own a better copy (${tierText(best)}${best.locked ? ', locked' : ''})`);
    }
    return d('review', 'unknown', 'no rule covers this item');
  };

  return candidates.filter(isGear).map(decide);
}
