/**
 * @sbr/db — Prisma schema, client, and (future) typed repositories.
 * The single choke point for database access across the platform.
 */
export { prisma, connectDb, disconnectDb } from "./client.js";
export { pingDb, type DbPingResult } from "./health.js";

// Typed repositories — the only sanctioned data-access surface for domain packages.
export { identityRepository } from "./repositories/identity.js";
export { moderationRepository } from "./repositories/moderation.js";
export { communityRepository } from "./repositories/community.js";
export { rankResolver, guildRepository, workerJobLogSink, type WorkerJobLogEntry } from "./repositories/misc.js";
export {
  wordlistRepository,
  guildConfigRepository,
  type WordlistEntryRow,
  type WordMatchType,
  type WordAction,
} from "./repositories/bridge.js";

// Re-export the generated Prisma types & enums so domain packages can consume
// them without depending on @prisma/client directly.
export { Prisma, PrismaClient } from "@prisma/client";
export type {
  DiscordUser,
  MinecraftAccount,
  LinkedAccount,
  Guild,
  GuildMember,
  GuildConfig,
  ProfileSnapshot,
  Milestone,
  Infraction,
  ModerationAction,
} from "@prisma/client";
