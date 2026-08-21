/**
 * `REDIS_URL` → the connection object BullMQ wants.
 *
 * Every other process in the fleet hands the whole URL to node-redis, which
 * understands it. BullMQ does not take a URL, so this is the one place the URL
 * is taken apart — and taking it apart is exactly where the parts get dropped.
 * A managed Redis is reached at `rediss://default:<password>@host:6380`, and a
 * translation that kept only the host and the port would connect in plaintext,
 * unauthenticated, to a server that will refuse it: the workers would be the one
 * service that cannot reach a Redis the rest of the fleet is happily using.
 */
export interface BullConnection {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly db?: number;
  readonly tls?: Record<string, never>;
}

export function redisConnection(url: string): BullConnection {
  const u = new URL(url);
  const connection: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    db?: number;
    tls?: Record<string, never>;
  } = {
    host: u.hostname,
    // `rediss:` is the TLS scheme and carries its own default port.
    port: Number(u.port) || (u.protocol === "rediss:" ? 6380 : 6379),
  };

  // Both halves are percent-decoded by URL, which is what they need to be: a
  // password with a `@` or a `/` in it is only expressible encoded.
  if (u.username !== "") connection.username = decodeURIComponent(u.username);
  if (u.password !== "") connection.password = decodeURIComponent(u.password);

  // `redis://host:6379/2` selects database 2. An empty or unparseable path is
  // database 0, which is also what leaving it off means.
  const dbPath = u.pathname.replace(/^\//, "");
  if (dbPath !== "") {
    const db = Number(dbPath);
    if (Number.isInteger(db) && db >= 0) connection.db = db;
  }

  // ioredis (BullMQ's client) turns TLS on by the presence of the option, not
  // by its contents, so an empty object is the whole instruction.
  if (u.protocol === "rediss:") connection.tls = {};

  return connection;
}
