/**
 * Transport-agnostic command layer for the member bot. The discord.js / in-game
 * adapters translate a raw interaction into a CommandContext and render the
 * returned CommandReply — all logic lives here and in the injected services.
 */
import type {
  BridgeCapability,
  CommandSurface,
  IdentityService,
  ProgressionService,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";

export interface CommandContext {
  readonly guildId: string;
  readonly userId: string; // Discord id
  readonly surface: CommandSurface;
  readonly args: Readonly<Record<string, string>>;
}

export interface CommandReply {
  readonly text: string;
  readonly ephemeral: boolean;
}

export interface HandlerDeps {
  readonly identity: IdentityService;
  readonly progression: ProgressionService;
  readonly logger: Logger;
}

export type CommandHandler = (ctx: CommandContext, deps: HandlerDeps) => Promise<CommandReply>;

export interface CommandSpec {
  readonly name: string;
  readonly capability?: BridgeCapability;
  readonly cooldownMs: number;
  readonly handler: CommandHandler;
}

/** Cooldown gate (Redis-backed at wiring time; in-memory for tests/single-instance). */
export interface CooldownGate {
  consume(key: string, ttlMs: number): Promise<{ allowed: boolean; retryAfterMs?: number }>;
}

/** Capability check — wired to IdentityService.hasCapability. */
export interface CapabilityChecker {
  can(guildId: string, userId: string, capability: BridgeCapability): Promise<boolean>;
}

/** Minimal analytics sink (wired to AnalyticsService.capture). */
export interface UsageSink {
  capture(usage: {
    guildId: string | null;
    discordId: string | null;
    surface: CommandSurface;
    command: string;
    success: boolean;
    latencyMs: number;
    invokedAt: string;
  }): Promise<void>;
}
