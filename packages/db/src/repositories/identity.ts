/**
 * Prisma-backed IdentityRepository. Satisfies the @sbr/shared-types port so the
 * IdentityService can consume it without importing Prisma (ARCHITECTURE.md: only
 * @sbr/db touches Prisma).
 */
import type {
  BridgeCapability,
  IdentityRepository,
  LinkedIdentityDTO,
} from "@sbr/shared-types";
import { prisma } from "../client.js";

type LinkWithAccount = {
  status: string;
  isPrimary: boolean;
  verifiedAt: Date | null;
  minecraftAccount: { uuid: string; currentIgn: string | null };
};

function toDto(discordId: string, link: LinkWithAccount): LinkedIdentityDTO {
  return {
    discordId,
    minecraftUuid: link.minecraftAccount.uuid,
    ign: link.minecraftAccount.currentIgn ?? "",
    status: link.status as LinkedIdentityDTO["status"],
    primary: link.isPrimary,
    verifiedAt: link.verifiedAt ? link.verifiedAt.toISOString() : null,
  };
}

export const identityRepository: IdentityRepository = {
  async findPrimaryLinkByDiscordId(discordId) {
    const user = await prisma.discordUser.findUnique({
      where: { discordId },
      include: {
        linkedAccounts: {
          where: { status: "VERIFIED" },
          orderBy: { isPrimary: "desc" },
          take: 1,
          include: { minecraftAccount: true },
        },
      },
    });
    const link = user?.linkedAccounts[0];
    return link ? toDto(discordId, link) : null;
  },

  async findMinecraftOwnerDiscordId(uuid) {
    const link = await prisma.linkedAccount.findFirst({
      where: { status: "VERIFIED", minecraftAccount: { uuid } },
      include: { discordUser: true },
    });
    return link?.discordUser.discordId ?? null;
  },

  async findDiscordIdByIgn(ign) {
    const link = await prisma.linkedAccount.findFirst({
      // Hypixel names are case-preserving but case-insensitive, and guild chat
      // reports whatever casing the player registered — matching exactly would
      // leave people unlinked for a capital letter.
      where: { status: "VERIFIED", minecraftAccount: { currentIgn: { equals: ign, mode: "insensitive" } } },
      include: { discordUser: true },
    });
    return link?.discordUser.discordId ?? null;
  },

  async createVerifiedLink(input) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.discordUser.upsert({
        where: { discordId: input.discordId },
        create: { discordId: input.discordId },
        update: {},
      });
      const mc = await tx.minecraftAccount.upsert({
        where: { uuid: input.uuid },
        create: { uuid: input.uuid, currentIgn: input.ign },
        update: { currentIgn: input.ign },
      });

      // This becomes the user's primary link; demote any previous primaries.
      await tx.linkedAccount.updateMany({
        where: { discordUserId: user.id, isPrimary: true },
        data: { isPrimary: false },
      });

      const link = await tx.linkedAccount.upsert({
        where: {
          discordUserId_minecraftAccountId: {
            discordUserId: user.id,
            minecraftAccountId: mc.id,
          },
        },
        create: {
          discordUserId: user.id,
          minecraftAccountId: mc.id,
          status: "VERIFIED",
          verificationMethod: "HYPIXEL_SOCIAL",
          isPrimary: true,
          verifiedAt: new Date(),
        },
        update: {
          status: "VERIFIED",
          verificationMethod: "HYPIXEL_SOCIAL",
          isPrimary: true,
          verifiedAt: new Date(),
        },
        include: { minecraftAccount: true },
      });

      return toDto(input.discordId, link);
    });
  },

  async unlink(discordId, uuid) {
    const result = await prisma.linkedAccount.updateMany({
      where: {
        status: { not: "UNLINKED" },
        discordUser: { discordId },
        minecraftAccount: { uuid },
      },
      data: { status: "UNLINKED", isPrimary: false },
    });
    return result.count > 0;
  },

  async getCapabilityGrants(guildId, discordId) {
    // guildId is the internal Guild.id (composition resolves the Discord snowflake).
    //
    // Only DISCORD_USER rows are read here. DISCORD_ROLE and GUILD_RANK subjects
    // need the caller's Discord roles or in-game rank, neither of which reaches
    // this layer — until the panel can write those rows there is nothing to
    // resolve, and the service's role floors cover the cases that matter.
    const perms = await prisma.bridgePermission.findMany({
      where: {
        guildId,
        subjectType: "DISCORD_USER",
        subjectId: discordId,
      },
      select: { capability: true, allow: true },
    });
    return perms.map((p) => ({ capability: p.capability as BridgeCapability, allow: p.allow }));
  },
};
