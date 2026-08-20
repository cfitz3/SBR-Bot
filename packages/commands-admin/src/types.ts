/**
 * Transport-agnostic command layer for the staff bot. Mirrors
 * @sbr/commands-bridge, but gated on platform rank rather than bridge
 * capabilities, and never exposed to the in-game surface.
 */
import type {
  ActionRowView,
  AnalyticsService,
  CommandArgs,
  CommunityService,
  EmbedView,
  GuildConfigService,
  GuildEffects,
  IdentityService,
  MemberRole,
  ModerationService,
  OptionType,
  SafetyService,
  WordlistService,
} from "@sbr/shared-types";
import type { JoinQueueService } from "@sbr/screening";
import type { Logger } from "@sbr/observability";

export interface AdminContext {
  readonly guildId: string;
  readonly actorId: string;
  readonly args: CommandArgs;
  /**
   * Where the command was invoked. `/purge` with no channel option sweeps here,
   * which is what a staffer typing it in the offending channel expects.
   */
  readonly channelId?: string | null;
}

export interface AdminReply {
  readonly text: string;
  readonly ephemeral: boolean;
  /** A generated text attachment — a ticket transcript. */
  readonly file?: { readonly name: string; readonly content: string };
  readonly embed?: EmbedView;
  readonly components?: readonly ActionRowView[];
  /** Multi-page output (`/infractions`, `/audit`); page 1 doubles as `embed`. */
  readonly pages?: readonly EmbedView[];
}

export interface AdminHandlerDeps {
  readonly moderation: ModerationService;
  readonly identity: IdentityService;
  readonly community: CommunityService;
  readonly config: GuildConfigService;
  readonly safety: SafetyService;
  readonly wordlist: WordlistService;
  /** The Discord side of `/kick`, `/purge` and `/lockdown`. */
  readonly effects: GuildEffects;
  readonly analytics: AnalyticsService;
  /**
   * The in-game join queue: `/join-queue`, `/join-accept`, `/join-deny`,
   * `/guild-invite`.
   *
   * Optional because it needs a bridge to type commands through, and a
   * deployment without one should say so rather than fail to start. The
   * handlers answer "the bridge isn't wired up here" when it is absent, which
   * is the same shape of answer they give when it is wired up but offline.
   */
  readonly joinQueue?: JoinQueueService;
  /** The bridge bot's ticket effects. Absent means `/tickets close` says so. */
  readonly ticketBridge?: TicketBridge;
  /**
   * Self-service role menus, which live in the community server. Absent means
   * `/rolemenu` says so rather than half-working.
   */
  readonly roleMenuBridge?: RoleMenuBridge;
  readonly logger: Logger;
}

/**
 * The bridge bot's ticket gateway, seen from here.
 *
 * Ticket channels live in the community server, where the *bridge* bot holds
 * the gateway — so closing a ticket from this bot means asking that one, or the
 * row would move while its channel stayed open with everyone still in it.
 * Reading tickets needs none of this and goes straight to the database, which
 * is why only the two effects are here.
 *
 * Optional for the same reason `joinQueue` is: a deployment without a bridge
 * should say so rather than fail to start.
 */
export interface TicketBridge {
  close(request: {
    readonly guildId: string;
    readonly ticketId: string;
    readonly actorDiscordId: string;
    readonly reason: string | null;
  }): Promise<{ readonly ok: true; readonly number: number } | { readonly ok: false; readonly detail: string }>;
  transcript(
    guildId: string,
    ticketId: string,
  ): Promise<{ readonly name: string; readonly content: string } | null>;
}

/** One configured role menu, as `/rolemenu list` shows it. */
export interface RoleMenuSummary {
  readonly id: string;
  readonly title: string;
  readonly optionCount: number;
  /** Where it currently lives, or null if it has never been posted. */
  readonly channelId: string | null;
}

/**
 * Self-service role menus, seen from the staff bot.
 *
 * The menus are edited on the panel and pressed in the community server, so
 * this bot neither owns the document nor holds the gateway that posts it. What
 * it offers is the staff verb — put this menu in this channel — which is why
 * only publishing and listing are here.
 *
 * Optional for the same reason `ticketBridge` is: a deployment without a bridge
 * should say so rather than fail to start.
 */
export interface RoleMenuBridge {
  list(guildId: string): Promise<readonly RoleMenuSummary[]>;
  publish(
    guildId: string,
    menuId: string,
    channelId: string | null,
  ): Promise<{ readonly ok: true; readonly edited: boolean } | { readonly ok: false; readonly detail: string }>;
}

export type AdminHandler = (ctx: AdminContext, deps: AdminHandlerDeps) => Promise<AdminReply>;

/** One suggestion in an autocomplete response. */
export interface Choice {
  readonly name: string;
  readonly value: string;
}

/**
 * Who is typing. Staff suggestions are guild-scoped — the wordlist rules worth
 * offering for `/wordlist-remove` are this server's, and no one else's.
 */
export interface AdminAutocompleteContext {
  readonly guildId: string;
  readonly userId: string;
}

export type AdminAutocompleteHandler = (
  focused: { readonly name: string; readonly value: string },
  ctx: AdminAutocompleteContext,
  deps: AdminHandlerDeps,
) => Promise<readonly Choice[]>;

export interface AdminOptionSpec {
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
 * The single source of truth for a staff command. The Discord registration
 * payload is derived from this (see `discord.ts`) rather than maintained
 * alongside it, so a command can never be registered without a handler.
 */
export interface AdminCommandSpec {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly AdminOptionSpec[];
  readonly minRole: MemberRole;
  readonly destructive?: boolean;
  readonly handler: AdminHandler;
  readonly autocomplete?: AdminAutocompleteHandler;
}

/**
 * Resolves the invoking staffer's platform role for tier + rank gating.
 *
 * Null means they are not a member of this guild, which every gate treats as
 * "denied" rather than as the bottom of the ladder.
 */
export interface RoleResolver {
  getRole(guildId: string, discordId: string): Promise<MemberRole | null>;
}
