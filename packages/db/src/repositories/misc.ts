/**
 * Small Prisma-backed adapters: role resolution, guild id resolution, and the
 * worker job-log sink. Satisfy the RoleResolver / RankResolver (moderation,
 * commands-admin, panel-core) and JobLogSink (jobs) ports.
 */
import {
  ROLE_POLICY_SETTING_KEY,
  capabilityFloor,
  commandFloor,
  parseRoleBindings,
  parseRolePolicy,
  resolveMemberRole,
  type RolePolicy,
} from "@sbr/guild-config";
import type { BridgeCapability, MemberRole } from "@sbr/shared-types";
import { prisma } from "../client.js";

/**
 * `getRole(internalGuildId, discordId)` → the level this person holds, or
 * **null when they are not a member of this guild**.
 *
 * The null is the point. This used to end `?? "MEMBER"`, which answered the
 * question "what is this stranger's role" with "the same as everyone who
 * actually joined" — so every capability whose floor is MEMBER was open to
 * anybody who could reach a message handler. Callers now have to say what a
 * non-member gets, and every one of them says "nothing".
 *
 * The level itself is *derived* rather than read: the stored `role`, the Discord
 * roles the member holds, and their in-game guild rank are combined by
 * `resolveMemberRole`, with `roleOverride` able to demote. All four facts are on
 * rows this query already touches, so the derivation costs no extra round trip
 * beyond the guild's policy — which is a small, cached settings read.
 */
export const rankResolver = {
  async getRole(guildId: string, discordId: string): Promise<MemberRole | null> {
    const [member, config, policyRaw] = await Promise.all([
      prisma.guildMember.findFirst({
        where: { guildId, discordUser: { discordId } },
        select: { role: true, roleOverride: true, roleIds: true, guildRank: true },
      }),
      prisma.guildConfig.findUnique({ where: { guildId }, select: { roleMappings: true } }),
      prisma.guildSetting.findUnique({
        where: { guildId_key: { guildId, key: ROLE_POLICY_SETTING_KEY } },
        select: { value: true },
      }),
    ]);

    return resolveMemberRole(
      {
        present: member !== null,
        assigned: (member?.role as MemberRole | undefined) ?? null,
        override: (member?.roleOverride as MemberRole | null | undefined) ?? null,
        discordRoleIds: member?.roleIds ?? [],
        guildRank: member?.guildRank ?? null,
      },
      parseRoleBindings(config?.roleMappings),
      parseRolePolicy(policyRaw?.value),
    );
  },
};

/**
 * The guild's configured floors, for the two dispatchers and the identity
 * service. Satisfies `CapabilityFloorReader` (@sbr/identity) and
 * `CommandFloorReader` (@sbr/commands-admin).
 *
 * Both methods take the unconfigured answer as their own fallback, so a guild
 * that has never opened the Permissions card behaves exactly as it did before
 * the card existed.
 */
export const rolePolicyReader = {
  async read(guildId: string): Promise<RolePolicy> {
    const row = await prisma.guildSetting.findUnique({
      where: { guildId_key: { guildId, key: ROLE_POLICY_SETTING_KEY } },
      select: { value: true },
    });
    return parseRolePolicy(row?.value);
  },

  async capabilityFloor(guildId: string, capability: BridgeCapability): Promise<MemberRole> {
    return capabilityFloor(await this.read(guildId), capability);
  },

  async commandFloor(guildId: string, command: string, fallback: MemberRole): Promise<MemberRole> {
    return commandFloor(await this.read(guildId), command, fallback);
  },
};

/** Resolve a Discord guild snowflake to the internal Guild.id. */
export const guildRepository = {
  async resolveInternalId(discordGuildId: string): Promise<string | null> {
    const guild = await prisma.guild.findUnique({ where: { discordGuildId }, select: { id: true } });
    return guild?.id ?? null;
  },

  /**
   * The reverse: internal Guild.id → Discord snowflake. Discord-side effects
   * (`/kick`, `/purge`, `/lockdown`) receive the internal id from the command
   * layer and need the snowflake to talk to the gateway.
   */
  async resolveDiscordId(guildId: string): Promise<string | null> {
    const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { discordGuildId: true } });
    return guild?.discordGuildId ?? null;
  },

  /**
   * Every active guild — the iteration set for guild-scoped worker jobs.
   *
   * `hypixelGuildId` comes back nullable because a Discord server can be onboarded
   * before its Hypixel guild is known; jobs that need it skip those rows rather
   * than guessing.
   */
  async listActive(): Promise<
    readonly { id: string; discordGuildId: string; hypixelGuildId: string | null; name: string }[]
  > {
    return prisma.guild.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, discordGuildId: true, hypixelGuildId: true, name: true },
      orderBy: { createdAt: "asc" },
    });
  },
};

export interface WorkerJobLogEntry {
  queue: string;
  type: string;
  status: string;
  attempts: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: string;
}

/** JobLogSink — persists a WorkerJobLog row on job completion/failure. */
export const workerJobLogSink = {
  async record(entry: WorkerJobLogEntry): Promise<void> {
    await prisma.workerJobLog.create({
      data: {
        queue: entry.queue,
        type: entry.type,
        status: entry.status as "COMPLETED" | "FAILED",
        attempts: entry.attempts,
        startedAt: new Date(entry.startedAt),
        finishedAt: new Date(entry.finishedAt),
        durationMs: entry.durationMs,
        error: entry.error ?? null,
      },
    });
  },
};
