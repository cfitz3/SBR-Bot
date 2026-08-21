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
      "You don't have Manage Server on this Discord guild, or the platform doesn't know about it yet.",
    INSUFFICIENT_ROLE: "Your role in this guild doesn't reach the tier this page requires.",
  },

  /** What the panel adds under a denial that a click cannot fix. */
  denyHint: "Ask a guild admin if you think this is wrong.",

  /** Generic failures, reached from more than one surface. */
  generic: {
    unknown: "Something went wrong. Try again in a moment.",
    saveFailed: "That didn't save.",
    loadFailed: "That didn't load.",
    rateLimited: "Slow down a moment — try that again shortly.",
    notLinked: "Run `/link` to connect your Minecraft account first.",
    noPermission: "You don't have permission to do that.",
    notFound: "Nothing matched that.",
    upstreamDown: "Hypixel isn't answering right now. This is on their end, not yours.",
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
    adminFailed: "That action failed unexpectedly — nothing was changed.",
  },
};

export type Errors = typeof DEFAULT_ERRORS;
