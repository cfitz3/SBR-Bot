import { prisma } from "./client.js";

/**
 * Everything that can go wrong between "DATABASE_URL is set" and "this is our
 * database", as a single actionable failure.
 *
 * The distinction matters because the three cases need different fixes and all
 * three otherwise present identically: a retry loop that never succeeds. In
 * particular `wrong-server` — a Postgres that is up and reachable on the
 * configured host:port but rejects our credentials or has none of our tables —
 * is what a bare `postgres:postgres@localhost:5432` gets when the compose stack
 * is down and some *other* Postgres on the box has taken the port.
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
 * Verify at boot that DATABASE_URL points at *our* database, and fail loudly if
 * it does not.
 *
 * Prisma connects lazily, so without this an app starts clean and only reveals
 * the problem later as an endless drip of failures from whichever query happens
 * to run first — in production that was the safety sweep's `workerJobLog.create`
 * retrying against a stranger's Postgres once a minute, forever. Checking once,
 * up front, converts that into one refusal that names the cause.
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
    // wrong credentials, missing database, or access denied. Prisma's codes are
    // the primary signal; the text match is a fallback, because the driver
    // adapter reports some of these through a query error rather than a
    // connection error and the code is not always populated.
    const rejected =
      code === "P1000" ||
      code === "P1003" ||
      code === "P1010" ||
      // Prisma model calls report these as P1000/P1003; `$queryRaw` wraps the
      // same failures as P2010 with the SQLSTATE in the text, so match both.
      /credentials for .* are not valid|does not exist on the database server|Authentication failed|`(28P01|28000|3D000)`/i.test(
        message,
      );
    if (rejected) {
      throw new DatabaseNotReadyError(
        "wrong-server",
        `A Postgres is answering at ${target} but rejected us (${typeof code === "string" ? code : "authentication failed"}). ` +
          "This is usually a different Postgres that has taken the port while the " +
          "compose stack was down — check `docker compose ps` and that DATABASE_URL " +
          "points at the SBR instance.",
        error,
      );
    }
    throw new DatabaseNotReadyError(
      "unreachable",
      `Cannot reach the database at ${target}. Start it with \`npm run infra:up\`.`,
      error,
    );
  }

  if ((migrations[0]?.count ?? 0n) === 0n) {
    throw new DatabaseNotReadyError(
      "unmigrated",
      `Connected to ${target}, but it has no \`_prisma_migrations\` table — this is ` +
        "either an empty database or another project's Postgres. Run `npm run db:migrate` " +
        "if it is ours; otherwise fix DATABASE_URL.",
    );
  }
}

export interface DbPingResult {
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly detail?: string;
}

/** Lightweight liveness probe used by the observability health registry. */
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
