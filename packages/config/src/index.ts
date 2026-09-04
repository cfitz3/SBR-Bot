/**
 * @sbr/config — validated environment loader.
 *
 * Fail-fast: `loadConfig()` validates the environment once at boot and throws an
 * aggregated error listing every problem, so a misconfigured deploy dies loudly
 * instead of erroring deep in a request. Dependency-free by design for the
 * scaffold; swap the internal validators for zod later without changing callers.
 */
import { loadRootEnv } from "@sbr/env";

// Centralised environment: resolve + load the single root .env (see @sbr/env).
loadRootEnv();

export type NodeEnv = "development" | "test" | "production";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type WebScheme = "http" | "https";

const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error"];
const NODE_ENVS: readonly NodeEnv[] = ["development", "test", "production"];
const WEB_SCHEMES: readonly WebScheme[] = ["http", "https"];

/**
 * Which Hypixel API policy regime this install runs under.
 *
 * - `personal` — the guild-activity exception: one personal key, registered by
 *   the guild owner, non-production use, and at most one request per player per
 *   hour. This is what this deployment runs, and it is the default so that an
 *   install which never sets the variable is the *restrictive* one rather than
 *   the permissive one.
 * - `production` — a granted production-tier key. The enforcement points are
 *   wired for it so the switch is a config change rather than a rewrite, but
 *   nothing ships in this mode today.
 *
 * See docs/HYPIXEL_COMPLIANCE.md for the clause-by-clause mapping.
 */
export type HypixelKeyMode = "personal" | "production";

const HYPIXEL_KEY_MODES: readonly HypixelKeyMode[] = ["personal", "production"];

/**
 * The per-player request floor the guild-activity exception sets, in
 * milliseconds. Enforced in `@sbr/hypixel` against our own clock rather than
 * against upstream's headers — the point of a self-imposed cap is that it holds
 * even when Hypixel would have allowed the request.
 */
export const PERSONAL_PLAYER_WINDOW_MS = 60 * 60_000;

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly logLevel: LogLevel;
  readonly database: { readonly url: string };
  readonly redis: { readonly url: string; readonly keyPrefix: string };
  readonly discord: {
    readonly bridgeToken: string | undefined;
    readonly adminToken: string | undefined;
    /**
     * SBR-Guide's own token. A third application rather than a third set of
     * commands on an existing one: the advisor is the leg submitted for Hypixel
     * API review as a standalone bot, and a shared token would mean the reviewed
     * surface and the guild-tracking surface log in as the same thing.
     */
    readonly guideToken: string | undefined;
    readonly clientId: string | undefined;
  };
  readonly oauth: {
    readonly clientId: string | undefined;
    readonly clientSecret: string | undefined;
    readonly redirectUri: string | undefined;
    readonly sessionSecret: string | undefined;
  };
  /**
   * The admin bot's loopback control API — how the web panel reads a Discord
   * guild's channels, roles and members without holding a gateway connection of
   * its own, and how a panel ban actually reaches Discord.
   *
   * Optional throughout: with no token the bot doesn't listen and the panel falls
   * back to raw-ID entry, which is exactly the pre-picker behaviour rather than
   * an outage.
   */
  readonly internalApi: {
    readonly token: string | undefined;
    readonly port: number;
    /** Where the panel dials the bot. Loopback unless the two are split apart. */
    readonly baseUrl: string;
    /**
     * The *bridge* bot's half of the same idea, on its own port.
     *
     * Ticket channels live in the community server, where the bridge bot is the
     * client holding the gateway — so panel "Publish" and admin `/tickets close`
     * have to reach that process, not the admin one. Same token: both sockets
     * are loopback, in the same trust domain, and a second secret to rotate buys
     * nothing.
     */
    readonly bridgePort: number;
    readonly bridgeBaseUrl: string;
  };
  readonly hypixel: {
    readonly apiKey: string | undefined;
    readonly keyMode: HypixelKeyMode;
    /**
     * Minimum gap between two requests for the *same* player, derived from the
     * mode. Zero in production mode, where the cache TTL is the only floor.
     */
    readonly playerWindowMs: number;
  };
  /**
   * How hard the platform is allowed to push the two APIs it does not own.
   *
   * Every number here is a ceiling on us rather than a promise from them: the
   * Discord REST queue and the Hypixel rate gate still enforce the real limits,
   * and raising any of these can only stop us from being slower than we have
   * to be. They are configuration because the real limits are not published
   * numbers — the `upstream throughput` log line reports calls, latency and
   * rate-limit hits per surface, and these are what you move once you have read
   * it.
   */
  readonly throughput: {
    /**
     * Discord REST requests per second, across every bucket. discord.js
     * defaults to 50, which is the documented global limit and therefore the
     * number at which the first 429 is somebody else's fault as much as ours.
     */
    readonly discordRps: number;
    /** Retries per Discord request before the call is handed back as failed. */
    readonly discordRetries: number;
    /** Hypixel reads in flight at once inside one job. */
    readonly hypixelConcurrency: number;
    /** BullMQ jobs one worker process runs at once. */
    readonly workerConcurrency: number;
  };
  /**
   * SkyKings — the third-party scammer database consulted when screening join
   * requests. Optional: without it screening still runs and still records, it
   * just reports every applicant as unchecked rather than cleared.
   */
  readonly skykings: { readonly apiKey: string | undefined };
  /**
   * Where the platform reports on itself.
   *
   * Channel ids rather than configured slots, because these are about the
   * *fleet* rather than about any one guild: the alert that matters most is the
   * one sent while the database — and therefore every guild's configuration —
   * is unreadable. Unset means the watchtower and the log shipper stay silent,
   * which is the correct default for a development machine.
   */
  readonly ops: {
    readonly alertChannelId: string | undefined;
    /** Errors are shipped here. Falls back to the alert channel when unset. */
    readonly errorChannelId: string | undefined;
  };
  readonly minecraft: {
    readonly host: string;
    readonly port: number;
    readonly username: string | undefined;
    /**
     * Protocol version to speak. Pinned rather than negotiated: Hypixel's
     * status ping advertises protocol 774 (1.21.11) while the server is natively
     * 1.8.9 behind ViaVersion, so auto-detection connects on a protocol that
     * never reaches PLAY and is dropped a few seconds later with no kick packet.
     */
    readonly version: string;
  };
  readonly web: {
    readonly port: number;
    /**
     * How the panel is reached by a browser. Drives cookie `Secure`, the origin
     * the CSRF check compares against, and whether this process terminates TLS
     * itself. Defaults to https so the insecure mode is always a deliberate act.
     */
    readonly scheme: WebScheme;
    /**
     * Absolute origin the panel is served on, e.g. `http://203.0.113.10:3000`.
     * Set this when the panel sits behind a proxy or on a bare IP; when unset it
     * is derived from the OAuth redirect URI, which is the only other place the
     * public address is already written down.
     */
    readonly publicUrl: string | undefined;
    /**
     * `Secure` on session cookies. Derived from the scheme rather than NODE_ENV:
     * a browser silently drops a Secure cookie over http, which presents as
     * "login succeeds but I'm never logged in" — the exact failure the HTTP mode
     * exists to avoid.
     */
    readonly secureCookies: boolean;
    /**
     * In-process TLS material. Optional because the usual production shape is a
     * reverse proxy terminating TLS and forwarding plaintext to this port; these
     * are for the case where the panel is the edge.
     */
    readonly tls: { readonly certPath: string; readonly keyPath: string } | undefined;
  };
}

/** Collects validation errors so we can report them all at once. */
class Validator {
  private readonly errors: string[] = [];
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  /** Record a problem the typed helpers can't express (cross-field rules). */
  push(message: string): void {
    this.errors.push(message);
  }

  requireString(key: string): string {
    const v = this.env[key]?.trim();
    if (!v) {
      this.errors.push(`Missing required env var: ${key}`);
      return "";
    }
    return v;
  }

  optionalString(key: string): string | undefined {
    const v = this.env[key]?.trim();
    return v ? v : undefined;
  }

  enum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const v = this.env[key]?.trim();
    if (!v) return fallback;
    if (!(allowed as readonly string[]).includes(v)) {
      this.errors.push(`Invalid ${key}="${v}" (expected one of: ${allowed.join(", ")})`);
      return fallback;
    }
    return v as T;
  }

  int(key: string, fallback: number): number {
    const v = this.env[key]?.trim();
    if (!v) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n)) {
      this.errors.push(`Invalid ${key}="${v}" (expected an integer)`);
      return fallback;
    }
    return n;
  }

  url(key: string, required: boolean): string | undefined {
    const v = required ? this.requireString(key) : this.optionalString(key);
    if (!v) return undefined;
    try {
      // eslint-disable-next-line no-new
      new URL(v);
      return v;
    } catch {
      this.errors.push(`Invalid ${key}="${v}" (expected a valid URL/connection string)`);
      return v;
    }
  }

  throwIfInvalid(): void {
    if (this.errors.length > 0) {
      throw new Error(
        `Invalid environment configuration:\n  - ${this.errors.join("\n  - ")}`,
      );
    }
  }
}

let cached: AppConfig | undefined;

/** Load, validate, and memoize the application config. Throws on invalid env. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;

  const v = new Validator(env);
  const nodeEnv = v.enum("NODE_ENV", NODE_ENVS, "development");
  const web = webConfig(v, env, nodeEnv);

  const config: AppConfig = {
    nodeEnv,
    isProduction: nodeEnv === "production",
    logLevel: v.enum("LOG_LEVEL", LOG_LEVELS, "info"),
    database: { url: v.url("DATABASE_URL", true) ?? "" },
    redis: {
      url: v.url("REDIS_URL", true) ?? "",
      keyPrefix: v.optionalString("REDIS_KEY_PREFIX") ?? "sbr:",
    },
    discord: {
      bridgeToken: v.optionalString("DISCORD_BRIDGE_TOKEN"),
      adminToken: v.optionalString("DISCORD_ADMIN_TOKEN"),
      guideToken: v.optionalString("DISCORD_GUIDE_TOKEN"),
      clientId: v.optionalString("DISCORD_CLIENT_ID"),
    },
    oauth: {
      clientId: v.optionalString("DISCORD_OAUTH_CLIENT_ID"),
      clientSecret: v.optionalString("DISCORD_OAUTH_CLIENT_SECRET"),
      redirectUri: v.optionalString("DISCORD_OAUTH_REDIRECT_URI"),
      sessionSecret: v.optionalString("SESSION_SECRET"),
    },
    internalApi: internalApiConfig(v),
    hypixel: hypixelConfig(v),
    throughput: {
      discordRps: v.int("DISCORD_RPS", 50),
      discordRetries: v.int("DISCORD_RETRIES", 3),
      hypixelConcurrency: v.int("HYPIXEL_CONCURRENCY", 4),
      workerConcurrency: v.int("WORKER_CONCURRENCY", 8),
    },
    skykings: { apiKey: v.optionalString("SKYKINGS_API_KEY") },
    ops: {
      alertChannelId: v.optionalString("OPS_ALERT_CHANNEL_ID"),
      errorChannelId:
        v.optionalString("OPS_ERROR_CHANNEL_ID") ?? v.optionalString("OPS_ALERT_CHANNEL_ID"),
    },
    minecraft: {
      host: v.optionalString("MC_HOST") ?? "mc.hypixel.net",
      port: v.int("MC_PORT", 25565),
      username: v.optionalString("MC_USERNAME"),
      version: v.optionalString("MC_VERSION") ?? "1.8.9",
    },
    web,
  };

  v.throwIfInvalid();
  cached = config;
  return config;
}

/**
 * Resolve the Hypixel key and the policy regime it is used under.
 *
 * The mode is not decoration: it sets `playerWindowMs`, which the client
 * enforces on every player-scoped read. Defaulting to `personal` means the
 * strict window is what you get by forgetting to configure anything, which is
 * the right direction for a limit whose whole purpose is to be hard to exceed
 * by accident.
 */
function hypixelConfig(v: Validator): AppConfig["hypixel"] {
  const apiKey = v.optionalString("HYPIXEL_API_KEY");
  const keyMode = v.enum("HYPIXEL_KEY_MODE", HYPIXEL_KEY_MODES, "personal");

  // `production` is an assertion that a production-tier key has been granted.
  // Asserting it with no key at all is always a mistake, and a loud one here is
  // better than a silent fleet of unauthenticated requests.
  if (keyMode === "production" && apiKey === undefined) {
    v.push('HYPIXEL_KEY_MODE=production requires HYPIXEL_API_KEY — set the key, or use the default "personal"');
  }

  return {
    apiKey,
    keyMode,
    playerWindowMs: keyMode === "personal" ? PERSONAL_PLAYER_WINDOW_MS : 0,
  };
}

/**
 * Resolve the admin bot's internal control API.
 *
 * The token is the only authentication this API has, so a short one is worse
 * than none: it is checked here rather than left to be discovered when someone
 * guesses it. The default bind is loopback, and a non-loopback base URL is
 * allowed but called out, since the API answers "list every member of this
 * server" to anyone holding the token.
 */
function internalApiConfig(v: Validator): AppConfig["internalApi"] {
  const token = v.optionalString("INTERNAL_API_TOKEN");
  const port = v.int("INTERNAL_API_PORT", 3011);
  if (token !== undefined && token.length < 24) {
    v.push("INTERNAL_API_TOKEN is shorter than 24 characters — generate one with `openssl rand -hex 32`");
  }
  const baseUrl = v.optionalString("INTERNAL_API_URL") ?? `http://127.0.0.1:${String(port)}`;
  if (parseOrigin(baseUrl) === null) {
    v.push(`Invalid INTERNAL_API_URL="${baseUrl}" (expected an absolute URL)`);
  }

  const bridgePort = v.int("BRIDGE_API_PORT", 3012);
  if (bridgePort === port) {
    // Both default to loopback on one host, so a collision is a silent
    // "address in use" at start-up on whichever process loses the race.
    v.push("BRIDGE_API_PORT and INTERNAL_API_PORT are the same — the two bots cannot share a port");
  }
  const bridgeBaseUrl = v.optionalString("BRIDGE_API_URL") ?? `http://127.0.0.1:${String(bridgePort)}`;
  if (parseOrigin(bridgeBaseUrl) === null) {
    v.push(`Invalid BRIDGE_API_URL="${bridgeBaseUrl}" (expected an absolute URL)`);
  }

  return { token, port, baseUrl, bridgePort, bridgeBaseUrl };
}

/**
 * Resolve the panel's transport settings.
 *
 * Split out because this is the one part of the config with rules rather than
 * just types: HTTP is a real operational mode (a VPS on a bare IP with no
 * certificate yet), but it must never become the accidental production shape, so
 * it costs one explicit opt-in and never happens by omission.
 */
function webConfig(v: Validator, env: NodeJS.ProcessEnv, nodeEnv: NodeEnv): AppConfig["web"] {
  const scheme = v.enum("WEB_PANEL_SCHEME", WEB_SCHEMES, "https");
  const port = v.int("WEB_PANEL_PORT", 3000);
  const publicUrl = v.optionalString("WEB_PANEL_PUBLIC_URL");

  if (publicUrl !== undefined) {
    const parsed = parseOrigin(publicUrl);
    if (parsed === null) {
      v.push(`Invalid WEB_PANEL_PUBLIC_URL="${publicUrl}" (expected an absolute URL)`);
    } else if (parsed.protocol !== `${scheme}:`) {
      // A public URL disagreeing with the scheme is how you get a Secure cookie
      // over http, or a CSRF origin check that rejects every write.
      v.push(
        `WEB_PANEL_PUBLIC_URL="${publicUrl}" does not match WEB_PANEL_SCHEME="${scheme}" — the scheme decides cookie and origin handling`,
      );
    }
  }

  if (scheme === "http") {
    // Production over plaintext means session cookies cross the network in the
    // clear. Allowed, because "temporarily, on a VPS I control" is a real
    // situation — but only when someone has said so in as many words.
    const allowInsecure = env["WEB_PANEL_ALLOW_INSECURE"]?.trim() === "true";
    if (nodeEnv === "production" && !allowInsecure) {
      v.push(
        'WEB_PANEL_SCHEME="http" with NODE_ENV=production sends session cookies in plaintext — set WEB_PANEL_ALLOW_INSECURE=true to accept that',
      );
    }
    const redirect = v.optionalString("DISCORD_OAUTH_REDIRECT_URI");
    if (redirect?.startsWith("https://")) {
      v.push('DISCORD_OAUTH_REDIRECT_URI is https but WEB_PANEL_SCHEME="http" — the OAuth callback would never reach the panel');
    }
  } else {
    // The mirror image: https marks cookies Secure, and a browser drops those
    // over a plaintext origin. Loopback is exempt because browsers treat
    // http://localhost as a secure context, which is what makes the default
    // scheme work on a dev box with no certificate.
    const redirect = parseOrigin(v.optionalString("DISCORD_OAUTH_REDIRECT_URI") ?? "");
    if (redirect?.protocol === "http:" && !isLoopback(redirect.hostname)) {
      v.push(
        `DISCORD_OAUTH_REDIRECT_URI="${redirect.href}" is plaintext but WEB_PANEL_SCHEME defaults to https — Secure cookies would be dropped. Set WEB_PANEL_SCHEME=http to run without TLS.`,
      );
    }
  }

  const certPath = v.optionalString("WEB_PANEL_TLS_CERT");
  const keyPath = v.optionalString("WEB_PANEL_TLS_KEY");
  if ((certPath === undefined) !== (keyPath === undefined)) {
    v.push("WEB_PANEL_TLS_CERT and WEB_PANEL_TLS_KEY must be set together (or neither, to run behind a TLS-terminating proxy)");
  }
  if (certPath !== undefined && scheme === "http") {
    v.push('WEB_PANEL_TLS_CERT is set but WEB_PANEL_SCHEME="http" — pick one');
  }

  return {
    port,
    scheme,
    publicUrl,
    secureCookies: scheme === "https",
    tls: certPath !== undefined && keyPath !== undefined ? { certPath, keyPath } : undefined,
  };
}

/** Hosts browsers treat as a secure context even over plaintext. */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function parseOrigin(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The origin a browser reaches the panel on — what the CSRF origin check compares
 * against and what OAuth redirects are built from. Prefers the explicit setting,
 * then the redirect URI (the only other place the public address is recorded),
 * and finally the local bind address so a dev box works with neither set.
 */
export function panelOrigin(config: AppConfig): string {
  const explicit = config.web.publicUrl ?? config.oauth.redirectUri;
  const parsed = explicit === undefined ? null : parseOrigin(explicit);
  if (parsed) return parsed.origin;
  return `${config.web.scheme}://localhost:${config.web.port}`;
}

/**
 * Assert an optional value is present when a specific app actually needs it.
 * e.g. the bridge-bot calls `requirePresent(cfg.discord.bridgeToken, "DISCORD_BRIDGE_TOKEN")`.
 */
export function requirePresent<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Required configuration "${name}" is not set for this process.`);
  }
  return value;
}

/** Test seam — clears the memoized config. */
export function resetConfigCache(): void {
  cached = undefined;
}
