import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DestinyEquipableItemSetDefinition, DestinyInventoryItemDefinition } from 'bungie-api-ts/destiny2';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ARMOR_STATS, Buckets, ItemType, Rarity, type ArmorStatKey } from '../inventory/constants.js';
import { locationLabel, namedStats, statTotal, type Item } from '../inventory/model.js';
import { describeSubclass } from '../inventory/subclass.js';
import type { Defs } from '../manifest/defs.js';
import { CHAMPION_NAMES, itemChampions, loadOverrides } from '../builds/champions.js';
import { artifactOptions, characterArtifacts, describeArtifact } from '../progress/artifact.js';
import { READ_ONLY, UserError, briefItem, ok, paginate, resolveCharacter, resolveItem, safe, statMapSchema } from './util.js';

const SLOT_ALIASES: Record<string, number> = {
  helmet: Buckets.Helmet,
  head: Buckets.Helmet,
  gauntlets: Buckets.Gauntlets,
  arms: Buckets.Gauntlets,
  gloves: Buckets.Gauntlets,
  chest: Buckets.Chest,
  legs: Buckets.Legs,
  boots: Buckets.Legs,
  'class item': Buckets.ClassItem,
  classitem: Buckets.ClassItem,
  class: Buckets.ClassItem,
  kinetic: Buckets.Kinetic,
  energy: Buckets.Energy,
  power: Buckets.Power,
  heavy: Buckets.Power,
  ghost: Buckets.Ghost,
  subclass: Buckets.Subclass,
};

export function registerInventoryTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'search_inventory',
    {
      title: 'Search inventory',
      description:
        'Searches all your gear (vault, characters, postmaster) with filters. Returns compact summaries with item ids to pass to other tools. ' +
        'Armor stats are shown without mods (add assumeMasterworked to see fully-masterworked stats). Weapon perks list every selectable option per column.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring of the item name'),
        kind: z.enum(['weapon', 'armor', 'subclass', 'ghost', 'any']).optional().describe('Default: any'),
        slot: z.string().optional().describe('helmet, gauntlets, chest, legs, class item, kinetic, energy, power, ghost, subclass'),
        class: z.enum(['titan', 'hunter', 'warlock']).optional().describe('Only armor usable by this class'),
        rarity: z.enum(['exotic', 'legendary', 'rare', 'uncommon', 'common']).optional(),
        location: z.string().optional().describe('"vault", "postmaster", or a character id/class name'),
        perk: z.string().optional().describe('Substring of a perk/trait/mod/exotic perk name the item has or can select'),
        element: z.string().optional().describe('Weapon damage type, e.g. Solar, Void, Arc, Stasis, Strand, Kinetic'),
        minStats: statMapSchema.optional().describe('Armor only: minimum value per stat (weapons, health, class, grenade, super, melee)'),
        minTier: z.number().int().min(1).max(5).optional().describe('Minimum gear tier (Armor 3.0 / new gear)'),
        assumeMasterworked: z.boolean().optional().describe('Use fully-masterworked armor stats for display and minStats'),
        sort: z.enum(['name', 'power', 'statTotal', 'tier']).optional().describe('Default: name'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 40'),
      },
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const q = args.query?.toLowerCase();
      const slotHash = args.slot ? SLOT_ALIASES[args.slot.toLowerCase()] : undefined;
      if (args.slot && slotHash === undefined) throw new UserError(`Unknown slot "${args.slot}". Use one of: ${Object.keys(SLOT_ALIASES).join(', ')}`);
      const perk = args.perk?.toLowerCase();
      const element = args.element?.toLowerCase();
      const statsOf = (i: Item) => (args.assumeMasterworked ? i.armor?.masterworked : i.armor?.noMods);

      let locationFilter: ((i: Item) => boolean) | undefined;
      if (args.location) {
        const l = args.location.toLowerCase();
        if (l === 'vault') locationFilter = (i) => i.location.type === 'vault';
        else if (l === 'postmaster') locationFilter = (i) => i.location.type === 'postmaster';
        else {
          const c = resolveCharacter(inv, args.location);
          locationFilter = (i) => i.location.type === 'character' && i.location.characterId === c.id;
        }
      }

      const results = inv.items.filter((i) => {
        if (!i.instanceId) return false;
        if (args.kind && args.kind !== 'any' && i.kind !== args.kind) return false;
        if (!args.kind && i.kind === 'other') return false;
        if (q && !i.name.toLowerCase().includes(q)) return false;
        if (slotHash !== undefined && i.bucketHash !== slotHash) return false;
        if (args.class && i.kind === 'armor' && i.classType !== args.class) return false;
        if (args.class && i.kind === 'subclass' && i.classType !== args.class) return false;
        if (args.rarity && i.rarity !== args.rarity) return false;
        if (locationFilter && !locationFilter(i)) return false;
        if (element && i.weapon?.element?.toLowerCase() !== element) return false;
        if (args.minTier && (i.gearTier ?? 0) < args.minTier) return false;
        if (perk && !itemPerkNames(i).some((n) => n.toLowerCase().includes(perk))) return false;
        if (args.minStats) {
          const v = statsOf(i);
          if (!v) return false;
          for (const [k, min] of Object.entries(args.minStats)) {
            const idx = ARMOR_STATS.findIndex((s) => s.key === (k as ArmorStatKey));
            if (min !== undefined && v[idx] < min) return false;
          }
        }
        return true;
      });

      const sort = args.sort ?? 'name';
      results.sort((a, b) => {
        if (sort === 'power') return (b.power ?? 0) - (a.power ?? 0);
        if (sort === 'tier') return (b.gearTier ?? 0) - (a.gearTier ?? 0);
        if (sort === 'statTotal') return statTotal(statsOf(b) ?? []) - statTotal(statsOf(a) ?? []);
        return a.name.localeCompare(b.name);
      });
      const page = paginate(results, args.offset ?? 0, args.limit ?? 40);
      return ok({ ...page, items: page.items.map((i) => briefItem(i, inv, defs, { masterworkedStats: args.assumeMasterworked })) });
    }),
  );

  server.registerTool(
    'get_item_details',
    {
      title: 'Item details',
      description:
        'Full details for one item: every perk/trait with its description and selectable options, mods, masterwork, stats (live, without mods, and fully masterworked for armor), armor set bonuses, exotic perk text, and which champion type it stuns.',
      inputSchema: {
        item: z.string().describe('Item id (preferred) or a unique item name'),
        live: z.boolean().optional().describe('Read this item fresh from Bungie instead of the cached profile (default true; the profile can lag recent changes by a minute or more)'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ item: ref, live }) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const item = resolveItem(inv, ref);
      if (live !== false) await ctx.profile.refreshItem(inv, item);
      const extras = { extendedBreaker: await ctx.community.get<Record<string, number>>('extendedBreaker'), overrides: loadOverrides() };
      const champions = item.kind === 'weapon' || item.isExotic ? itemChampions(inv, defs, item, extras) : [];
      return ok({
        ...itemDetails(item, defs, locationLabel(item.location, inv.characters)),
        antiChampion: champions.length ? champions.map((c) => `${CHAMPION_NAMES[c.champion]} (${c.via})`) : undefined,
      });
    }),
  );

  server.registerTool(
    'get_equipped_loadout',
    {
      title: 'Equipped loadout',
      description:
        "A character's equipped weapons and armor, the subclass setup (super, abilities, aspects, fragments), the equipped artifact and its active perks, and the character's current stat totals.",
      inputSchema: { character: z.string().optional().describe('Character id or class name; default is the most recently played') },
      annotations: READ_ONLY,
    },
    safe(async ({ character }) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character);
      const equipped = inv.items.filter((i) => i.equipped && i.location.type === 'character' && i.location.characterId === c.id);
      const subclass = equipped.find((i) => i.kind === 'subclass');
      const artifact = equipped.find((i) => i.bucketHash === Buckets.Artifact);
      const stats: Record<string, number> = {};
      for (const [hash, value] of Object.entries(inv.raw.characters?.data?.[c.id]?.stats ?? {})) {
        const name = defs.stat(Number(hash))?.displayProperties.name;
        if (name) stats[name] = value;
      }
      const armor = equipped.filter((i) => i.kind === 'armor');
      const setCounts = new Map<number, number>();
      for (const a of armor) if (a.armor?.set) setCounts.set(a.armor.set.hash, (setCounts.get(a.armor.set.hash) ?? 0) + 1);
      return ok({
        character: c,
        stats,
        subclass: subclass ? describeSubclass(subclass, inv, defs, false) : undefined,
        weapons: equipped.filter((i) => i.kind === 'weapon').map((i) => briefItem(i, inv, defs)),
        armor: armor.map((i) => ({ ...briefItem(i, inv, defs), mods: i.armor?.mods.map((m) => m.name) })),
        activeSetBonuses: activeSetBonuses(setCounts, defs),
        artifact: artifact ? describeArtifact(inv, defs, artifact) : undefined,
      });
    }),
  );

  server.registerTool(
    'get_artifact',
    {
      title: 'Artifact perks',
      description:
        'The artifacts on a character, which one is equipped, its active perks, and every perk it can take (tier 1–3, with descriptions). ' +
        'To change perks use apply_plugs on the artifact id (e.g. {item: <artifact id>, plug: "Void Renewal"}); to switch artifacts use equip_items. Resetting the artifact is done in game.',
      inputSchema: {
        character: z.string().optional().describe('Character id or class name; default is the most recently played'),
        artifact: z.string().optional().describe('Artifact name (substring); default is the equipped one'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ character, artifact: name }) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character);
      const all = characterArtifacts(inv, c.id);
      if (!all.length) throw new UserError(`Your ${c.className} has no artifacts.`);
      const q = name?.trim().toLowerCase();
      const pick = q ? all.find((a) => a.name.toLowerCase().includes(q)) : all[0];
      if (!pick) throw new UserError(`No artifact matches "${name}". Artifacts: ${all.map((a) => a.name).join(', ')}`);
      return ok({
        character: c.className,
        artifacts: all.map((a) => ({ id: a.instanceId, name: a.name, equipped: a.equipped || undefined })),
        selected: artifactOptions(inv, defs, pick),
      });
    }),
  );

  server.registerTool(
    'get_subclass_options',
    {
      title: 'Subclass options',
      description:
        'For each subclass on a character: what is equipped and every unlocked super, ability, aspect and fragment, with descriptions and stat bonuses. Use this to reason about builds; apply_plugs equips the choices.',
      inputSchema: {
        character: z.string().optional().describe('Character id or class name; default is the most recently played'),
        subclass: z.string().optional().describe('Only this subclass (name substring, e.g. "Prismatic", "Stormcaller")'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ character, subclass }) => {
      const inv = await ctx.profile.inventory();
      const defs = await ctx.manifest.load();
      const c = resolveCharacter(inv, character);
      const q = subclass?.toLowerCase();
      const subclasses = inv.items.filter(
        (i) =>
          i.kind === 'subclass' &&
          i.location.type === 'character' &&
          i.location.characterId === c.id &&
          (!q || i.name.toLowerCase().includes(q)),
      );
      if (!subclasses.length) throw new UserError(`No subclass${q ? ` matching "${subclass}"` : ''} found on your ${c.className}.`);
      return ok({ character: c.className, subclasses: subclasses.map((s) => describeSubclass(s, inv, defs, true)) });
    }),
  );

  server.registerTool(
    'lookup_definition',
    {
      title: 'Look up game definitions',
      description:
        'Searches the Destiny game database by name, including things you do not own: exotic armor/weapons (with their exotic perk), weapon perks, armor mods, aspects, fragments, abilities, and armor set bonuses.',
      inputSchema: {
        query: z.string().min(2).describe('Name or part of a name'),
        type: z
          .enum(['any', 'weapon', 'armor', 'exotic', 'mod', 'aspect', 'fragment', 'ability', 'perk', 'set'])
          .optional()
          .describe('Narrow the search; "set" searches armor set bonuses'),
        class: z.enum(['titan', 'hunter', 'warlock']).optional(),
        limit: z.number().int().min(1).max(25).optional().describe('Default 8'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, type = 'any', class: cls, limit = 8 }) => {
      const defs = await ctx.manifest.load();
      if (type === 'set') {
        const sets = defs.searchTable<DestinyEquipableItemSetDefinition>('DestinyEquipableItemSetDefinition', query, limit);
        return ok(sets.map((s) => describeSet(s, defs)));
      }
      const itemTypes =
        type === 'weapon' ? [ItemType.Weapon] : type === 'armor' ? [ItemType.Armor] : type === 'exotic' ? [ItemType.Weapon, ItemType.Armor] : undefined;
      const classType = cls ? ['titan', 'hunter', 'warlock'].indexOf(cls) : undefined;
      const rows = defs.searchItems({ query, itemTypes, classType, limit: limit * 6 }).filter((r) => {
        // Skip dummy/preview definitions (itemType 20) and untyped internal copies.
        if (r.itemType === 20 || !r.typeName) return false;
        if (type === 'exotic') return r.tierType === 6;
        const t = (r.typeName ?? '').toLowerCase();
        if (type === 'mod') return t.includes('mod');
        if (type === 'aspect') return t.includes('aspect');
        if (type === 'fragment') return t.includes('fragment');
        if (type === 'ability') return /grenade|melee|super|class ability|movement|jump|glide|barricade|rift|dodge/.test(t);
        if (type === 'perk') return t.includes('trait') || t.includes('perk') || t.includes('barrel') || t.includes('magazine') || t.includes('intrinsic');
        return true;
      });
      // Collapse duplicate definitions (reissues, enhanced variants) by name + type.
      const seen = new Set<string>();
      const out = [];
      for (const r of rows) {
        const key = `${r.name}|${r.typeName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const def = defs.item(r.hash);
        if (def) out.push(describeDefinition(def, defs));
        if (out.length >= limit) break;
      }
      return ok(out);
    }),
  );
}

function itemPerkNames(i: Item): string[] {
  const names: string[] = [];
  if (i.weapon) {
    for (const c of i.weapon.perks) for (const o of c.options) names.push(o.name);
    if (i.weapon.intrinsic) names.push(i.weapon.intrinsic.name);
    if (i.weapon.mod) names.push(i.weapon.mod.name);
  }
  if (i.armor) {
    if (i.armor.intrinsic) names.push(i.armor.intrinsic.name);
    if (i.armor.archetype) names.push(i.armor.archetype);
    if (i.armor.set) names.push(i.armor.set.name);
    for (const m of i.armor.mods) names.push(m.name);
  }
  return names;
}

function plugInfo(defs: Defs, hash: number) {
  const d = defs.item(hash);
  return { name: d?.displayProperties.name ?? `#${hash}`, description: defs.describePlug(d) || undefined };
}

export function describeSet(s: DestinyEquipableItemSetDefinition, defs: Defs) {
  return {
    set: s.displayProperties.name,
    hash: s.hash,
    bonuses: s.setPerks.map((p) => {
      const perk = defs.sandboxPerk(p.sandboxPerkHash);
      return { pieces: p.requiredSetCount, name: perk?.displayProperties.name, description: perk?.displayProperties.description };
    }),
  };
}

export function activeSetBonuses(setCounts: Map<number, number>, defs: Defs) {
  const out: { set: string; pieces: number; bonuses: { pieces: number; name?: string; description?: string; active: boolean }[] }[] = [];
  for (const [hash, count] of setCounts) {
    const s = defs.itemSet(hash);
    if (!s) continue;
    const d = describeSet(s, defs);
    out.push({ set: d.set, pieces: count, bonuses: d.bonuses.map((b) => ({ ...b, active: count >= b.pieces })) });
  }
  return out;
}

function describeDefinition(def: DestinyInventoryItemDefinition, defs: Defs) {
  const out: Record<string, unknown> = {
    hash: def.hash,
    name: def.displayProperties.name,
    type: def.itemTypeDisplayName,
  };
  const rarity = Rarity[def.inventory?.tierType ?? 0];
  if (rarity && rarity !== 'unknown' && rarity !== 'basic') out.rarity = rarity;
  if (def.classType !== undefined && def.classType < 3) out.class = ['titan', 'hunter', 'warlock'][def.classType];
  const description = defs.describePlug(def);
  if (description) out.description = description;
  if (def.flavorText) out.flavor = def.flavorText;
  // Exotic armor/weapon perks and weapon frames live in intrinsic sockets.
  const intrinsics: { name: string; description?: string }[] = [];
  for (const entry of def.sockets?.socketEntries ?? []) {
    const p = entry.singleInitialItemHash ? defs.item(entry.singleInitialItemHash) : undefined;
    const cat = p?.plug?.plugCategoryIdentifier ?? '';
    if (p && cat === 'intrinsics' && p.displayProperties.name) intrinsics.push(plugInfo(defs, p.hash));
  }
  if (intrinsics.length) out.intrinsic = intrinsics;
  const setHash = def.equippingBlock?.equipableItemSetHash;
  const set = setHash ? defs.itemSet(setHash) : undefined;
  if (set) out.setBonus = describeSet(set, defs);
  // Stat changes matter for mods and fragments; on armor/weapon definitions they are placeholders.
  const stats: Record<string, number> = {};
  const statSources = def.itemType === ItemType.Armor || def.itemType === ItemType.Weapon ? [] : def.investmentStats ?? [];
  for (const s of statSources) {
    if (s.isConditionallyActive || !s.value) continue;
    const name = defs.stat(s.statTypeHash)?.displayProperties.name;
    if (name && !name.includes('Cost') && !name.includes('Capacity')) stats[name] = s.value;
  }
  if (Object.keys(stats).length) out.stats = stats;
  return out;
}

function itemDetails(item: Item, defs: Defs, location: string) {
  const out: Record<string, unknown> = {
    id: item.instanceId,
    hash: item.hash,
    name: item.name,
    type: item.typeName,
    slot: item.slot,
    rarity: item.rarity,
    class: item.classType,
    tier: item.gearTier,
    power: item.power,
    location,
    equipped: item.equipped,
    locked: item.locked,
    masterworked: item.masterworked,
    crafted: item.crafted || undefined,
    stats: item.stats,
  };
  const def = defs.item(item.hash);
  if (def?.flavorText) out.flavor = def.flavorText;
  if (item.weapon) {
    const w = item.weapon;
    out.element = w.element;
    out.ammo = w.ammo;
    if (w.intrinsic) out.frame = plugInfo(defs, w.intrinsic.hash);
    out.perks = w.perks.map((c) => ({
      equipped: c.equipped.name,
      options: c.options.map((o) => plugInfo(defs, o.hash)),
    }));
    if (w.masterwork) out.masterwork = w.masterwork.name;
    if (w.mod) out.mod = plugInfo(defs, w.mod.hash);
  }
  if (item.armor) {
    const a = item.armor;
    out.archetype = a.archetype;
    if (a.intrinsic) out.intrinsic = plugInfo(defs, a.intrinsic.hash);
    out.armorStats = {
      rolled: namedStats(a.base, defs),
      withoutMods: namedStats(a.noMods, defs),
      fullyMasterworked: namedStats(a.masterworked, defs),
      totalWithoutMods: statTotal(a.noMods),
    };
    if (a.tuning) out.tuning = plugInfo(defs, a.tuning.hash);
    out.mods = a.mods.map((m) => plugInfo(defs, m.hash));
    if (a.energy) out.energy = a.energy;
    if (a.set) {
      const s = defs.itemSet(a.set.hash);
      if (s) out.setBonus = describeSet(s, defs);
    }
    if (a.legacy) out.note = 'Legacy (pre-Armor 3.0) armor: no archetype or set bonus, stats shown as-is.';
  }
  return out;
}
