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

const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error"];
const NODE_ENVS: readonly NodeEnv[] = ["development", "test", "production"];

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly logLevel: LogLevel;
  readonly database: { readonly url: string };
  readonly redis: { readonly url: string; readonly keyPrefix: string };
  readonly discord: {
    readonly bridgeToken: string | undefined;
    readonly adminToken: string | undefined;
    readonly clientId: string | undefined;
  };
  readonly oauth: {
    readonly clientId: string | undefined;
    readonly clientSecret: string | undefined;
    readonly redirectUri: string | undefined;
    readonly sessionSecret: string | undefined;
  };
  readonly hypixel: { readonly apiKey: string | undefined };
  readonly minecraft: {
    readonly host: string;
    readonly port: number;
    readonly username: string | undefined;
  };
  readonly web: { readonly port: number };
}

/** Collects validation errors so we can report them all at once. */
class Validator {
  private readonly errors: string[] = [];
  constructor(private readonly env: NodeJS.ProcessEnv) {}

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
      clientId: v.optionalString("DISCORD_CLIENT_ID"),
    },
    oauth: {
      clientId: v.optionalString("DISCORD_OAUTH_CLIENT_ID"),
      clientSecret: v.optionalString("DISCORD_OAUTH_CLIENT_SECRET"),
      redirectUri: v.optionalString("DISCORD_OAUTH_REDIRECT_URI"),
      sessionSecret: v.optionalString("SESSION_SECRET"),
    },
    hypixel: { apiKey: v.optionalString("HYPIXEL_API_KEY") },
    minecraft: {
      host: v.optionalString("MC_HOST") ?? "mc.hypixel.net",
      port: v.int("MC_PORT", 25565),
      username: v.optionalString("MC_USERNAME"),
    },
    web: { port: v.int("WEB_PANEL_PORT", 3000) },
  };

  v.throwIfInvalid();
  cached = config;
  return config;
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
