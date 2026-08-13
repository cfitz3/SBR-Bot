/**
 * Bridge relay types. The pipeline is transport-agnostic: apps supply the
 * Discord/in-game adapters and feed InboundMessages in; the pipeline decides
 * what (if anything) to deliver.
 */
export type RelayDirection = "DISCORD_TO_GAME" | "GAME_TO_DISCORD";

export interface InboundMessage {
  readonly guildId: string;
  readonly direction: RelayDirection;
  /** Discord id (DISCORD_TO_GAME) or IGN (GAME_TO_DISCORD). */
  readonly authorId: string;
  readonly authorName: string;
  /** Guild rank for GAME_TO_DISCORD, if known. */
  readonly authorRank?: string | null;
  readonly content: string;
}

export type DropReason =
  | "EMPTY"
  | "NO_PERMISSION"
  | "BRIDGE_SUSPENDED"
  | "MUTED"
  | "FILTERED"
  | "AUTOMOD"
  | "RATE_LIMITED"
  | "DUPLICATE";

export type RelayDecision =
  | { readonly action: "DELIVER"; readonly formatted: string; readonly flagged: boolean }
  | { readonly action: "DROP"; readonly reason: DropReason };

// ── Ports (implemented over identity/config/redis at wiring time) ──

export interface BridgeGuard {
  isSuspended(guildId: string): Promise<boolean>;
  isMuted(guildId: string, authorId: string): Promise<boolean>;
  /** RELAY_MESSAGE capability. */
  canRelay(guildId: string, authorId: string): Promise<boolean>;
}

export type FilterVerdict =
  | { readonly action: "ALLOW" }
  | { readonly action: "FLAG" }
  | { readonly action: "BLOCK" }
  | { readonly action: "SHADOW_MUTE" }
  | { readonly action: "REPLACE"; readonly replacement: string };

export interface WordlistFilter {
  check(guildId: string, content: string): Promise<FilterVerdict>;
}

/**
 * Port: automod, judging a relayed message.
 *
 * A port rather than a direct dependency so this package keeps knowing nothing
 * about Redis, the settings store or the moderation service — the same reason
 * the wordlist arrives as `WordlistFilter` rather than as the filter itself.
 * The implementation (bridge-bot's composition root, over `AutomodRunner`) is
 * what issues any punishment; the pipeline only needs to know whether the
 * message survives.
 *
 * Optional: a deployment without automod configured passes no gate, and the
 * stage is skipped rather than stubbed.
 */
export interface AutomodGate {
  check(msg: InboundMessage): Promise<{ readonly blocked: boolean }>;
}

/**
 * Port: counting what the relay carried, for the Analytics page.
 *
 * Synchronous and returning nothing, unlike every other port here. Telemetry
 * must never be able to delay or fail a relay — a chat message that arrives a
 * second late because a metrics buffer was slow is a worse outcome than a lost
 * count, and `void` in the signature makes awaiting it impossible rather than
 * merely discouraged. The implementation buffers in Redis and is drained by the
 * analytics job.
 *
 * Only deliveries are counted. A dropped message is a moderation fact, not a
 * relay volume one, and the reasons it was dropped are already visible as
 * filter hits and moderation actions; folding them in here would make the
 * bridge chart answer two questions with one line.
 */
export interface RelayMetrics {
  relayed(guildId: string, direction: RelayDirection): void;
}

export interface FloodControl {
  allow(
    guildId: string,
    authorId: string,
    content: string,
  ): Promise<{ allowed: boolean; reason?: "RATE" | "DUPLICATE" }>;
}
