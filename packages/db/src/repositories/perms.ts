/**
 * Persistence for perms, plus the three read-only adapters the perm service
 * enriches a roster with.
 *
 * The enrichment adapters live here rather than in `@sbr/perms` because they are
 * queries against tables the domain package has no business knowing about: the
 * Phase 2 member cache, `ProfileSnapshot`, and the account link. The service
 * sees three narrow ports and stays testable without a database.
 */
import { Prisma } from "@prisma/client";
import { classMetricFor, classRolesFor } from "@sbr/perms";
import type {
  CachedGuildMember,
  GuildMemberDirectory,
  LinkDirectory,
  MemberProgress,
  MemberProgressSource,
  NewPermMemberRow,
  PermGroupRow,
  PermRepository,
} from "@sbr/perms";
import type { LFGActivity, PermStatus } from "@sbr/shared-types";
import { prisma } from "../client.js";

/** Every read returns the roster, because every caller renders it. */
const WITH_MEMBERS = {
  members: { orderBy: { slot: "asc" } as const },
} as const;

type PermRecord = Prisma.PermGroupGetPayload<{ include: typeof WITH_MEMBERS }>;

function toRow(row: PermRecord): PermGroupRow {
  return {
    id: row.id,
    guildId: row.guildId,
    ownerDiscordId: row.ownerDiscordId,
    name: row.name,
    activity: row.activity as LFGActivity,
    status: row.status as PermStatus,
    isDefault: row.isDefault,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    members: row.members.map((m) => ({
      ign: m.ign,
      role: m.role,
      slot: m.slot,
      discordId: m.discordId,
      uuid: m.uuid,
    })),
  };
}

async function load(permGroupId: string): Promise<PermGroupRow | null> {
  const row = await prisma.permGroup.findUnique({ where: { id: permGroupId }, include: WITH_MEMBERS });
  return row === null ? null : toRow(row);
}

export const permRepository: PermRepository = {
  async create(input): Promise<PermGroupRow> {
    const row = await prisma.permGroup.create({
      data: {
        guildId: input.guildId,
        ownerDiscordId: input.ownerDiscordId,
        name: input.name,
        activity: input.activity,
        notes: input.notes,
      },
      include: WITH_MEMBERS,
    });
    return toRow(row);
  },

  async findById(guildId: string, id: string): Promise<PermGroupRow | null> {
    const row = await prisma.permGroup.findFirst({ where: { id, guildId }, include: WITH_MEMBERS });
    return row === null ? null : toRow(row);
  },

  /**
   * Case-insensitive, active-first. A disbanded perm keeps its name and stays
   * readable by it, but only until someone reuses the name — at which point the
   * live one is what `/perm info carries` should mean.
   */
  async findByName(guildId: string, name: string): Promise<PermGroupRow | null> {
    const row = await prisma.permGroup.findFirst({
      where: { guildId, name: { equals: name, mode: "insensitive" } },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: WITH_MEMBERS,
    });
    return row === null ? null : toRow(row);
  },

  async list(guildId: string, ownerDiscordId?: string): Promise<readonly PermGroupRow[]> {
    const rows = await prisma.permGroup.findMany({
      where: { guildId, status: "ACTIVE", ...(ownerDiscordId === undefined ? {} : { ownerDiscordId }) },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      include: WITH_MEMBERS,
    });
    return rows.map(toRow);
  },

  async findDefault(guildId: string, ownerDiscordId: string, activity: LFGActivity): Promise<PermGroupRow | null> {
    const row = await prisma.permGroup.findFirst({
      where: { guildId, ownerDiscordId, activity, isDefault: true, status: "ACTIVE" },
      include: WITH_MEMBERS,
    });
    return row === null ? null : toRow(row);
  },

  async addMember(permGroupId: string, member: NewPermMemberRow): Promise<PermGroupRow | null> {
    await prisma.permMember.create({
      data: {
        permGroupId,
        ign: member.ign,
        role: member.role,
        slot: member.slot,
        discordId: member.discordId ?? null,
        uuid: member.uuid ?? null,
      },
    });
    return load(permGroupId);
  },

  async removeMember(permGroupId: string, ign: string, role: string): Promise<PermGroupRow | null> {
    await prisma.permMember.deleteMany({ where: { permGroupId, ign, role } });
    return load(permGroupId);
  },

  async setStatus(permGroupId: string, status: PermStatus): Promise<PermGroupRow | null> {
    // Disbanding also drops the default flag: an autofill source that no longer
    // exists would silently produce empty LFG posts.
    await prisma.permGroup.update({
      where: { id: permGroupId },
      data: { status, ...(status === "DISBANDED" ? { isDefault: false } : {}) },
    });
    return load(permGroupId);
  },

  /**
   * Both writes in one transaction. The partial unique index in the migration
   * rejects a second default outright, so clearing the old one and setting the
   * new one have to be atomic or the pair can fail halfway and leave the owner
   * with no default at all.
   */
  async setDefault(permGroupId: string): Promise<PermGroupRow | null> {
    const target = await prisma.permGroup.findUnique({
      where: { id: permGroupId },
      select: { guildId: true, ownerDiscordId: true, activity: true },
    });
    if (target === null) return null;

    await prisma.$transaction([
      prisma.permGroup.updateMany({
        where: { ...target, isDefault: true, NOT: { id: permGroupId } },
        data: { isDefault: false },
      }),
      prisma.permGroup.update({ where: { id: permGroupId }, data: { isDefault: true } }),
    ]);
    return load(permGroupId);
  },
};

/**
 * Roster enrichment off the Phase 2 member cache.
 *
 * Both reads are deliberately cache-only — no Hypixel call. `/perm info` on a
 * five-person roster would otherwise be five live API calls for a command
 * people run casually, which is exactly what the cache exists to prevent.
 */
export const guildMemberDirectory: GuildMemberDirectory = {
  async find(guildId: string, ign: string): Promise<CachedGuildMember | null> {
    const row = await prisma.guildMemberCache.findFirst({
      where: { guildId, ign: { equals: ign, mode: "insensitive" } },
      select: { uuid: true, ign: true },
    });
    return row === null || row.ign === null ? null : { uuid: row.uuid, ign: row.ign };
  },

  async currentIgns(guildId: string): Promise<ReadonlySet<string>> {
    const rows = await prisma.guildMemberCache.findMany({
      where: { guildId, ign: { not: null } },
      select: { ign: true },
    });
    return new Set(rows.map((r) => (r.ign ?? "").toLowerCase()).filter((i) => i !== ""));
  },
};

/**
 * The current reading per uuid.
 *
 * `ProfileCurrent` holds one row per profile, so the `distinct` picks between a
 * member's profiles — newest played wins — rather than walking a series. One
 * query for the whole roster rather than one per member.
 */
export const memberProgressSource: MemberProgressSource = {
  async forUuids(uuids: readonly string[]): Promise<Readonly<Record<string, MemberProgress>>> {
    if (uuids.length === 0) return {};
    const rows = await prisma.profileCurrent.findMany({
      where: { minecraftAccount: { uuid: { in: [...uuids] } } },
      orderBy: [{ minecraftAccountId: "asc" }, { capturedAt: "desc" }],
      distinct: ["minecraftAccountId"],
      select: {
        catacombsLevel: true,
        skillAverage: true,
        // The per-class dungeon levels ride in the JSON blob rather than in
        // columns (see `snapshot-metrics.ts`), so the roster reads the blob.
        metrics: true,
        minecraftAccount: { select: { uuid: true } },
      },
    });

    const out: Record<string, MemberProgress> = {};
    for (const row of rows) {
      const classLevels = readClassLevels(row.metrics);
      out[row.minecraftAccount.uuid] = {
        catacombsLevel: row.catacombsLevel,
        skillAverage: row.skillAverage,
        ...(classLevels === null ? {} : { classLevels }),
      };
    }
    return out;
  },
};

/**
 * The five dungeon class levels out of a `metrics` blob, keyed by role name.
 *
 * Re-keyed here rather than passed through as `classHealer` because the roster
 * looks a seat up by the role it already holds. Which roles are classes, and
 * which metric holds each one, is `@sbr/perms`'s table rather than a second copy
 * here — a class renamed there must not leave this reading the old key. Null
 * when the blob holds none of them, which is the ordinary case for an account
 * read before the widened metric catalog existed.
 *
 * A non-finite reading is dropped rather than passed on: `metrics` is JSON we
 * wrote but did not type, and a NaN reaching a card prints as "NaN" next to a
 * member's name.
 */
function readClassLevels(metrics: unknown): Record<string, number> | null {
  if (typeof metrics !== "object" || metrics === null) return null;
  const blob = metrics as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const role of classRolesFor("DUNGEONS")) {
    const metric = classMetricFor("DUNGEONS", role);
    const value = metric === null ? undefined : blob[metric];
    if (typeof value === "number" && Number.isFinite(value)) out[role] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** IGN → linked Discord id. Only verified links count as an identity. */
export const linkDirectory: LinkDirectory = {
  async discordIdForIgn(ign: string): Promise<string | null> {
    const row = await prisma.linkedAccount.findFirst({
      where: {
        status: "VERIFIED",
        minecraftAccount: { currentIgn: { equals: ign, mode: "insensitive" } },
      },
      orderBy: [{ isPrimary: "desc" }, { verifiedAt: "desc" }],
      select: { discordUserId: true },
    });
    return row?.discordUserId ?? null;
  },
};
