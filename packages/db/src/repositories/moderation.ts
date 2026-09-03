/**
 * Prisma-backed ModerationRepository (satisfies the @sbr/moderation port).
 * `guildId` here is the internal Guild.id (cuid); the composition layer resolves
 * a Discord guild id to it via guildRepository.
 */
import { Prisma } from "@prisma/client";
import type {
  AuditQuery,
  EnforcementAttemptDTO,
  EnforcementStatus,
  InfractionDTO,
  ModActionType,
  ModerationActionDTO,
  ModerationSurface,
} from "@sbr/shared-types";
import {
  CASE_PREFIX,
  caseUuidFragment,
  formatCaseCode,
  looksLikeCaseCode,
  sanitizeCaseName,
} from "@sbr/shared-types";
import { prisma } from "../client.js";

/**
 * An ISO bound, or nothing.
 *
 * A date staff typed by hand is the input here, so an unreadable one has to
 * mean "no bound" rather than an `Invalid Date` — Prisma would take that and
 * return nothing at all, which reads as an empty log rather than a typo.
 */
function parseBound(value: string | null | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Every `/audit` filter as one Prisma `where`.
 *
 * Extracted from `listActions` so it can be tested without a database, which
 * is where the interesting part lives: three separate sources can all want to
 * constrain `createdAt` — `sinceDays`, an explicit `since`, and `until` —
 * and Prisma takes exactly one object per column. Assigning them one after the
 * other, which is the obvious way to write this, silently drops whichever was
 * written first and returns a result set that looks like an answer.
 *
 * `now` is a parameter for the same reason: a relative lower bound and the
 * "still in force" cutoff are both readings of the clock, and a test that
 * cannot fix the clock can only assert that something was set.
 */
export function auditWhere(query: AuditQuery, now: Date): Record<string, unknown> {
  const where: Record<string, unknown> = { guildId: query.guildId };
  if (query.actorDiscordId) where.actorDiscordId = query.actorDiscordId;
  if (query.targetDiscordId) where.targetDiscordId = query.targetDiscordId;
  if (query.type) where.type = query.type;

  const lower: Date[] = [];
  if (query.sinceDays && query.sinceDays > 0) {
    lower.push(new Date(now.getTime() - query.sinceDays * 24 * 60 * 60 * 1000));
  }
  const explicitSince = parseBound(query.since);
  if (explicitSince) lower.push(explicitSince);
  const until = parseBound(query.until);
  // Two lower bounds mean the caller wants the tighter one — somebody who asks
  // for "the last 7 days" and "since the 1st" is narrowing, not widening. An
  // unparseable date contributes nothing rather than an epoch.
  const gte = lower.length > 0 ? new Date(Math.max(...lower.map((d) => d.getTime()))) : null;
  if (gte !== null || until !== null) {
    where.createdAt = { ...(gte ? { gte } : {}), ...(until ? { lte: until } : {}) };
  }

  const term = query.term?.trim();
  if (term) {
    // Three ways staff arrive at a case, in one box. A case id is matched on
    // the id column exactly rather than fuzzily, because a term that is
    // obviously an id should not also drag in every case whose reason happens
    // to contain the target's name. Everything else is matched against the
    // name and uuid the id carries, which is why searching a username works
    // even for a member who has since been renamed.
    where.OR = looksLikeCaseCode(term)
      ? [{ caseCode: { equals: term, mode: "insensitive" } }, { id: term }]
      : [
          { caseCode: { contains: term, mode: "insensitive" } },
          { id: term },
          { targetDiscordId: term },
          { reason: { contains: term, mode: "insensitive" } },
        ];
  }

  if (query.inForceOnly) {
    // Time-filtered here rather than after the fact: `take` would otherwise
    // spend its budget on rows that are about to be dropped, and a page of
    // "still in force" could come back half empty.
    where.active = true;
    where.type = query.type ?? { in: ["MUTE", "BAN"] };
    // `AND` rather than a second `OR`: Prisma takes one `OR` per object, and a
    // free-text search combined with "still in force" means both, not either.
    const stillInForce = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
    if (where.OR === undefined) Object.assign(where, stillInForce);
    else where.AND = [stillInForce];
  }
  return where;
}

interface NewActionRecord {
  guildId: string;
  infractionId: string | null;
  type: ModActionType;
  actorDiscordId: string;
  targetDiscordId: string | null;
  targetMinecraftUuid: string | null;
  reason: string;
  durationSeconds: number | null;
  expiresAt: string | null;
  surfaces: readonly ModerationSurface[];
  active: boolean;
  /** Defaults to DISCORD; only the bridge writes INGAME. Mirrors `@sbr/moderation`'s port. */
  sourceContext?: "BRIDGE" | "DISCORD" | "INGAME";
}

type InfractionRow = {
  id: string;
  guildId: string;
  targetDiscordId: string | null;
  type: string;
  severity: string;
  reason: string;
  createdAt: Date;
};

/** Mirrors `ModerationActionPatch` in @sbr/moderation, like `NewActionRecord`. */
interface ModerationActionPatch {
  reason?: string;
  durationSeconds?: number | null;
  expiresAt?: string | null;
  active?: boolean;
  enforcement?: EnforcementStatus;
  enforcementDetail?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
  editedByDiscordId: string;
}

type ActionRow = {
  id: string;
  caseCode: string | null;
  guildId: string;
  type: string;
  actorDiscordId: string;
  targetDiscordId: string | null;
  reason: string;
  durationSeconds: number | null;
  expiresAt: Date | null;
  surfaces: string[];
  active: boolean;
  enforcement: string;
  enforcementDetail: string | null;
  enforcementAttempts: number;
  enforcementAt: Date | null;
  createdAt: Date;
  updatedAt: Date | null;
  editedByDiscordId: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
};

function mapInfraction(r: InfractionRow): InfractionDTO {
  return {
    id: r.id,
    guildId: r.guildId,
    targetDiscordId: r.targetDiscordId,
    type: r.type as InfractionDTO["type"],
    severity: r.severity as InfractionDTO["severity"],
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapAction(r: ActionRow): ModerationActionDTO {
  return {
    id: r.id,
    // Historical rows have no code; the id is what they were always called.
    caseCode: r.caseCode ?? r.id,
    guildId: r.guildId,
    type: r.type as ModerationActionDTO["type"],
    actorDiscordId: r.actorDiscordId,
    targetDiscordId: r.targetDiscordId,
    reason: r.reason,
    durationSeconds: r.durationSeconds,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    surfaces: r.surfaces as ModerationSurface[],
    active: r.active,
    enforcement: r.enforcement as EnforcementStatus,
    enforcementDetail: r.enforcementDetail,
    enforcementAttempts: r.enforcementAttempts,
    enforcementAt: r.enforcementAt === null ? null : r.enforcementAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt === null ? null : r.updatedAt.toISOString(),
    editedByDiscordId: r.editedByDiscordId,
    voidedAt: r.voidedAt === null ? null : r.voidedAt.toISOString(),
    voidReason: r.voidReason,
  };
}

/** How many times case-code allocation retries a collision before giving up. */
const CASE_ATTEMPTS = 5;

/**
 * Who a case is about, as the id spells it.
 *
 * The verified Minecraft link is preferred because that is the name staff
 * recognise and the uuid is the half that survives a rename. A member who has
 * never linked still gets a readable id from their Discord username, with
 * their snowflake standing in for the uuid — just as stable, and just as much
 * theirs. Resolution is best-effort: a lookup that fails yields `unknown`,
 * because a punishment must not fail to be recorded over the spelling of its
 * own name.
 */
async function caseSubject(
  input: NewActionRecord,
): Promise<{ name: string | null; uuid: string | null }> {
  try {
    if (input.targetMinecraftUuid !== null) {
      const account = await prisma.minecraftAccount.findUnique({
        where: { uuid: input.targetMinecraftUuid },
        select: { currentIgn: true },
      });
      return { name: account?.currentIgn ?? null, uuid: input.targetMinecraftUuid };
    }
    if (input.targetDiscordId === null) return { name: null, uuid: null };
    const user = await prisma.discordUser.findUnique({
      where: { discordId: input.targetDiscordId },
      select: {
        username: true,
        linkedAccounts: {
          where: { status: "VERIFIED" },
          orderBy: [{ isPrimary: "desc" }, { verifiedAt: "desc" }],
          take: 1,
          select: { minecraftAccount: { select: { uuid: true, currentIgn: true } } },
        },
      },
    });
    const linked = user?.linkedAccounts[0]?.minecraftAccount;
    return {
      name: linked?.currentIgn ?? user?.username ?? null,
      uuid: linked?.uuid ?? input.targetDiscordId,
    };
  } catch {
    return { name: null, uuid: input.targetDiscordId };
  }
}

export const moderationRepository = {
  async createInfraction(input: Omit<InfractionDTO, "id" | "createdAt">): Promise<InfractionDTO> {
    const row = await prisma.infraction.create({
      data: {
        guildId: input.guildId,
        targetDiscordId: input.targetDiscordId,
        type: input.type,
        severity: input.severity,
        reason: input.reason,
      },
    });
    return mapInfraction(row);
  },

  async createAction(input: NewActionRecord): Promise<ModerationActionDTO> {
    const subject = await caseSubject(input);
    // The sequence is per subject rather than per guild, and the subject is
    // identified by the code's own name and uuid segments. Counting on the
    // prefix rather than on `targetDiscordId` is what keeps a punishment
    // issued against a bare uuid — no snowflake to group by — from sharing a
    // counter with every other one.
    const prefix = `${CASE_PREFIX}-${sanitizeCaseName(subject.name)}-${caseUuidFragment(subject.uuid)}-`;

    for (let attempt = 0; attempt < CASE_ATTEMPTS; attempt += 1) {
      const highest = await prisma.moderationAction.findFirst({
        where: { guildId: input.guildId, caseCode: { startsWith: prefix } },
        orderBy: { caseNumber: "desc" },
        select: { caseNumber: true },
      });
      const caseNumber = (highest?.caseNumber ?? 0) + 1;
      try {
        const row = await prisma.moderationAction.create({
          data: {
            caseNumber,
            caseCode: formatCaseCode({
              name: subject.name,
              uuid: subject.uuid,
              sequence: caseNumber,
            }),
            guildId: input.guildId,
            infractionId: input.infractionId,
            type: input.type,
            actorDiscordId: input.actorDiscordId,
            targetDiscordId: input.targetDiscordId,
            reason: input.reason,
            durationSeconds: input.durationSeconds,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            surfaces: [...input.surfaces],
            active: input.active,
            sourceContext: input.sourceContext ?? "DISCORD",
            // Born PENDING on purpose. The service stamps the verdict once
            // both surfaces have answered, so a process that dies
            // mid-enforcement leaves a row that says so rather than one that
            // looks finished.
            enforcement: "PENDING",
          },
        });
        return mapAction(row);
      } catch (error) {
        // Two staff punishing the same person in the same second compute the
        // same number; the loser takes the next one. Cheaper and less
        // deadlock-prone than serialising every punishment behind a lock, and
        // the same trade ticket numbers make.
        const collided =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
        if (!collided || attempt === CASE_ATTEMPTS - 1) throw error;
      }
    }
    // Unreachable: the loop either returns or rethrows on its final attempt.
    throw new Error("case code allocation exhausted");
  },

  async listInfractions(guildId: string, discordId: string): Promise<readonly InfractionDTO[]> {
    const rows = await prisma.infraction.findMany({
      where: { guildId, targetDiscordId: discordId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapInfraction);
  },

  async listRecentInfractions(guildId: string, limit: number): Promise<readonly InfractionDTO[]> {
    const rows = await prisma.infraction.findMany({
      where: { guildId },
      orderBy: { createdAt: "desc" },
      // Clamped here as well as at the caller: this is the one query on the
      // table with no target narrowing it, so an unbounded limit reaching it
      // would be a full scan of every infraction the guild has ever recorded.
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map(mapInfraction);
  },

  /**
   * `/audit`. Filters are additive and each is applied only when supplied, so
   * an officer opening the log with no arguments sees everything recent.
   */
  async listActions(query: AuditQuery): Promise<readonly ModerationActionDTO[]> {
    const where = auditWhere(query, new Date());
    const rows = await prisma.moderationAction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(query.limit ?? 100, 500),
    });
    return rows.map(mapAction);
  },

  /**
   * The expiry sweep. Only rows that hold enforcement are touched: a kick is
   * flagged active forever because nothing lifts one, and clearing that flag
   * would rewrite history to say somebody did.
   */
  async deactivateExpired(guildId: string | null, now: Date): Promise<number> {
    const result = await prisma.moderationAction.updateMany({
      where: {
        ...(guildId === null ? {} : { guildId }),
        active: true,
        type: { in: ["MUTE", "BAN"] },
        expiresAt: { not: null, lte: now },
      },
      data: { active: false },
    });
    return result.count;
  },

  /**
   * Stamp a verdict, and — when the verdict came from an attempt rather than
   * from a person — the attempt that produced it.
   *
   * `attempt` is optional for exactly that reason. A staffer setting the status
   * by hand has not tried anything, and counting their correction as an attempt
   * would spend one of the retries the sweep is allowed.
   */
  async setEnforcement(
    actionId: string,
    status: EnforcementStatus,
    detail: string | null,
    attempt?: number,
  ): Promise<void> {
    await prisma.moderationAction.update({
      where: { id: actionId },
      data: {
        enforcement: status,
        enforcementDetail: detail,
        ...(attempt === undefined ? {} : { enforcementAttempts: attempt, enforcementAt: new Date() }),
      },
    });
  },

  /**
   * Append what one surface said, verbatim.
   *
   * Best-effort by construction: the caller has already carried the punishment
   * out, and losing the note about it must not fail the punishment. Errors are
   * swallowed here rather than at every call site.
   */
  async recordEnforcementAttempt(input: {
    actionId: string;
    attempt: number;
    surface: string;
    outcome: string;
    detail: string | null;
  }): Promise<void> {
    await prisma.enforcementAttempt
      .create({
        data: {
          actionId: input.actionId,
          attempt: input.attempt,
          surface: input.surface,
          outcome: input.outcome,
          detail: input.detail,
        },
      })
      .catch(() => undefined);
  },

  /** The attempt log for one case, oldest first — it reads as a story. */
  async listEnforcementAttempts(
    actionId: string,
    limit = 20,
  ): Promise<readonly EnforcementAttemptDTO[]> {
    const rows = await prisma.enforcementAttempt.findMany({
      where: { actionId },
      orderBy: { createdAt: "asc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map((r) => ({
      attempt: r.attempt,
      surface: r.surface === "GAME" ? ("GAME" as const) : ("DISCORD" as const),
      outcome: r.outcome,
      detail: r.detail,
      createdAt: r.createdAt.toISOString(),
    }));
  },

  /**
   * Rows the expiry sweep has to *reverse* rather than merely un-flag.
   *
   * `deactivateExpired` clears the flag in one statement and returns a count,
   * which is right for bookkeeping and useless for lifting: a temp-banned member
   * whose row flipped to inactive is still banned on Discord. The sweep needs
   * the rows themselves to know who to unban, so it reads them first and clears
   * the flag per row as each reversal lands.
   */
  async listExpiredActive(
    guildId: string | null,
    now: Date,
    limit: number,
  ): Promise<readonly ModerationActionDTO[]> {
    const rows = await prisma.moderationAction.findMany({
      where: {
        ...(guildId === null ? {} : { guildId }),
        active: true,
        type: { in: ["MUTE", "BAN"] },
        expiresAt: { not: null, lte: now },
      },
      orderBy: { expiresAt: "asc" },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map(mapAction);
  },

  /**
   * Rows the guild never answered for. Ordered oldest first so a long backlog
   * is worked off in the order the punishments were issued rather than the
   * order they happen to be indexed.
   */
  async listStalePending(before: Date, limit: number): Promise<readonly ModerationActionDTO[]> {
    const rows = await prisma.moderationAction.findMany({
      // Staleness is measured from the last attempt, not from the moment the
      // staffer typed the command. Those were the same thing until enforcement
      // could be retried, and treating them as the same afterwards would judge
      // a command that was retried a minute ago against an hour-old case.
      where: {
        enforcement: "PENDING",
        OR: [{ enforcementAt: { lte: before } }, { enforcementAt: null, createdAt: { lte: before } }],
      },
      orderBy: { createdAt: "asc" },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map(mapAction);
  },

  /**
   * Correct a case in place.
   *
   * Scoped by `updateMany` on `{ guildId, id }` rather than `update` by primary
   * key, the same shape `bridgeRepository` uses: a case id pasted from another
   * guild must come back as "no such case", not as a cross-guild write by
   * somebody who happens to be an admin somewhere. `count === 0` is the only
   * signal Prisma gives for that, so it is the one this returns null on.
   */
  async updateAction(
    guildId: string,
    actionId: string,
    patch: ModerationActionPatch,
  ): Promise<ModerationActionDTO | null> {
    const data: Record<string, unknown> = {};
    if (patch.reason !== undefined) data.reason = patch.reason;
    if (patch.durationSeconds !== undefined) data.durationSeconds = patch.durationSeconds;
    if (patch.expiresAt !== undefined) {
      data.expiresAt = patch.expiresAt === null ? null : new Date(patch.expiresAt);
    }
    if (patch.active !== undefined) data.active = patch.active;
    if (patch.enforcement !== undefined) data.enforcement = patch.enforcement;
    if (patch.enforcementDetail !== undefined) data.enforcementDetail = patch.enforcementDetail;
    if (patch.voidedAt !== undefined) {
      data.voidedAt = patch.voidedAt === null ? null : new Date(patch.voidedAt);
    }
    if (patch.voidReason !== undefined) data.voidReason = patch.voidReason;
    data.updatedAt = new Date();
    data.editedByDiscordId = patch.editedByDiscordId;

    const result = await prisma.moderationAction.updateMany({ where: { id: actionId, guildId }, data });
    if (result.count === 0) return null;
    const row = await prisma.moderationAction.findFirst({ where: { id: actionId, guildId } });
    return row === null ? null : mapAction(row);
  },

  /**
   * One case, by whichever id staff quoted.
   *
   * Both are accepted because both are in circulation: every card printed
   * since the scheme landed shows `CASE-DrJay-a1b2c3d4-2`, and every card
   * printed before it shows a cuid. Asking staff to know which era a case is
   * from before they can look it up would be a worse id than the one we
   * replaced.
   */
  async findAction(guildId: string, actionId: string): Promise<ModerationActionDTO | null> {
    const row = await prisma.moderationAction.findFirst({
      where: {
        guildId,
        OR: [{ id: actionId }, { caseCode: { equals: actionId, mode: "insensitive" } }],
      },
    });
    return row === null ? null : mapAction(row);
  },
};
