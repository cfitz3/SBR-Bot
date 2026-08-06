/**
 * Prisma client singleton for the platform. `@sbr/db` is the ONLY package that
 * touches Prisma directly (ARCHITECTURE.md); everything else calls repositories
 * or services built on top of this.
 *
 * Uses the pg driver adapter (Prisma 7 model). DATABASE_URL is read directly
 * here (not via @sbr/config) so the Prisma CLI and migrations don't require the
 * full app config (e.g. REDIS_URL) to be present.
 */
import { loadRootEnv } from "@sbr/env";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Centralised environment. Uses @sbr/env (not @sbr/config) so the Prisma CLI and
// standalone scripts don't require the full app env (e.g. REDIS_URL).
loadRootEnv();

const globalForPrisma = globalThis as typeof globalThis & {
  __sbrPrisma?: PrismaClient;
};

function createPrisma(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — cannot initialize the database client.");
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

/** Shared client. Reused across hot-reloads in non-production to avoid pool exhaustion. */
export const prisma: PrismaClient = globalForPrisma.__sbrPrisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__sbrPrisma = prisma;
}

export async function connectDb(): Promise<PrismaClient> {
  await prisma.$connect();
  return prisma;
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
