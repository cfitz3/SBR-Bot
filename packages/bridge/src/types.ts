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

export interface FloodControl {
  allow(
    guildId: string,
    authorId: string,
    content: string,
  ): Promise<{ allowed: boolean; reason?: "RATE" | "DUPLICATE" }>;
}
