/**
 * The greeter: welcome, farewell and guild-join messages.
 *
 * The admin bot observes arrivals and departures — it already holds the
 * `GuildMembers` intent — and publishes them on the member bus. This process
 * does the talking, because a member is addressed by the bot they interact
 * with, and a welcome from a staff bot most members cannot see or message
 * would be the platform speaking out of the wrong mouth.
 *
 * The one-message function takes its Discord side as callbacks so it can be
 * tested without a gateway; `startGreeter` is the thin subscription around it.
 */
import {
  WELCOME_SETTING_KEY,
  parseWelcome,
  renderTemplate,
  tokensUsed,
  type WelcomeMode,
  type WelcomePolicy,
  type WelcomeTokenValues,
} from "@sbr/roles";
import type { Logger } from "@sbr/observability";
import type { ConfigChannelSlot } from "@sbr/shared-types";
import type { MemberBusMessage } from "@sbr/redis";

/** The platform's own facts about a member, for the tokens that need them. */
export interface WelcomeProfile {
  readonly ign: string | null;
  readonly guildRank: string | null;
  readonly level: number | null;
}

/** One rendered message, ready for a channel. */
export interface GreetPost {
  readonly channelId: string;
  readonly mode: WelcomeMode;
  readonly text: string;
  /** The one person this message is allowed to ping, if any. */
  readonly mentionDiscordId: string | null;
  readonly deleteAfterSeconds: number | null;
  /** Embed title when the mode is EMBED; ignored for plain text. */
  readonly title: string;
}

export interface GreeterDeps {
  /** The stored blob, straight from the settings KV. Parsed here. */
  readSetting(guildId: string, key: string): Promise<unknown>;
  /** The guild's binding for a configured channel slot, or null when unset. */
  getChannel(guildId: string, slot: ConfigChannelSlot): Promise<string | null>;
  /**
   * Facts the Discord event does not carry. Only called when a template
   * actually uses one of them — most welcomes do not, and a database round
   * trip per join for tokens nobody typed is a cost with no reader.
   */
  lookupProfile(guildId: string, discordId: string): Promise<WelcomeProfile | null>;
  /** Post to a channel. `false` means it did not land. */
  post(post: GreetPost): Promise<boolean>;
  /** Direct message the joiner. A closed DM is a `false`, never a throw. */
  dm(discordId: string, text: string): Promise<boolean>;
  readonly log: Logger;
}

/** Tokens whose values cost a query. */
const PROFILE_TOKENS = ["ign", "guildRank", "level"] as const;

function needsProfile(...templates: readonly (string | null)[]): boolean {
  for (const template of templates) {
    if (template === null) continue;
    const used = tokensUsed(template);
    if (PROFILE_TOKENS.some((token) => used.includes(token))) return true;
  }
  return false;
}

async function loadPolicy(deps: GreeterDeps, guildId: string): Promise<WelcomePolicy> {
  // Tolerant on read, per the settings convention: an unreadable blob means
  // "not configured", which is silence rather than a crashed subscriber.
  return parseWelcome(await deps.readSetting(guildId, WELCOME_SETTING_KEY));
}

/**
 * Handle one member-bus message. Returns true when a channel post landed.
 *
 * A section that is switched off, a guild with no channel bound for the slot,
 * and a failed post all return false — the caller logs, and nothing is retried.
 * A welcome is only worth saying at the moment it happens; re-posting one an
 * hour later, when the member has already been shown around by hand, is worse
 * than not posting at all.
 */
export async function greetMember(message: MemberBusMessage, deps: GreeterDeps): Promise<boolean> {
  const policy = await loadPolicy(deps, message.guildId);
  const section = message.kind === "member-join" ? policy.join : policy.leave;
  if (!section.enabled) return false;

  const dmText = message.kind === "member-join" ? policy.join.dm : null;
  const profile = needsProfile(section.text, dmText)
    ? await deps.lookupProfile(message.guildId, message.discordId).catch(() => null)
    : null;

  const values: WelcomeTokenValues = {
    user: `<@${message.discordId}>`,
    username: message.username,
    server: message.serverName,
    memberCount: message.memberCount === null ? "" : String(message.memberCount),
    ign: profile?.ign ?? "",
    guildRank: profile?.guildRank ?? "",
    level: profile?.level == null ? "" : String(profile.level),
  };

  // The DM goes first and independently: it is the half that most often fails
  // — everybody's privacy settings are their own — and a closed DM must not
  // cost the whole server its welcome message.
  if (message.kind === "member-join" && dmText !== null) {
    const sent = await deps.dm(message.discordId, renderTemplate(dmText, values)).catch(() => false);
    if (!sent) deps.log.debug("welcome dm not delivered", { discordId: message.discordId });
  }

  const channelId = await deps.getChannel(message.guildId, section.channelSlot).catch(() => null);
  if (channelId === null) {
    // Not an error: a guild that has enabled the message but not bound the
    // channel is mid-setup, and the panel says so on the Roles & Welcome page.
    deps.log.debug("welcome has no channel bound", { guildId: message.guildId, slot: section.channelSlot });
    return false;
  }

  const post: GreetPost = {
    channelId,
    mode: message.kind === "member-join" ? policy.join.mode : "TEXT",
    text: renderTemplate(section.text, values),
    // Only the member the message is about, and only when they are still here
    // to read it: pinging somebody who has left is a notification to nobody.
    mentionDiscordId: message.kind === "member-join" ? message.discordId : null,
    deleteAfterSeconds: message.kind === "member-join" ? policy.join.deleteAfterSeconds : null,
    title: message.kind === "member-join" ? "Welcome" : "Farewell",
  };
  return await deps.post(post).catch(() => false);
}

/** The in-game side: somebody was accepted into the Hypixel guild. */
export interface GuildJoinNotice {
  readonly guildId: string;
  readonly ign: string;
  readonly guildRank: string | null;
  /** Set when the account is linked, so `{user}` can address them. */
  readonly discordId: string | null;
}

/**
 * Announce an in-game guild join. A different audience and usually a different
 * channel, but the same template engine — two renderers would drift, and the
 * one that drifted would be the one an admin only reads once a week.
 */
export async function greetGuildJoin(notice: GuildJoinNotice, deps: GreeterDeps): Promise<boolean> {
  const policy = await loadPolicy(deps, notice.guildId);
  if (!policy.guildJoin.enabled) return false;

  const channelId = await deps.getChannel(notice.guildId, policy.guildJoin.channelSlot).catch(() => null);
  if (channelId === null) return false;

  const values: WelcomeTokenValues = {
    user: notice.discordId === null ? notice.ign : `<@${notice.discordId}>`,
    username: notice.ign,
    ign: notice.ign,
    guildRank: notice.guildRank ?? "",
  };
  return await deps
    .post({
      channelId,
      mode: "TEXT",
      text: renderTemplate(policy.guildJoin.text, values),
      mentionDiscordId: notice.discordId,
      deleteAfterSeconds: null,
      title: "Guild join",
    })
    .catch(() => false);
}

export interface GreeterHandle {
  stop(): Promise<void>;
}

/** What the bus half needs: subscribe, and hand back an unsubscribe. */
export interface MemberBusSubscriber {
  subscribe(onMessage: (message: MemberBusMessage) => void): Promise<() => Promise<void>>;
}

/**
 * Subscribe to the member bus and greet what arrives.
 *
 * Every message is handled in its own catch. The bus is one pattern
 * subscription shared by every guild on the fleet, so an unhandled rejection
 * from one malformed setting would silence the greeter for all of them.
 */
export async function startGreeter(bus: MemberBusSubscriber, deps: GreeterDeps): Promise<GreeterHandle> {
  const unsubscribe = await bus.subscribe((message) => {
    void greetMember(message, deps).catch((error: unknown) => {
      deps.log.warn("greeting failed", {
        kind: message.kind,
        guildId: message.guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  return { stop: unsubscribe };
}
