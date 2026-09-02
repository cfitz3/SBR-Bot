/**
 * Every user-facing failure message, keyed by the reason code that produced it.
 *
 * Keyed by code rather than by call site on purpose: the same denial reaches a
 * member through a slash command, a panel page and an in-game reply, and it
 * should say the same thing in all three. When a surface genuinely needs a
 * different phrasing — the panel's denial can offer a sign-in button, in-game
 * chat cannot — the surface adds its own key rather than rewording this one.
 */

export const DEFAULT_ERRORS = {
  /** Panel `DenyReason`, from `panel-core/access.ts`. */
  deny: {
    NOT_AUTHENTICATED: "Sign in with Discord to continue.",
    NOT_MANAGEABLE:
      "This server isn't yours to manage. Panel access needs Manage Server in Discord, or moderator rank here.",
    INSUFFICIENT_ROLE: "Your role in this guild doesn't reach the tier this page requires.",
  },

  /** What the panel adds under a denial that a click cannot fix. */
  denyHint: "Ask a guild admin if you think this is wrong.",

  /**
   * Generic failures, reached from more than one surface.
   *
   * The platform failures name `/health` and nothing else. "Something went
   * wrong, try again in a moment" was a guess dressed as advice — trying again
   * is exactly what a member does anyway, and it does not help if the reason is
   * a database that has been down for ten minutes. `/health` answers the
   * question the member actually has, which is whether it is them or us.
   *
   * The four that are not platform failures deliberately do not: a member who
   * lacks a permission or typed a name that matched nothing has no reason to go
   * read a status card, and sending them there would train everyone to ignore
   * the pointer that matters.
   */
  generic: {
    unknown: "That didn't complete. Run `/health` to see whether the platform is up.",
    saveFailed: "That didn't save. Run `/health` to see whether the platform is up.",
    loadFailed: "That didn't load. Run `/health` to see whether the platform is up.",
    rateLimited: "Slow down a moment — try that again shortly.",
    notLinked: "Run `/link` to connect your Minecraft account first.",
    noPermission: "You don't have permission to do that.",
    notFound: "Nothing matched that.",
    upstreamDown: "Hypixel isn't answering. That's on their end — `/health` tracks it.",
  },

  /**
   * Refusals that are about *where* the member is standing, not about a failure.
   *
   * Guild chat has no server, no channels and no member list, so a handful of
   * commands genuinely cannot answer there. These say which surface does work,
   * because the member's next move is to go and use it — and they never point at
   * `/health`, since nothing is unhealthy.
   */
  surface: {
    discordOnly: "That answer needs Discord. Run it there.",
    needsChannel: "That needs a channel to post in. Run it from Discord.",
    /** An optional channel argument that only defaults when there is a channel to default to. */
    nameChannel: "Name a channel — there is none to infer here.",
  },

  /**
   * What Discord itself refused, told as Discord's answer rather than the bot's
   * apology.
   *
   * The one family of failures a guild admin can fix in under a minute and
   * nobody else can fix at all, so they name the missing permission as the cause
   * instead of routing to `/health`: the platform is up, and a bug report would
   * reach the wrong people.
   */
  discord: {
    missingPermission: "Discord refused that — the bot is missing a permission it needs.",
    cannotPost: "The bot cannot post in that channel. Check its permissions there.",
    memberMissing: "Discord doesn't show you as a member of this server.",
  },

  /**
   * The in-game relay, absent and offline being different facts with different
   * answers.
   *
   * A guild that never configured Mineflayer is not having an outage, and
   * sending its members to a status card would be a wild goose chase. A relay
   * that is configured and down is exactly what `/health` reports.
   */
  bridge: {
    notConfigured: "Guild chat isn't set up on this server.",
    offline: "Guild chat is offline, so the roster can't be read. `/health` tracks it.",
  },

  /** A duration the parser could not read. The examples are the whole message. */
  badDuration: "Unreadable duration. Use a form like `30m`, `2h30m` or `1w`.",

  /** A date or time the parser could not read. */
  badTime: "Unreadable time.",

  /**
   * The button under a platform failure.
   *
   * Appearance only. There is no key here that removes the button, because the
   * button is the platform's own reporting path: a guild that switched it off
   * would keep every bug to itself without deciding to.
   */
  report: {
    button: "Report a bug",
    /** Empty for no emoji, which is a real choice rather than a missing value. */
    emoji: "",
  },

  /**
   * Hypixel's four documented refusals, in the member's terms.
   *
   * Keyed by `HypixelFailureState` so the switch that used to hold these
   * sentences is a lookup: every card that can fail prints one of these, on both
   * bots and in guild chat, and a fifth state added upstream is a type error here
   * rather than a card that renders `undefined`.
   *
   * None of them says "error". Three of the four are somebody else's setting or
   * somebody else's rate limit, and telling a member their own lookup broke when
   * it did not is how a platform earns a reputation for being flaky.
   */
  hypixel: {
    NOT_LINKED: "You're not linked yet — use /link <ign>.",
    MISSING_PROFILE: "No Skyblock profile found for that player.",
    RATE_LIMITED: "Hypixel is rate-limiting the platform right now.",
    API_DISABLED: "That data is turned off in the player's Hypixel API settings.",
  },

  /**
   * Why a `/goal` did not take, keyed by `GoalError["kind"]`.
   *
   * `ALREADY_THERE` is the one that earns its place: a member who asks to reach
   * a number they already passed has misread their own card, and telling them
   * where they actually are is more use than refusing.
   */
  goal: {
    UNAVAILABLE: "Goals aren't switched on for this guild yet.",
    ALREADY_THERE: "You're already at {current} — aim higher than that.",
    BAD_TARGET: "That target isn't a number.",
  },

  /**
   * Why a `/link` did not take, keyed by `LinkError["kind"]`.
   *
   * Each one names the next action, because every one of these is fixable by the
   * member in under a minute and a bare "link failed" would send them to staff
   * instead.
   */
  link: {
    IGN_NOT_FOUND: "That IGN doesn't exist.",
    SOCIAL_UNSET: "Set your Discord in-game first (Hypixel → social menu), then run /link again.",
    SOCIAL_MISMATCH: "Your Hypixel Discord link doesn't match your Discord account.",
    ALREADY_OWNED: "That Minecraft account is already linked to another member.",
  },

  /**
   * What a dispatcher says before a handler ever runs — the same four answers in
   * both bots, on Discord and in guild chat.
   *
   * These are separate from `generic` because they carry a placeholder and
   * `generic` deliberately does not: a key that is only ever pasted whole can be
   * reworded freely, while one with a `{token}` has a contract with its caller.
   */
  command: {
    /** `{name}` is what was typed, without its slash or prefix. */
    unknown: "Unknown command: {name}",
    /**
     * A command this guild's deploy has retired. Distinct from `unknown`
     * because it is a different fact and a different next step: the name was
     * real, so "it was withdrawn" answers the question that "no such command"
     * only raises. `{name}` is what was typed.
     */
    retired: "`/{name}` has been retired.",
    /** `{n}` is whole seconds, always at least 1. */
    cooldown: "Slow down — try that again in {n}s.",
    /** `{old}` and `{new}` are command names; the old one still answers. */
    renamed: "`/{old}` is now `/{new}`.",
    /** `{name}` is the command; admin-bot's guard on a destructive action. */
    confirmRequired: "⚠️ /{name} is destructive. Re-run with confirm:true to proceed.",

    /**
     * The two halves of an admin-bot role denial, kept apart because they are
     * different facts: one says the ladder does not reach, the other says the
     * actor is not on it at all — and only the first is worth arguing about.
     * `{role}` is the floor actually in force, which a guild may have moved.
     */
    roleTooLow: "That command requires {role} or higher.",
    notAMember: "You are not recorded as a member of this guild.",

    /**
     * A staff command that threw. It claims more than `generic.unknown` does —
     * that nothing was written — which the admin bot can say because its
     * handlers write through services that are transactional, and which the
     * bridge bot's read-heavy commands have no need to say at all.
     */
    adminFailed: "That action failed — nothing was changed. Run `/health` to see whether the platform is up.",
  },
};

export type Errors = typeof DEFAULT_ERRORS;
