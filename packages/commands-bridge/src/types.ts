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
  LeaderboardService,
  LFGPostDTO,
  MarketService,
  OptionType,
  PermService,
  PlayerLookup,
  PricingService,
  ProgressionService,
  XpService,
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
   * Standing parties. Member-facing only — the panel deliberately has no perm
   * surface, so this service is wired into the bots and nowhere else.
   */
  readonly perms: PermService;
  /**
   * Live in-game presence for `/online`. Optional because it exists only where
   * a Mineflayer session does — the admin bot and the panel wire the same
   * handler deps and have no bridge to ask.
   */
  readonly roster?: GuildRosterSource;
  readonly config: GuildConfigService;
  readonly analytics: AnalyticsService;
  /**
   * The LFG board in the configured `lfg` channel. Optional for the same reason
   * as `roster`: only a surface with a Discord client can publish one, and a
   * deployment without it still gets working `/lfg` replies — they just live in
   * the channel the command was run in.
   */
  readonly lfgBoard?: LfgBoard;
  /**
   * XP and standing. Optional so a deployment can run with XP switched off
   * entirely — `/standing` then says so rather than reporting zero, which reads
   * as "you have earned nothing" and is a different claim.
   */
  readonly xp?: XpService;
  /**
   * Guild leaderboards. Optional for the same reason as `xp`: several boards are
   * derived from XP and activity, and a deployment without those should say the
   * boards are off rather than publish a table of zeroes.
   *
   * Member-facing only — there is no panel surface for leaderboards by design.
   */
  readonly leaderboards?: LeaderboardService;
  readonly logger: Logger;
}

/**
 * Publishes an LFG post to the guild's board and keeps it current.
 *
 * Both methods absorb their own failures: a board that cannot be reached must
 * not turn a successful join into an error message. The post is the record; the
 * message is a view of it.
 */
export interface LfgBoard {
  /** Post the embed into the `lfg` channel and remember where it landed. */
  publish(post: LFGPostDTO): Promise<void>;
  /** Re-render the post where it was published. A no-op for an unpublished post. */
  refresh(post: LFGPostDTO): Promise<void>;
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
  /**
   * Whether guild chat can reach this option positionally. Defaults to true.
   *
   * In-game args are pure position — there is no `key:value` syntax and the last
   * option absorbs the rest of the line, so *every* option added to a spec eats a
   * token from the free-text one at the end. Marking an option `false` keeps it
   * Discord-only and leaves the in-game shape of the command as it was.
   */
  readonly inGamePositional?: boolean;
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
  /**
   * The command that replaced this one. Set on an alias kept for one release
   * after a rename so members' muscle memory keeps working; the dispatcher
   * prefixes the reply with a notice, and the transport can grey it out.
   */
  readonly deprecatedBy?: string;
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
