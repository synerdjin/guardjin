/** Inventory bucket hashes (DestinyInventoryBucketDefinition). */
export const Buckets = {
  Vault: 138197802,
  Postmaster: 215593132,
  Subclass: 3284755031,
  Kinetic: 1498876634,
  Energy: 2465295065,
  Power: 953998645,
  Helmet: 3448274439,
  Gauntlets: 3551918588,
  Chest: 14239492,
  Legs: 20886954,
  ClassItem: 1585787867,
  Ghost: 4023194814,
  /** Character pursuits: quests, bounties and quest items. */
  Quests: 1345459588,
  Consumables: 1469714392,
  Materials: 3865314626,
  Modifications: 3313201758,
} as const;

export const ARMOR_BUCKETS = [Buckets.Helmet, Buckets.Gauntlets, Buckets.Chest, Buckets.Legs, Buckets.ClassItem] as const;
export const WEAPON_BUCKETS = [Buckets.Kinetic, Buckets.Energy, Buckets.Power] as const;

/**
 * The six Armor 3.0 character stats, in display order. Names shown to users come from the manifest;
 * these keys are the stable identifiers tools accept.
 */
export const ARMOR_STATS = [
  { key: 'weapons', hash: 2996146975 },
  { key: 'health', hash: 392767087 },
  { key: 'class', hash: 1943323491 },
  { key: 'grenade', hash: 1735777505 },
  { key: 'super', hash: 144602215 },
  { key: 'melee', hash: 4244567218 },
] as const;
export type ArmorStatKey = (typeof ARMOR_STATS)[number]['key'];
export const ARMOR_STAT_KEYS = ARMOR_STATS.map((s) => s.key) as ArmorStatKey[];
export const ARMOR_STAT_INDEX = new Map<number, number>(ARMOR_STATS.map((s, i) => [s.hash, i]));
/** Character stats go from 0 to 200 in Armor 3.0; points above 200 do nothing. */
export const STAT_CAP = 200;

/** DestinyItemComponent.state flags. */
export const ItemStateFlags = {
  Locked: 1,
  Tracked: 2,
  Masterwork: 4,
  Crafted: 8,
} as const;

/** DestinyItemType values we care about. */
export const ItemType = {
  Armor: 2,
  Weapon: 3,
  Quest: 12,
  QuestStep: 13,
  QuestStepComplete: 14,
  Subclass: 16,
  Mod: 19,
  Ghost: 24,
  Bounty: 26,
} as const;

/** DestinyClass values. */
export const ClassNames = ['titan', 'hunter', 'warlock', 'any'] as const;
export type ClassName = (typeof ClassNames)[number];

/** TierType → rarity. */
export const Rarity: Record<number, string> = {
  0: 'unknown',
  1: 'currency',
  2: 'basic',
  3: 'uncommon',
  4: 'rare',
  5: 'legendary',
  6: 'exotic',
};

/** Weapon socket categories (DestinySocketCategoryDefinition). */
export const SocketCategories = {
  WeaponIntrinsic: 3956125808,
  WeaponPerks: 4241085061,
  WeaponMods: 2685412949,
} as const;

/** Wishlist entries with this item hash apply to every item. */
export const WISHLIST_ANY_ITEM = -69420;
