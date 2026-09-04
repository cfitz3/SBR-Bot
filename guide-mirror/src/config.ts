/**
 * Validated environment loading, fail-fast at boot.
 *
 * Deliberately small, and deliberately *not* a place where anything about a
 * particular Discord server can be configured. This file holds secrets and
 * process wiring — where Postgres is, where Redis is, which token to log in
 * with. Anything an operator might want to change while the bot is running
 * belongs in the database instead, where changing it does not mean a restart
 * and a redeploy.
 *
 * `loadConfig()` throws once, listing everything that is wrong, rather than
 * letting a missing variable surface three layers deep in a command handler.
 */
import { config as loadDotenv } from "dotenv";

loadDotenv();

export type NodeEnv = "development" | "test" | "production";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error"];
const NODE_ENVS: readonly NodeEnv[] = ["development", "test", "production"];

/**
 * Which Hypixel API policy regime this install runs under.
 *
 * - `personal` — a personal key under the guild-activity exception: at most one
 *   request per player per hour, enforced against our own clock rather than
 *   against the headers upstream sends back.
 * - `production` — a granted production-tier key, where the cache TTL is the
 *   only per-player floor.
 *
 * `personal` is the default, so an install that never sets the variable is the
 * restrictive one rather than the permissive one. See COMPLIANCE.md §0.
 */
export type HypixelKeyMode = "personal" | "production";

const HYPIXEL_KEY_MODES: readonly HypixelKeyMode[] = ["personal", "production"];

/** The per-player floor the guild-activity exception sets, in milliseconds. */
export const PERSONAL_PLAYER_WINDOW_MS = 60 * 60_000;

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly logLevel: LogLevel;
  readonly database: { readonly url: string };
  readonly redis: { readonly url: string; readonly keyPrefix: string };
  readonly discord: { readonly token: string | undefined };
  readonly hypixel: {
    readonly apiKey: string | undefined;
    readonly keyMode: HypixelKeyMode;
    /** Derived from the mode; zero in production mode. */
    readonly playerWindowMs: number;
  };
}

/**
 * Collects every problem instead of throwing on the first one.
 *
 * A boot failure that names one missing variable, gets fixed, and then names
 * the next one is three deploys to learn what a single message could have said.
 */
class Validator {
  private readonly problems: string[] = [];

  required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
      this.problems.push(`${name} is required but not set`);
      return "";
    }
    return value;
  }

  optional(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
  }

  withDefault(name: string, fallback: string): string {
    const value = process.env[name]?.trim();
    return value ? value : fallback;
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const value = process.env[name]?.trim();
    if (!value) return fallback;
    if (!(allowed as readonly string[]).includes(value)) {
      this.problems.push(`${name} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
      return fallback;
    }
    return value as T;
  }

  done(): void {
    if (this.problems.length > 0) {
      throw new Error(`Invalid environment:\n  - ${this.problems.join("\n  - ")}`);
    }
  }
}

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const v = new Validator();
  const nodeEnv = v.oneOf<NodeEnv>("NODE_ENV", NODE_ENVS, "development");
  const keyMode = v.oneOf<HypixelKeyMode>("HYPIXEL_KEY_MODE", HYPIXEL_KEY_MODES, "personal");

  const config: AppConfig = {
    nodeEnv,
    isProduction: nodeEnv === "production",
    logLevel: v.oneOf<LogLevel>("LOG_LEVEL", LOG_LEVELS, "info"),
    database: { url: v.required("DATABASE_URL") },
    redis: {
      url: v.withDefault("REDIS_URL", "redis://localhost:6379"),
      keyPrefix: v.withDefault("REDIS_KEY_PREFIX", "guide:"),
    },
    discord: { token: v.optional("DISCORD_GUIDE_TOKEN") },
    hypixel: {
      apiKey: v.optional("HYPIXEL_API_KEY"),
      keyMode,
      playerWindowMs: keyMode === "personal" ? PERSONAL_PLAYER_WINDOW_MS : 0,
    },
  };

  v.done();
  cached = config;
  return config;
}
