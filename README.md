# guardjin

An MCP server for **Destiny 2**. It connects Claude (Claude Code, Claude Desktop, or any MCP client) to your Bungie account so it can:

- **Suggest builds from gear you actually own**: subclass options, exotics, weapons, and an armor optimizer for Armor 3.0 (stats, archetypes, set bonuses, tiers, tuning, masterwork).
- **Track quests and bounties**: objective progress, quest steps, rewards and expiring bounties.
- **Manage your vault**: capacity overview, duplicates, dominated armor, community wishlist (god roll / trash) verdicts, cleanup suggestions, and actions to move, equip, lock and pull items.

Game data comes from Bungie's manifest and is read at runtime (stat names, sets, perks, bucket sizes), so the server keeps working as the game changes.

## One-time setup

1. **Register a Bungie app** at <https://www.bungie.net/en/Application> → *Create New App*:
   - **OAuth Client Type:** `Confidential`. This gives refresh tokens valid for about 90 days. With `Public` you would have to log in every hour.
   - **Redirect URL:** `https://localhost:7777/callback`
   - **Scope:** tick *Read your Destiny 2 information (Vault, Inventory, and Vendors)* and *Move or equip Destiny gear and other items*.
   - **Origin Header:** leave empty.
2. **Configure:** copy `.env.example` to `.env` and fill in `BUNGIE_API_KEY`, `BUNGIE_CLIENT_ID` and `BUNGIE_CLIENT_SECRET` from the app page.
3. **Build and log in:**

   ```bash
   npm install
   npm run build
   npm run auth
   ```

   `npm run auth` opens Bungie's consent page. After you approve, your browser is redirected to `https://localhost:7777/callback`. It will warn about the self-signed certificate, which is expected; continue to localhost. If the redirect page doesn't load, paste the URL from the address bar into the terminal instead. Tokens are saved to `~/.guardjin/tokens.json` and refresh automatically.
4. **Register the server with your MCP client.**

   Claude Code:

   ```bash
   claude mcp add guardjin -s user -- node C:/Users/genem/Code/guardjin/dist/index.js
   ```

   Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "guardjin": { "command": "node", "args": ["C:/Users/genem/Code/guardjin/dist/index.js"] }
     }
   }
   ```

   The server reads `.env` from the project folder, so you don't need to add env vars to the client config (you can if you prefer).

On first start, the server downloads the Destiny manifest (about 37 MB) into `~/.guardjin/manifest/`. It downloads again only when Bungie ships a game update.

## Try it

- *"Suggest a Warlock build for Grandmaster Nightfalls around grenades."* You can also use the **`suggest_build`** prompt.
- *"Find me the best Hunter armor with 150+ Weapons and 100 Health using Celestial Nighthawk."*
- *"How full is my vault? What can I dismantle?"* You can also use the **`clean_vault`** prompt.
- *"Which of my Fatebringers are god rolls?"*
- *"What quests do I have going, and which bounties are ready to turn in?"*
- *"What's Xûr selling, and which of it don't I own?"*
- *"Which exotic weapons am I missing, and which catalysts am I closest to finishing?"*
- *"What's this week's featured dungeon and its modifiers?"*
- *"Am I ready for this week's Master Nightfall on my Warlock?"* (`plan_activity`)
- *"Which champions does my current loadout handle?"* (`champion_coverage`)
- *"What dropped since Tuesday, and what should I lock?"* (`whats_new`, `triage_drops`)
- *"How did my last raid go? Which weapons did I use the most?"*
- *"How many Vault of Glass clears do I have, and what's my fastest?"*
- *"What season pass level am I, and what weekly milestones are left?"*
- *"Which weapon patterns can I craft?"*
- *"Build me a grenade Warlock, put the stat mods on, and save it as my Raid loadout."*
- *"Move all my Titan armor from my Hunter to the vault."*
- *"Lock everything the wishlist marks as a god roll."*

## Tools

| Tool | What it does |
| --- | --- |
| `session_brief` | One-call start of a session: characters, the main character's gear/artifact/stats, key currencies, vault and postmaster, this week's activities, Xûr and wanted-item hits, changes since the last brief |
| `auth_status` | Config and login status, linked Destiny account |
| `list_characters` | Characters with class, power, subclass and stat totals |
| `search_inventory` | Filters gear by name, slot, class, rarity, location, perk, element, min stats and tier; each result has a `label` (power, tier, standout perks or armor stats) that tells copies apart |
| `get_item_details` | Perks with descriptions and options, mods, masterwork, rolled/no-mod/masterworked stats, set bonus, champion type |
| `compare_items` | 2–6 weapons or armor pieces (or every owned copy of one item) side by side: aligned stat rows with the best marked, perks per column, and the differences, referring to each copy by its label |
| `get_equipped_loadout` | A character's equipped gear, subclass setup, artifact perks, stats and active set bonuses |
| `get_artifact` | A character's artifacts, the equipped one's active perks, and every perk option by tier |
| `get_subclass_options` | Unlocked supers and abilities, and every aspect and fragment with whether you have bought it (and the price if not), descriptions and stat bonuses; ownership comes from the Aspects and Fragments vendors (not available for Prismatic and Strand) |
| `find_source` | Where an item comes from, whether you own/collected it, pattern status, and whether any vendor (Xûr included) sells it now |
| `wanted_items` | A watch list of items you're hunting; `check` looks for them in every vendor's current stock |
| `query_manifest` | One read-only SQL SELECT against the game database, with your inventory as `temp.owned_items` |
| `lookup_definition` | Searches game data (exotics, perks, mods, aspects, fragments, set bonuses), including items you don't own |
| `optimize_armor` | Best 5-piece armor combinations for stat minimums and priorities, a required exotic, set bonuses, and stat mods; plans with the equipped subclass or with aspects/fragments you haven't equipped, counting every fragment's stat bonus |
| `export_build` / `audit_build` | Save the equipped setup as a JSON build spec; check a character against a spec and get the equip/plug changes that close the gaps |
| `champion_coverage` | Which champion types the equipped (or given) gear, subclass and artifact handle, with owned weapons that fill gaps |
| `vault_summary` | Vault use vs capacity, full character buckets, postmaster counts |
| `find_duplicates` | Duplicate weapons (reissues grouped) and exotic armor, with wishlist verdicts |
| `suggest_cleanup` | Ranked dismantle candidates with reasons and confidence (higher-tier copies are kept first) |
| `check_wishlist` | Wishlist verdicts for one weapon or all weapons |
| `whats_new` | New drops, dismantled items, lock/masterwork/tier/power, character power and currency changes since a date, from local history; `afterItem` / `newest` for older drops |
| `triage_drops` | Applies your keep rules (`~/.guardjin/keep-rules.json`) to unlocked gear: keep (with ids to lock), dismantle, or review, with the rule behind each |
| `get_quests` | Quests and bounties with objective progress, quest step, rewards, expiry and tracked state |
| `list_loadouts` | Saved in-game loadouts per character, with items, saved mods/aspects/fragments, active state, items that no longer exist, and free slots |
| `get_item_sockets` | An item's sockets with current plugs and their progress, and the options for one socket with unlock progress and why blocked ones can't be inserted |
| `get_weekly_activities` | What is active now: featured raids/dungeons, Nightfall, Trials and other milestones with modifiers, challenges and rotation dates |
| `plan_activity` | Reads an activity's current modifiers (champions, shields, surges, threats, locks, power) and checks a character against them, with owned gear that fills the gaps |
| `get_vendor` | A vendor's current stock (Xûr, Banshee-44, Ada-1...) with whether you already own each item; `public` shows the character-independent stock |
| `search_collectibles` | Collections: missing (or owned) weapons, armor, exotics, ornaments and shaders, filterable by rarity, type and source |
| `search_triumphs` | Triumphs, catalysts and seals with objective progress, closest-to-done first, plus your scores |
| `get_progression` | Season and season pass rank, Guardian Rank, equipped artifact, faction ranks, and weekly/daily milestone progress |
| `get_currencies` | Glimmer, shards, Bright Dust, Silver and other currencies, plus materials |
| `get_craftables` | Weapon patterns: which you can craft and why others are locked |
| `get_current_activity` | Where a character is (orbit, activity, offline), fireteam, and whether gear changes will likely be accepted |
| `get_kiosks` / `get_vendor_receipts` / `get_commendations` | Kiosk contents, refundable purchases, commendation scores |
| `get_career_stats` | Lifetime stats per mode (raid, dungeon, Nightfall, Crucible...) |
| `get_activity_clears` | Completions and fastest clear time per raid, dungeon and strike; filter by type, with owned and never-cleared raids/dungeons |
| `get_weapon_stats` | Lifetime kills and precision per weapon |
| `get_character` | One character read live: power, stats, and everything equipped |
| `get_recent_activities` | Recent activities per character (raids, dungeons, Crucible...) with result, duration and K/D/A |
| `get_activity_report` | Post-game report for one activity: every player, efficiency and per-weapon kills |
| `transfer_items` ✎ | Moves items to the vault or a character (via the vault; pulls from postmaster; checks space) |
| `equip_items` ✎ | Equips items (and artifacts), moving them first; checks class and exotic limits and swaps in a legendary when a new exotic would clash |
| `set_lock_state` ✎ | Locks or unlocks items |
| `pull_from_postmaster` ✎ | Pulls gear out of the postmaster |
| `track_quest` ✎ | Tracks or untracks a quest or bounty (instanced ones only) |
| `equip_loadout` ✎ | Equips a saved in-game loadout, moving its items over first |
| `save_loadout` ✎ | Saves what's equipped (optionally equipping given items first) into a loadout slot; replacing one needs `overwrite` |
| `rename_loadout` ✎ | Renames a loadout to one of the game's preset names |
| `clear_loadout` ✎ | Deletes a saved loadout (gear is untouched) |
| `apply_plugs` ✎ | Equips armor and weapon mods, weapon perk switches, subclass abilities/aspects/fragments, artifact perks, shaders, ornaments, tuning; checks fit, unlocks and armor energy. Refuses masterworks, catalysts, mementos and artifact resets |

**Bungie's data lags writes.** After a change (mod, perk, loadout, equip, quest tracking), Bungie's read endpoints can keep showing the old state for a minute or more (up to about 2.5 minutes in testing), and can flip between old and new meanwhile. Write tools report `confirmed: false` with a note instead of guessing; `apply_plugs` remembers its own recent changes for 5 minutes, and `get_character` / `get_item_details` read live. Loadout equips are also subject to the game's one-exotic-weapon / one-exotic-armor rule, which it enforces silently: `equip_loadout` warns in advance when a loadout's exotic would be skipped.

✎ = changes your inventory. Every write tool has a `dryRun` option. Bungie's API **cannot dismantle** items, so the cleanup flow is: lock what you keep, then dismantle the unlocked items in game. Equipping requires the character to be in orbit, in a social space, or offline.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BUNGIE_API_KEY` | (required) | API key from your Bungie app |
| `BUNGIE_CLIENT_ID` / `BUNGIE_CLIENT_SECRET` | (required) | OAuth client credentials |
| `GUARDJIN_HOME` | `~/.guardjin` | Tokens, manifest, wishlist and community data caches, local history (`guardjin.db`) and keep rules |
| `GUARDJIN_LANGUAGE` | `en` | Manifest language (`de`, `fr`, `es`, `ja`, ...) |
| `GUARDJIN_REDIRECT_PORT` | `7777` | Must match the redirect URL registered with Bungie |
| `GUARDJIN_WISHLIST_URL` | voltron.txt | Any DIM-format wishlist URL |
| `GUARDJIN_BUILDS_DIR` | `~/.guardjin/builds` | Where `export_build` writes and `audit_build` looks up build specs by name |

## How it works

```
src/
  index.ts             MCP server (stdio): registers tools and prompts
  context.ts           wires the services together
  config.ts            env/.env loading, data directory
  cli/auth.ts          `npm run auth` OAuth login
  bungie/              HTTP client (API key, token, throttling, action pacing), OAuth tokens, account lookup
  manifest/            downloads the world SQLite DB per game version; name index; typed definition lookups
  inventory/           GetProfile → normalized items (Armor 3.0 stat math, weapon perk columns), subclasses
  builds/optimizer.ts  armor search: Pareto pruning + branch-and-bound over 5 slots, stat-mod assignment
  builds/champions.ts  champion coverage: breaker types, hidden frame traits, "Strong against" text, stun verbs
  vault/               analysis (capacity, duplicates, dominance, cleanup), keep-rule triage, wishlist parser/matcher, transfer/equip/lock
  store/snapshots.ts   local history in ~/.guardjin/guardjin.db: first/last seen per item, periodic full snapshots
  community/data.ts    cached DIM community data (extra champion types, drop sources)
  tools/               MCP tool definitions, one file per group
  prompts/             suggest_build and clean_vault workflow prompts
```

A few details:

- **Armor stats.** The optimizer uses each piece's rolled stats (its `armor_stats` plugs) plus tuning and a full masterwork, which is +5 to the three lowest stats, per the in-game text. Armor mods are ignored so pieces are compared fairly. Stat mods are added back as +10 (major) or +5 (minor), one per piece.
- **Wishlist matching** compares perk *names*, so enhanced perks match their base versions. It checks every selectable option on the weapon, not only the perk currently selected.
- **Dominated armor:** another piece of the same class and slot (and the same exotic) that has at least the same tier, at least as good a set, and every masterworked stat ≥ this one.

## Development

```bash
npm run build       # compile to dist/
npm test            # vitest (uses a small extract of real manifest data in test/fixtures)
npm run typecheck   # src + tests
npm run inspect     # MCP Inspector against dist/index.js
```

### Adding a feature

1. Put the logic in a module under `src/` (for example `src/vendors/`), taking `InventoryModel` and `Defs` as inputs so it can be tested without the network.
2. Add `src/tools/<group>.ts` exporting `register<Group>Tools(server, ctx)`. Wrap handlers in `safe()` and return `ok(data)`. Mark write tools with the `WRITE` annotations.
3. Register it in `src/index.ts`, and add tests under `test/`.

Ideas on the roadmap: DIM Sync (tags and notes), in-game loadout slots (EquipLoadout/SnapshotLoadout), applying mods with `InsertSocketPlugFree`, activity and raid stats, and vendor and weekly-rotation lookups.
