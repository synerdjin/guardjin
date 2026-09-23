import type { HttpClient } from 'bungie-api-ts/http';
import type { BungieMembershipType } from 'bungie-api-ts/destiny2';
import { getMembershipDataForCurrentUser } from 'bungie-api-ts/user';
import { unwrap } from './http.js';

export interface DestinyAccount {
  membershipType: BungieMembershipType;
  membershipId: string;
  displayName: string;
  bungieGlobalName?: string;
  /** Other Destiny memberships linked to the same Bungie.net account. */
  otherMemberships: { membershipType: number; membershipId: string; displayName: string }[];
}

export class AccountService {
  private cached: DestinyAccount | undefined;

  constructor(private readonly http: HttpClient) {}

  /** The logged-in user's primary Destiny membership (the cross-save primary if cross save is on). */
  async get(): Promise<DestinyAccount> {
    if (this.cached) return this.cached;
    const data = await unwrap(getMembershipDataForCurrentUser(this.http));
    const memberships = data.destinyMemberships;
    if (!memberships.length) throw new Error('This Bungie.net account has no Destiny 2 memberships.');
    const primary =
      memberships.find((m) => m.membershipId === data.primaryMembershipId) ??
      memberships.find((m) => m.crossSaveOverride === m.membershipType) ??
      memberships.find((m) => m.crossSaveOverride === 0) ??
      memberships[0];
    this.cached = {
      membershipType: primary.membershipType,
      membershipId: primary.membershipId,
      displayName: primary.displayName,
      bungieGlobalName: primary.bungieGlobalDisplayName
        ? `${primary.bungieGlobalDisplayName}#${String(primary.bungieGlobalDisplayNameCode ?? '').padStart(4, '0')}`
        : undefined,
      otherMemberships: memberships
        .filter((m) => m !== primary)
        .map((m) => ({ membershipType: m.membershipType, membershipId: m.membershipId, displayName: m.displayName })),
    };
    return this.cached;
  }

  clear(): void {
    this.cached = undefined;
  }
}
