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
  readonly logger: Logger;
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
