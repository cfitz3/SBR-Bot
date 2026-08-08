/**
 * Transport-agnostic command layer for the member bot. The discord.js / in-game
 * adapters translate a raw interaction into a CommandContext and render the
 * returned CommandReply — all logic lives here and in the injected services.
 */
import type {
  ActionRowView,
  AnalyticsService,
  BridgeCapability,
  CommandArgs,
  CommandSurface,
  CommunityService,
  EmbedView,
  GuildConfigService,
  GuildRosterSource,
  IdentityService,
  MarketService,
  OptionType,
  PlayerLookup,
  PricingService,
  ProgressionService,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";

export interface CommandContext {
  readonly guildId: string;
  readonly userId: string; // Discord id
  /**
   * The caller's Discord username, when the surface knows it. `/link` needs it
   * because Hypixel's social field stores a username rather than a snowflake;
   * the in-game surface resolves a player by IGN and has no username to pass.
   */
  readonly username?: string | undefined;
  readonly surface: CommandSurface;
  readonly args: CommandArgs;
}

/**
 * A rendered reply, still transport-agnostic. `text` is always populated: the
 * in-game surface has no embeds, and it doubles as the accessible fallback.
 * Richer fields are additive, so a handler can stay text-only where that reads
 * better than a card.
 */
export interface CommandReply {
  readonly text: string;
  readonly ephemeral: boolean;
  readonly embed?: EmbedView;
  readonly components?: readonly ActionRowView[];
  /** Multi-page output (`/infractions`, `/audit`); page 1 doubles as `embed`. */
  readonly pages?: readonly EmbedView[];
}

/**
 * Everything a member command may reach for. Deliberately concrete rather than
 * per-command: a handler is a pure function of (context, deps), so tests stub
 * exactly the service under exercise and the dispatcher stays uniform.
 */
export interface HandlerDeps {
  readonly identity: IdentityService;
  readonly progression: ProgressionService;
  /**
   * IGN → uuid. Lookup commands accept a `player` the caller has no link for,
   * which identity (keyed by Discord id) cannot resolve.
   */
  readonly players: PlayerLookup;
  readonly pricing: PricingService;
  /** Order book and listings — the raw market behind `/bazaar` and `/auctions`. */
  readonly market: MarketService;
  readonly community: CommunityService;
  /**
   * Live in-game presence for `/online`. Optional because it exists only where
   * a Mineflayer session does — the admin bot and the panel wire the same
   * handler deps and have no bridge to ask.
   */
  readonly roster?: GuildRosterSource;
  readonly config: GuildConfigService;
  readonly analytics: AnalyticsService;
  readonly logger: Logger;
}

export type CommandHandler = (ctx: CommandContext, deps: HandlerDeps) => Promise<CommandReply>;

/** One suggestion in an autocomplete response. */
export interface Choice {
  readonly name: string;
  readonly value: string;
}

/**
 * Who is typing. Autocomplete needs it because the useful suggestions are
 * caller-specific — `/setprofile` can only offer the profiles on *your*
 * account. Deliberately narrower than CommandContext: there are no args yet.
 */
export interface AutocompleteContext {
  readonly guildId: string;
  readonly userId: string;
}

export type AutocompleteHandler = (
  focused: { readonly name: string; readonly value: string },
  ctx: AutocompleteContext,
  deps: HandlerDeps,
) => Promise<readonly Choice[]>;

export interface CommandOptionSpec {
  readonly name: string;
  readonly description: string;
  readonly type: OptionType;
  readonly required?: boolean;
  readonly autocomplete?: boolean;
  readonly choices?: readonly Choice[];
  readonly minValue?: number;
  readonly maxValue?: number;
}

/**
 * The single source of truth for a command. The Discord registration payload is
 * *derived* from this (see `discord.ts`) rather than maintained beside it —
 * previously the two were separate lists that could silently disagree, which is
 * how commands ended up registered with no handler behind them.
 */
export interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly CommandOptionSpec[];
  readonly capability?: BridgeCapability;
  readonly cooldownMs: number;
  /**
   * Reachable from in-game guild chat as `!name`. Off by default: guild chat
   * can't prove Discord identity, so commands opt in explicitly
   * (COMMANDS.md §17).
   *
   * `true` — a read-only lookup. Being able to speak in guild chat is itself
   * proof of guild membership, which is all a lookup needs, so these work for
   * unlinked players too.
   *
   * `"linked"` — writes something. Reachable, but only once the speaking IGN
   * resolves to a linked Discord account, because the action gets attributed to
   * a person and a chat line alone can't name one.
   */
  readonly inGame?: boolean | "linked";
  readonly handler: CommandHandler;
  readonly autocomplete?: AutocompleteHandler;
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
