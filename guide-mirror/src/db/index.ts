/**
 * The only module that touches Prisma, and — more to the point — the only
 * module in this repository that writes anything down.
 *
 * There are three tables and the schema beside this file is the whole of it: a
 * Discord-to-Minecraft link, a remembered profile preference, and a stamp
 * recording which build of the curated content is loaded. Not one of them holds
 * a value that came out of the Hypixel API, and not one of them is keyed by a
 * time of observation. Advice is computed from a profile read and thrown away
 * with the response (COMPLIANCE.md §1).
 *
 * If a future feature seems to need a fourth table, read §1 before adding it.
 * "Store what we saw so we can compare later" is precisely the shape this
 * project promised not to have, and it does not become acceptable by being
 * small.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as typeof globalThis & {
  __guidePrisma?: PrismaClient;
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

/** Shared client. Reused across reloads outside production to avoid pool exhaustion. */
export const prisma: PrismaClient = globalForPrisma.__guidePrisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__guidePrisma = prisma;
}

export async function connectDb(): Promise<PrismaClient> {
  await prisma.$connect();
  return prisma;
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Everything that can go wrong between "DATABASE_URL is set" and "this is our
 * database", as a single actionable failure.
 *
 * The three cases need different fixes and otherwise present identically — as a
 * retry loop that never succeeds. `wrong-server` in particular is what a bare
 * `postgres:postgres@localhost:5432` gets when the compose stack is down and
 * some *other* Postgres on the box has taken the port.
 */
export type DbReadyFailure = "unreachable" | "wrong-server" | "unmigrated";

export class DatabaseNotReadyError extends Error {
  constructor(
    readonly kind: DbReadyFailure,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DatabaseNotReadyError";
  }
}

/** Redact the password before a connection string reaches a log line. */
function safeUrl(raw: string | undefined): string {
  if (!raw) return "(DATABASE_URL unset)";
  try {
    const url = new URL(raw);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/**
 * Verify at boot that DATABASE_URL points at our database, and fail loudly if
 * it does not.
 *
 * Prisma connects lazily, so without this the process starts clean and only
 * reveals the problem later, as a drip of failures from whichever query happens
 * to run first. Checking once, up front, turns that into one refusal that names
 * the cause.
 */
export async function assertDatabaseReady(): Promise<void> {
  const target = safeUrl(process.env.DATABASE_URL);

  let migrations: { count: bigint }[];
  try {
    migrations = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
      FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = '_prisma_migrations'
    `;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    // P1000/P1003/P1010: something answered, but it is not a database we own —
    // wrong credentials, missing database, or access denied. The Prisma codes
    // are the primary signal; the text match is a fallback, because the driver
    // adapter reports some of these through a query error where the code is not
    // populated.
    const rejected =
      code === "P1000" ||
      code === "P1003" ||
      code === "P1010" ||
      /credentials for .* are not valid|does not exist on the database server|Authentication failed|`(28P01|28000|3D000)`/i.test(
        message,
      );
    if (rejected) {
      throw new DatabaseNotReadyError(
        "wrong-server",
        `A Postgres is answering at ${target} but rejected us (${typeof code === "string" ? code : "authentication failed"}). ` +
          "This is usually a different Postgres that has taken the port while the " +
          "compose stack was down — check `docker compose ps` and that DATABASE_URL " +
          "points at the instance for this bot.",
        error,
      );
    }
    throw new DatabaseNotReadyError(
      "unreachable",
      `Cannot reach the database at ${target}. Start it with \`docker compose up -d\`.`,
      error,
    );
  }

  if ((migrations[0]?.count ?? 0n) === 0n) {
    throw new DatabaseNotReadyError(
      "unmigrated",
      `Connected to ${target}, but it has no \`_prisma_migrations\` table — this is ` +
        "either an empty database or another project Postgres. Run `npm run db:migrate` " +
        "if it is ours; otherwise fix DATABASE_URL.",
    );
  }
}

export interface DbPingResult {
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly detail?: string;
}

/** Lightweight liveness probe for the health registry. */
export async function pingDb(): Promise<DbPingResult> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }
}
