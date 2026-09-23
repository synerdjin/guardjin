import type { HttpClient } from 'bungie-api-ts/http';
import { DestinyComponentType, getItem, getProfile, type DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import type { AccountService } from '../bungie/account.js';
import { unwrap } from '../bungie/http.js';
import type { ManifestLoader } from '../manifest/manifest.js';
import { buildInventory, buildItem, type InventoryModel, type Item } from './model.js';

const TTL_MS = 30_000;
/**
 * Bungie's read endpoints can trail a write by a minute or more (and flip between old and new
 * state meanwhile), so writes we made ourselves are overlaid on reads for this long.
 */
const WRITE_OVERLAY_MS = 5 * 60_000;

interface RecentWrites {
  at: number;
  plugs: Map<number, number>;
  energyUsed?: number;
}

const COMPONENTS = [
  DestinyComponentType.Profiles,
  DestinyComponentType.ProfileInventories,
  DestinyComponentType.Characters,
  DestinyComponentType.CharacterInventories,
  DestinyComponentType.CharacterEquipment,
  DestinyComponentType.CharacterLoadouts,
  DestinyComponentType.ItemInstances,
  DestinyComponentType.ItemStats,
  DestinyComponentType.ItemSockets, // also returns profile/character plug sets
  DestinyComponentType.ItemReusablePlugs,
];

/** Enough to read quests and bounties with their objective progress. */
const PURSUIT_COMPONENTS = [DestinyComponentType.Characters, DestinyComponentType.CharacterInventories, DestinyComponentType.ItemObjectives];

/** Fetches the user's profile and caches the normalized inventory for a short time. */
export class ProfileService {
  private cached: { at: number; model: InventoryModel } | undefined;
  private inflight: Promise<InventoryModel> | undefined;
  private readonly recentWrites = new Map<string, RecentWrites>();

  constructor(
    private readonly http: HttpClient,
    private readonly account: AccountService,
    private readonly manifest: ManifestLoader,
  ) {}

  async inventory(force = false): Promise<InventoryModel> {
    if (!force && this.cached && Date.now() - this.cached.at < TTL_MS) return this.cached.model;
    this.inflight ??= this.fetch().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Call after any write action so the next read sees fresh data. */
  invalidate(): void {
    this.cached = undefined;
  }

  /**
   * Raw profile with character pursuits and their objectives. Not cached: objective progress
   * changes while the user plays, and this response is small.
   */
  async pursuits(): Promise<DestinyProfileResponse> {
    return this.request(PURSUIT_COMPONENTS);
  }

  /** Remembers a confirmed plug insertion so later reads of the item reflect it while Bungie catches up. */
  recordPlug(instanceId: string, socketIndex: number, plugHash: number, energyUsed?: number): void {
    const entry = this.recentWrites.get(instanceId) ?? { at: 0, plugs: new Map<number, number>() };
    entry.at = Date.now();
    entry.plugs.set(socketIndex, plugHash);
    if (energyUsed !== undefined) entry.energyUsed = energyUsed;
    this.recentWrites.set(instanceId, entry);
  }

  /**
   * Replaces an item's data with live data from GetItem, rebuilding the model item (stats, perks,
   * mods, energy). GetProfile can trail a write by a minute or more, so anything that reports on or
   * plans changes to a single item should call this first. Plug writes we made ourselves are
   * overlaid, since GetItem can lag as well.
   */
  async refreshItem(inv: InventoryModel, item: Item): Promise<void> {
    if (!item.instanceId) return;
    const [account, defs] = await Promise.all([this.account.get(), this.manifest.load()]);
    const live = await unwrap(
      getItem(this.http, {
        membershipType: account.membershipType,
        destinyMembershipId: account.membershipId,
        itemInstanceId: item.instanceId,
        components: [
          DestinyComponentType.ItemCommonData,
          DestinyComponentType.ItemInstances,
          DestinyComponentType.ItemStats,
          DestinyComponentType.ItemSockets,
          DestinyComponentType.ItemReusablePlugs,
          DestinyComponentType.ItemPlugObjectives,
        ],
      }),
    );
    const id = item.instanceId;

    const recent = this.recentWrites.get(id);
    if (recent && Date.now() - recent.at > WRITE_OVERLAY_MS) this.recentWrites.delete(id);
    const overlay = this.recentWrites.get(id);
    const sockets = live.sockets?.data?.sockets as { plugHash: number }[] | undefined;
    if (overlay && sockets) for (const [index, plugHash] of overlay.plugs) if (sockets[index]) sockets[index] = { ...sockets[index], plugHash };
    const rawInstance = live.instance?.data;
    const instance =
      overlay?.energyUsed !== undefined && rawInstance?.energy ? { ...rawInstance, energy: { ...rawInstance.energy, energyUsed: overlay.energyUsed } } : rawInstance;

    const raw = inv.raw as unknown as { itemComponents?: Record<string, { data?: Record<string, unknown> } | undefined> };
    const components = (raw.itemComponents ??= {});
    const put = (key: string, data: unknown) => {
      if (!data) return;
      const entry = (components[key] ??= { data: {} });
      (entry.data ??= {})[id] = data;
    };
    put('sockets', live.sockets?.data);
    put('reusablePlugs', live.reusablePlugs?.data);
    put('instances', instance);
    put('stats', live.stats?.data);
    put('plugObjectives', live.plugObjectives?.data);

    if (live.item?.data) {
      const fresh = buildItem(live.item.data, item.location, item.equipped, inv.raw, defs);
      if (fresh) Object.assign(item, fresh);
    } else if (instance?.energy && item.armor) {
      item.armor.energy = { capacity: instance.energy.energyCapacity, used: instance.energy.energyUsed };
    }
  }

  /** Raw profile for an arbitrary component set. Not cached. */
  async components(components: DestinyComponentType[]): Promise<DestinyProfileResponse> {
    return this.request(components);
  }

  private async fetch(): Promise<InventoryModel> {
    const [profile, defs] = await Promise.all([this.request(COMPONENTS), this.manifest.load()]);
    const model = buildInventory(profile, defs);
    this.cached = { at: Date.now(), model };
    return model;
  }

  private async request(components: DestinyComponentType[]): Promise<DestinyProfileResponse> {
    const account = await this.account.get();
    return unwrap(
      getProfile(this.http, {
        membershipType: account.membershipType,
        destinyMembershipId: account.membershipId,
        components,
      }),
    );
  }
}
