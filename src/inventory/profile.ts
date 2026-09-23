import type { HttpClient } from 'bungie-api-ts/http';
import { DestinyComponentType, getProfile } from 'bungie-api-ts/destiny2';
import type { AccountService } from '../bungie/account.js';
import { unwrap } from '../bungie/http.js';
import type { ManifestLoader } from '../manifest/manifest.js';
import { buildInventory, type InventoryModel } from './model.js';

const TTL_MS = 30_000;

const COMPONENTS = [
  DestinyComponentType.Profiles,
  DestinyComponentType.ProfileInventories,
  DestinyComponentType.Characters,
  DestinyComponentType.CharacterInventories,
  DestinyComponentType.CharacterEquipment,
  DestinyComponentType.ItemInstances,
  DestinyComponentType.ItemStats,
  DestinyComponentType.ItemSockets, // also returns profile/character plug sets
  DestinyComponentType.ItemReusablePlugs,
];

/** Fetches the user's profile and caches the normalized inventory for a short time. */
export class ProfileService {
  private cached: { at: number; model: InventoryModel } | undefined;
  private inflight: Promise<InventoryModel> | undefined;

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

  private async fetch(): Promise<InventoryModel> {
    const [account, defs] = await Promise.all([this.account.get(), this.manifest.load()]);
    const profile = await unwrap(
      getProfile(this.http, {
        membershipType: account.membershipType,
        destinyMembershipId: account.membershipId,
        components: COMPONENTS,
      }),
    );
    const model = buildInventory(profile, defs);
    this.cached = { at: Date.now(), model };
    return model;
  }
}
