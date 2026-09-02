/**
 * PermServiceImpl — standing parties.
 *
 * Every rule someone could argue with lives here: who may edit a roster, what
 * counts as a valid role for an activity, how many seats there are, what
 * happens to a name when a perm disbands, and which perm `/lfg perm:true`
 * autofills from.
 *
 * Two decisions shape the rest:
 *
 * - **A perm is addressed by name, not by id.** People invoke this from guild
 *   chat, from memory. So names are unique per guild while the perm is active,
 *   compared case-insensitively, and freed for reuse on disband.
 * - **Membership is by IGN.** Discord id and uuid are attached opportunistically
 *   when we can resolve them, and their absence is never an error. Most of a
 *   Hypixel guild has no linked account, and a perm that only works for linked
 *   members is a perm feature for a tenth of the guild.
 */
import {
  err,
  ok,
  type LFGActivity,
  type PermActor,
  type PermError,
  type PermGroupDTO,
  type PermMemberDTO,
  type PermService,
  type NewPermGroup,
  type Result,
  type RosterChange,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { capacityOf, classMetricFor, normalizeRole, rolesFor } from "./activities.js";
import type {
  GuildMemberDirectory,
  LinkDirectory,
  MemberProgress,
  MemberProgressSource,
  PermGroupRow,
  PermRepository,
} from "./ports.js";

const NAME_MIN = 2;
const NAME_MAX = 32;
/** Letters, digits, spaces and light punctuation. Keeps names typeable in chat. */
const NAME_SHAPE = /^[\w \-'&.]+$/u;

export interface PermServiceDeps {
  readonly repo: PermRepository;
  readonly logger: Logger;
  /** Optional: without it, rosters simply carry no in-guild marking or uuids. */
  readonly directory?: GuildMemberDirectory;
  /** Optional: without it, rosters carry no cata/SA columns. */
  readonly progress?: MemberProgressSource;
  /** Optional: without it, added members carry no Discord id. */
  readonly links?: LinkDirectory;
}

export class PermServiceImpl implements PermService {
  private readonly repo: PermRepository;
  private readonly log: Logger;
  private readonly directory: GuildMemberDirectory | undefined;
  private readonly progress: MemberProgressSource | undefined;
  private readonly links: LinkDirectory | undefined;

  constructor(deps: PermServiceDeps) {
    this.repo = deps.repo;
    this.log = deps.logger.child({ service: "perms" });
    this.directory = deps.directory;
    this.progress = deps.progress;
    this.links = deps.links;
  }

  async createPerm(input: NewPermGroup): Promise<Result<PermGroupDTO, PermError>> {
    const name = input.name.trim().replace(/\s+/gu, " ");
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      return err({
        kind: "INVALID_NAME",
        detail: `a perm name has to be ${NAME_MIN}–${NAME_MAX} characters.`,
      });
    }
    if (!NAME_SHAPE.test(name)) {
      return err({ kind: "INVALID_NAME", detail: "use letters, numbers, spaces and - ' & . only." });
    }

    // Checked here for the error message; the partial unique index in the
    // migration is what actually holds under a race.
    const clash = await this.repo.findByName(input.guildId, name);
    if (clash !== null && clash.status === "ACTIVE") return err({ kind: "NAME_TAKEN", name: clash.name });

    const row = await this.repo.create({
      guildId: input.guildId,
      ownerDiscordId: input.ownerDiscordId,
      name,
      activity: input.activity,
      notes: input.notes ?? null,
    });
    this.log.info("perm created", { permId: row.id, guildId: input.guildId, activity: input.activity });
    return ok(await this.enrich(row));
  }

  async getPerm(guildId: string, idOrName: string): Promise<Result<PermGroupDTO, PermError>> {
    const row = await this.resolve(guildId, idOrName);
    if (row === null) return err({ kind: "NOT_FOUND" });
    return ok(await this.enrich(row));
  }

  async listPerms(guildId: string, ownerDiscordId?: string): Promise<Result<readonly PermGroupDTO[]>> {
    const rows = await this.repo.list(guildId, ownerDiscordId);
    // Enriched in parallel: a list of five perms should not be five sequential
    // round trips to the member cache.
    return ok(await Promise.all(rows.map((row) => this.enrich(row))));
  }

  async addToRoster(input: RosterChange): Promise<Result<PermGroupDTO, PermError>> {
    const row = await this.resolve(input.guildId, input.idOrName);
    if (row === null) return err({ kind: "NOT_FOUND" });
    if (row.status === "DISBANDED") return err({ kind: "DISBANDED" });
    if (!mayEdit(row, input.actor)) return err({ kind: "NOT_OWNER" });

    const role = normalizeRole(row.activity, input.role);
    if (role === null) return err({ kind: "INVALID_ROLE", allowed: rolesFor(row.activity) });

    const ign = input.ign.trim();
    if (ign === "") return err({ kind: "INVALID_IGN" });

    const capacity = capacityOf(row.activity);
    if (row.members.length >= capacity) return err({ kind: "FULL", capacity });
    // Same person, same seat — not an error worth a stack trace, but the reply
    // has to say so rather than silently doing nothing.
    if (row.members.some((m) => sameIgn(m.ign, ign) && m.role === role)) {
      return err({ kind: "ALREADY_ON_ROSTER", ign });
    }

    // Resolved best-effort. A member the cache has never heard of is still a
    // valid roster entry — they may have joined since the last scan.
    const cached = await this.directory?.find(input.guildId, ign).catch(() => null);
    const discordId = await this.links?.discordIdForIgn(cached?.ign ?? ign).catch(() => null);

    const updated = await this.repo.addMember(row.id, {
      // Prefer the cache's spelling: it came from Mojang, and whoever typed the
      // command probably did not capitalise it the way its owner does.
      ign: cached?.ign ?? ign,
      role,
      slot: input.slot ?? nextSlot(row),
      discordId: discordId ?? null,
      uuid: cached?.uuid ?? null,
    });
    if (updated === null) return err({ kind: "NOT_FOUND" });
    this.log.info("perm roster add", { permId: row.id, role, resolved: cached !== null });
    return ok(await this.enrich(updated));
  }

  async removeFromRoster(input: RosterChange): Promise<Result<PermGroupDTO, PermError>> {
    const row = await this.resolve(input.guildId, input.idOrName);
    if (row === null) return err({ kind: "NOT_FOUND" });
    if (row.status === "DISBANDED") return err({ kind: "DISBANDED" });
    if (!mayEdit(row, input.actor)) return err({ kind: "NOT_OWNER" });

    const ign = input.ign.trim();
    const role = normalizeRole(row.activity, input.role);
    // Matched against the stored spelling rather than the typed one, so removing
    // works whether or not the caller got the capitalisation right.
    const seat = row.members.find((m) => sameIgn(m.ign, ign) && (role === null || m.role === role));
    if (seat === undefined) return err({ kind: "NOT_ON_ROSTER", ign });

    const updated = await this.repo.removeMember(row.id, seat.ign, seat.role);
    if (updated === null) return err({ kind: "NOT_FOUND" });
    this.log.info("perm roster remove", { permId: row.id, role: seat.role });
    return ok(await this.enrich(updated));
  }

  async disbandPerm(guildId: string, idOrName: string, actor: PermActor): Promise<Result<PermGroupDTO, PermError>> {
    const row = await this.resolve(guildId, idOrName);
    if (row === null) return err({ kind: "NOT_FOUND" });
    if (row.status === "DISBANDED") return err({ kind: "DISBANDED" });
    if (!mayEdit(row, actor)) return err({ kind: "NOT_OWNER" });

    const updated = await this.repo.setStatus(row.id, "DISBANDED");
    if (updated === null) return err({ kind: "NOT_FOUND" });
    this.log.info("perm disbanded", { permId: row.id, guildId, byOwner: row.ownerDiscordId === actor.discordId });
    return ok(await this.enrich(updated));
  }

  async setDefaultPerm(guildId: string, idOrName: string, actor: PermActor): Promise<Result<PermGroupDTO, PermError>> {
    const row = await this.resolve(guildId, idOrName);
    if (row === null) return err({ kind: "NOT_FOUND" });
    if (row.status === "DISBANDED") return err({ kind: "DISBANDED" });
    // Staff may disband someone else's perm — that is moderation. Choosing which
    // perm *your* `/lfg` autofills from is a personal preference, so only the
    // owner sets it, staff included.
    if (row.ownerDiscordId !== actor.discordId) return err({ kind: "NOT_OWNER" });

    const updated = await this.repo.setDefault(row.id);
    if (updated === null) return err({ kind: "NOT_FOUND" });
    this.log.info("perm default set", { permId: row.id, activity: row.activity });
    return ok(await this.enrich(updated));
  }

  async defaultPermFor(
    guildId: string,
    ownerDiscordId: string,
    activity: LFGActivity,
  ): Promise<Result<PermGroupDTO | null>> {
    const row = await this.repo.findDefault(guildId, ownerDiscordId, activity);
    return ok(row === null ? null : await this.enrich(row));
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** An id looks nothing like a name, so both spellings can share one argument. */
  private async resolve(guildId: string, idOrName: string): Promise<PermGroupRow | null> {
    const key = idOrName.trim();
    if (key === "") return null;
    const byId = await this.repo.findById(guildId, key);
    if (byId !== null) return byId;
    return this.repo.findByName(guildId, key);
  }

  /**
   * Attach what we know about each member from data already on hand.
   *
   * Enrichment is strictly additive and failure-tolerant: if the member cache or
   * the snapshot read falls over, the roster still renders with nulls where the
   * extra columns would be. A perm you cannot see because a cache is down is
   * worse than a perm shown without catacombs levels.
   */
  private async enrich(row: PermGroupRow): Promise<PermGroupDTO> {
    const [current, progress] = await Promise.all([
      this.directory?.currentIgns(row.guildId).catch(() => null) ?? Promise.resolve(null),
      this.loadProgress(row),
    ]);

    const members: PermMemberDTO[] = [...row.members]
      .sort((a, b) => a.slot - b.slot || a.ign.localeCompare(b.ign))
      .map((m) => {
        const stats = m.uuid === null ? undefined : progress[m.uuid];
        return {
          ign: m.ign,
          role: m.role,
          slot: m.slot,
          discordId: m.discordId,
          uuid: m.uuid,
          // A cold or empty cache means "we don't know", not "they left" — the
          // difference matters, because the second reads as an accusation.
          inGuild: current === null || current.size === 0 ? null : current.has(m.ign.toLowerCase()),
          catacombsLevel: stats?.catacombsLevel ?? null,
          skillAverage: stats?.skillAverage ?? null,
          // Resolved per seat rather than per member, because the answer depends
          // on the seat: the same player moved from archer to healer is a
          // different reading, and that is the reading the roster is for.
          roleLevel: classLevel(row.activity, m.role, stats),
        };
      });

    return {
      id: row.id,
      guildId: row.guildId,
      ownerDiscordId: row.ownerDiscordId,
      name: row.name,
      activity: row.activity,
      status: row.status,
      isDefault: row.isDefault,
      notes: row.notes,
      createdAt: row.createdAt,
      members,
      capacity: capacityOf(row.activity),
    };
  }

  private async loadProgress(row: PermGroupRow): Promise<Readonly<Record<string, MemberProgress>>> {
    const uuids = row.members.map((m) => m.uuid).filter((u): u is string => u !== null);
    if (this.progress === undefined || uuids.length === 0) return {};
    return this.progress.forUuids(uuids).catch(() => ({}));
  }
}

/**
 * The level of the class a seat is played as, when there is one to have.
 *
 * Every step is allowed to fail into null — a role with no class, a member with
 * no snapshot, a class never read — because all three are ordinary and none of
 * them should cost the roster its other columns.
 */
function classLevel(
  activity: LFGActivity,
  role: string,
  stats: MemberProgress | undefined,
): number | null {
  if (classMetricFor(activity, role) === null) return null;
  const level = stats?.classLevels?.[role.trim().toLowerCase()];
  return typeof level === "number" && Number.isFinite(level) ? level : null;
}

/** Owner or staff. Stated once so every surface enforces the same rule. */
function mayEdit(row: PermGroupRow, actor: PermActor): boolean {
  return row.ownerDiscordId === actor.discordId || actor.isStaff;
}

function sameIgn(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Append to the end of the roster, leaving explicit slot numbers alone. */
function nextSlot(row: PermGroupRow): number {
  return row.members.reduce((max, m) => Math.max(max, m.slot), 0) + 1;
}
