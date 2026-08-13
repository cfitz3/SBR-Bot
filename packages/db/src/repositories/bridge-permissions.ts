/**
 * `BridgePermission` — the per-subject exceptions to the guild's capability
 * floors.
 *
 * The floors in `roles.policy` answer "what may an Officer do"; these rows
 * answer "except this person" and "also anyone with this Discord role". Both
 * exist because guilds need both: a level is the rule, and every guild has two
 * or three people the rule is wrong about.
 *
 * Resolution order is the identity service's, not this file's: deny beats
 * grant, grant beats the floor. So a deny row is the strongest statement anyone
 * can make about a capability, which is why the panel labels it that way.
 */
import type { BridgeCapability } from "@sbr/shared-types";
import { normalizeRank } from "@sbr/guild-config";
import { prisma } from "../client.js";

export type PermSubjectKind = "DISCORD_ROLE" | "DISCORD_USER" | "GUILD_RANK";

export interface BridgePermissionRow {
  readonly id: string;
  readonly subjectType: PermSubjectKind;
  readonly subjectId: string;
  readonly capability: BridgeCapability;
  readonly allow: boolean;
  readonly createdAt: string;
}

/**
 * Rank subjects are stored normalised, everything else verbatim.
 *
 * Discord ids are exact by construction; a Hypixel rank is guild-authored free
 * text that staff re-case ("Elite" → "elite"), and a row that only matched one
 * casing would silently stop applying the day somebody edited the rank name.
 */
function storedSubjectId(subjectType: PermSubjectKind, subjectId: string): string {
  return subjectType === "GUILD_RANK" ? normalizeRank(subjectId) : subjectId.trim();
}

export const bridgePermissionRepository = {
  /** Every exception this guild has written, newest first. */
  async list(guildId: string): Promise<readonly BridgePermissionRow[]> {
    const rows = await prisma.bridgePermission.findMany({
      where: { guildId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        capability: true,
        allow: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      subjectType: row.subjectType as PermSubjectKind,
      subjectId: row.subjectId,
      capability: row.capability as BridgeCapability,
      allow: row.allow,
      createdAt: row.createdAt.toISOString(),
    }));
  },

  /**
   * Write one exception, replacing whatever this subject already had for this
   * capability. An upsert rather than an insert because "allow" and "deny" are
   * two values of one setting — two rows saying opposite things about the same
   * pair is a state the resolver would have to break a tie in, and the unique
   * index exists precisely so it never has to.
   */
  async set(
    guildId: string,
    subjectType: PermSubjectKind,
    subjectId: string,
    capability: BridgeCapability,
    allow: boolean,
  ): Promise<void> {
    const id = storedSubjectId(subjectType, subjectId);
    await prisma.bridgePermission.upsert({
      where: { guildId_subjectType_subjectId_capability: { guildId, subjectType, subjectId: id, capability } },
      create: { guildId, subjectType, subjectId: id, capability, allow },
      update: { allow },
    });
  },

  /**
   * Delete one exception, returning whether there was one.
   *
   * Deleting is not the same as writing `allow: false` and the panel keeps them
   * apart: removing a row restores the level's floor, while a deny row overrides
   * it forever. Conflating them is how somebody ends up permanently muted by a
   * cleanup.
   */
  async remove(guildId: string, id: string): Promise<boolean> {
    const result = await prisma.bridgePermission.deleteMany({ where: { guildId, id } });
    return result.count > 0;
  },
};
