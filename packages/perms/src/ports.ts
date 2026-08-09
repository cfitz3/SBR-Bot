/**
 * What the perm service needs from the outside world.
 *
 * Two of these are enrichment rather than storage. A perm names people by IGN,
 * and the interesting question about a roster — is this person still in the
 * guild, how far along are they — is answered from data we already have: the 6h
 * member cache from Phase 2 and the newest `ProfileSnapshot`. Neither read
 * touches Hypixel, because `/perm info` on a five-person roster would otherwise
 * be five live API calls for a command people run casually.
 */
import type { LFGActivity, PermStatus } from "@sbr/shared-types";

/** A perm as stored, before roster enrichment. */
export interface PermGroupRow {
  readonly id: string;
  readonly guildId: string;
  readonly ownerDiscordId: string;
  readonly name: string;
  readonly activity: LFGActivity;
  readonly status: PermStatus;
  readonly isDefault: boolean;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly members: readonly PermMemberRow[];
}

export interface PermMemberRow {
  readonly ign: string;
  readonly role: string;
  readonly slot: number;
  readonly discordId: string | null;
  readonly uuid: string | null;
}

export interface NewPermMemberRow {
  readonly ign: string;
  readonly role: string;
  readonly slot: number;
  readonly discordId?: string | null;
  readonly uuid?: string | null;
}

/** What the member cache knows about one IGN. */
export interface CachedGuildMember {
  readonly uuid: string;
  readonly ign: string;
}

/** Newest snapshot stats for one uuid. Every field may be unknown. */
export interface MemberProgress {
  readonly catacombsLevel: number | null;
  readonly skillAverage: number | null;
}

export interface PermRepository {
  create(input: {
    guildId: string;
    ownerDiscordId: string;
    name: string;
    activity: LFGActivity;
    notes: string | null;
  }): Promise<PermGroupRow>;
  findById(guildId: string, id: string): Promise<PermGroupRow | null>;
  /** Case-insensitive; ACTIVE perms win over disbanded ones with the same name. */
  findByName(guildId: string, name: string): Promise<PermGroupRow | null>;
  list(guildId: string, ownerDiscordId?: string): Promise<readonly PermGroupRow[]>;
  findDefault(guildId: string, ownerDiscordId: string, activity: LFGActivity): Promise<PermGroupRow | null>;
  addMember(permGroupId: string, member: NewPermMemberRow): Promise<PermGroupRow | null>;
  removeMember(permGroupId: string, ign: string, role: string): Promise<PermGroupRow | null>;
  setStatus(permGroupId: string, status: PermStatus): Promise<PermGroupRow | null>;
  /**
   * Make this perm the owner's default for its activity, clearing any previous
   * one. A single call because the two writes have to land together — two
   * defaults is a state the command surface has no way to describe.
   */
  setDefault(permGroupId: string): Promise<PermGroupRow | null>;
}

/**
 * The 6h in-game roster cache (Phase 2). Used to attach uuids when someone is
 * added, and to mark members who are no longer in the guild.
 */
export interface GuildMemberDirectory {
  /** Lookup by IGN, case-insensitive. Null when the cache has no such member. */
  find(guildId: string, ign: string): Promise<CachedGuildMember | null>;
  /** IGNs currently in the guild, lowercase. Empty means "cache is cold". */
  currentIgns(guildId: string): Promise<ReadonlySet<string>>;
}

/** Newest ProfileSnapshot per uuid. Missing uuids simply have no entry. */
export interface MemberProgressSource {
  forUuids(uuids: readonly string[]): Promise<Readonly<Record<string, MemberProgress>>>;
}

/** Resolve an IGN to a linked Discord id, where one exists. */
export interface LinkDirectory {
  discordIdForIgn(ign: string): Promise<string | null>;
}
