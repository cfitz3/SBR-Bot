/**
 * Command and option descriptions, keyed by command name.
 *
 * These are the words Discord shows in the slash-command picker, that `/help`
 * lists, that in-game `!help` prints, and that the panel's command docs render.
 * They used to be literals inside the five handler files, which meant that
 * rewording one line landed in the same diff as the behaviour around it and that
 * an operator could not touch them at all without reading a file full of logic.
 *
 * The overlay is applied in `buildBridgeRegistry()` and `buildAdminRegistry()` —
 * one seam each, and the only place a registry is assembled — so the four
 * surfaces above physically cannot disagree about what a command claims to do.
 * A spec keeps its `name`, `cooldownMs`, `capability`, `inGame` and `handler`;
 * only the prose moved.
 *
 * Two things worth knowing before editing:
 *
 *  - **Names are the keys, and names are not copy.** Renaming a command is a
 *    Discord registration change and a muscle-memory change for every member, so
 *    it stays in the spec. This file is only ever about the sentence.
 *  - **Discord caps a description at 100 characters.** `builders.ts` truncates
 *    with an ellipsis at registration time, which is silent and happens on a
 *    machine nobody is watching. `npm run brand check` reports an over-length
 *    description before deploy instead.
 *
 * A command absent from this map keeps whatever its spec says. That is the honest
 * default for a new command: it works, it is just not overridable until somebody
 * adds it here.
 */

export interface CommandCopy {
  readonly description: string;
  readonly option?: Readonly<Record<string, string>>;
}

/**
 * Bridge and admin commands share this namespace because their names do not
 * collide — checked, not assumed: `buildBridgeRegistry()` and
 * `buildAdminRegistry()` currently define 44 and 26 commands with no overlap, and
 * `withCommandCopy` would have no way to tell two same-named commands apart if
 * that ever changed. A test asserts the two registries stay disjoint.
 */
export const DEFAULT_COMMANDS: Record<string, CommandCopy> = {
  // ── Member commands (`@sbr/commands-bridge`) ───────────────────────────────

  "8ball": {
    description: "Ask the magic 8-ball",
    option: {
      question: "What you want to know",
    },
  },
  attendance: {
    description: "Who has responded to an event",
    option: {
      event: "Event id (shown by /events)",
    },
  },
  auctions: {
    description: "Active auctions for an item, or a player's own listings",
    option: {
      item: "Item name or id",
      player: "Minecraft username (defaults to you)",
    },
  },
  bazaar: {
    description: "Bazaar order book for an item",
    option: {
      item: "Item name or id",
    },
  },
  closerun: {
    description: "Close your run early",
    option: {
      id: "Run id",
    },
  },
  coinflip: { description: "Flip a coin" },
  "create-event": {
    description: "Schedule a guild event",
    option: {
      title: "Event name",
      starts_at: "When it starts, as an ISO time (2026-09-01T18:00Z)",
      type: "What kind of event",
      capacity: "Max people going (leave empty for unlimited)",
      description: "Extra detail",
    },
  },
  cringe: {
    description: "Add one to somebody's cringe tally",
    option: {
      player: "Minecraft username",
    },
  },
  dungeons: {
    description: "Catacombs level, classes and floor bests",
    option: {
      player: "Minecraft username (defaults to you)",
      profile: "Skyblock profile name",
    },
  },
  editrun: {
    description: "Change your run's headline, notes or party size",
    option: {
      id: "Run id",
      title: "New headline",
      details: "New requirements or notes",
      slots: "New party size",
    },
  },
  events: { description: "Upcoming guild events" },
  guildquote: { description: "A quote from the guild's collection" },
  help: { description: "List member commands" },
  joinrun: {
    description: "Take a slot in an open run",
    option: {
      id: "Run id (shown by /runs)",
    },
  },
  leaderboard: {
    description: "Guild rankings — wealth, tenure, skills, activity and XP",
    option: {
      category: "Which board to show (defaults to guild XP)",
      page: "Page of results",
      days: "Window for the activity boards (default 30)",
    },
  },
  leaverun: {
    description: "Give up your slot in a run",
    option: {
      id: "Run id",
    },
  },
  lfg: {
    description: "Start a looking-for-group post",
    option: {
      activity: "What you're running",
      slots: "Party size including you (default 5)",
      title: "Short headline for the post",
      details: "Requirements or notes",
      perm: "Bring your usual party for this activity",
      permname: "…or a specific perm by name",
    },
  },
  link: {
    description: "Link your Minecraft account (your Hypixel Discord social must match)",
    option: {
      ign: "Your Minecraft username",
    },
  },
  lowestbin: {
    description: "Cheapest buy-it-now listing for an item",
    option: {
      item: "Item name or id",
    },
  },
  me: { description: "Show your own profile summary" },
  milestones: {
    description: "Thresholds a player has crossed",
    option: {
      player: "Minecraft username (defaults to you)",
    },
  },
  missing: {
    description: "Notable accessories a player is missing or could upgrade",
    option: {
      player: "Minecraft username (defaults to you)",
      profile: "Skyblock profile name",
    },
  },
  networth: {
    description: "Networth estimate with a category breakdown",
    option: {
      player: "Minecraft username (defaults to you)",
      profile: "Skyblock profile name",
    },
  },
  nextupgrade: {
    description: "The highest-value upgrade to buy next",
    option: {
      player: "Minecraft username (defaults to you)",
      profile: "Skyblock profile name",
      focus: "What to optimize for (default general)",
    },
  },
  online: { description: "Who's online in the guild right now" },
  perm: {
    description: "Standing parties — create one, see a roster, add or drop people",
    option: {
      action: "What to do (default info)",
      perm: "Which perm, by name or id",
      name: "Name for the new perm (when creating)",
      activity: "What it runs (when creating)",
      ign: "Minecraft name (when adding or removing)",
      role: "Their role, e.g. healer, tank, filler",
      slot: "Seat order (optional)",
      notes: "Anything worth remembering about the group",
    },
  },
  price: {
    description: "Blended market value for an item",
    option: {
      item: "Item name or id",
    },
  },
  profile: {
    description: "View a player's Skyblock profiles",
    option: {
      player: "Minecraft username (defaults to you)",
      profile: "Skyblock profile name",
    },
  },
  goal: {
    description: "Set a progression target and track how it's going",
    option: {
      action: "List your goals, set one, or clear one (default list)",
      metric: "Which track to aim at",
      target: "The number to reach — 2b, 250, 45.5",
    },
  },
  progress: {
    description: "Your progression over time",
    option: {
      metric: "What to chart",
      range: "Days to look back (default 30)",
    },
  },
  snapshot: {
    description: "Save your current stats so /progress can chart the change",
    option: {
      label: 'What to call it — "before dungeon grind"',
    },
  },
  rank: {
    description: "Your entirely unofficial vibe rank",
    option: {
      player: "Whose rank (default yours)",
    },
  },
  roll: {
    description: "Roll dice — 100, d20, 2d6",
    option: {
      dice: "What to roll (default 100)",
    },
  },
  rps: {
    description: "Rock, paper, scissors",
    option: {
      throw: "Your throw",
    },
  },
  rsvp: {
    description: "Respond to a guild event",
    option: {
      event: "Event id (shown by /events)",
      response: "Your answer (default going)",
    },
  },
  runs: {
    description: "Open looking-for-group posts",
    option: {
      activity: "Filter by activity",
    },
  },
  setprofile: {
    description: "Choose which Skyblock profile your lookups use",
    option: {
      profile: "Profile name",
    },
  },
  skills: {
    description: "Skill levels and XP to next",
    option: {
      player: "Minecraft username (defaults to you)",
      profile: "Skyblock profile name",
      skill: "One skill only",
    },
  },
  // The rename notice itself is not copy: the dispatcher builds it from
  // `deprecatedBy` so it can never name a command that no longer exists.
  slayer: {
    description: "Deprecated — use /slayers",
    option: {
      player: "Minecraft username (defaults to you)",
      profile: "Skyblock profile name",
      boss: "One slayer only — shows the per-tier kill breakdown",
    },
  },
  slayers: {
    description: "Slayer XP, tiers and per-tier boss kills",
    option: {
      player: "Minecraft username (defaults to you)",
      profile: "Skyblock profile name",
      boss: "One slayer only — shows the per-tier kill breakdown",
    },
  },
  standing: {
    description: "Your guild XP, level and where it came from",
    option: {
      member: "Whose standing to show (defaults to you)",
    },
  },
  stats: {
    description: "Broad stat overview for a player",
    option: {
      player: "Minecraft username (defaults to you)",
      profile: "Skyblock profile name",
    },
  },
  ticket: {
    description: "Open, list or close a support ticket",
    option: {
      action: "What to do (default open)",
      type: "What it's about (when opening)",
      category: "Deprecated — use type:",
      subject: "One-line summary (when opening)",
      id: "Ticket id (when closing)",
      reason: "Why you're closing it",
    },
  },
  unlink: { description: "Remove your linked Minecraft account" },
  verify: {
    description: "Re-run the Hypixel social check to confirm or repair your link",
    option: {
      ign: "Minecraft username",
    },
  },
  whatnext: {
    description: "Suggested next steps for a player's progression",
    option: {
      player: "Minecraft username (defaults to you)",
      profile: "Skyblock profile name",
      goal: "What you're working towards (default general)",
    },
  },

  // ── Staff commands (`@sbr/commands-admin`) ─────────────────────────────────

  "accept-member": {
    description: "Accept an application and add the applicant to the roster",
    option: {
      id: "Application id",
      reason: "Note for the audit trail",
    },
  },
  "antiraid-off": { description: "Return to normal join and rate limits" },
  "antiraid-on": {
    description: "Raise join gating and message-rate limits",
    option: {
      sensitivity: "LOW, MEDIUM (default) or HIGH",
      duration: "Auto-disable after e.g. 1h",
    },
  },
  "application-review": {
    description: "List applications awaiting review, or open one by id",
    option: {
      id: "Application id (omit to list)",
    },
  },
  audit: {
    description: "Search the moderation log",
    option: {
      actor: "Filter by the staffer who acted",
      target: "Filter by the member acted on",
      type: "Filter by action type",
      days: "Look back this many days",
      in_force: "Only punishments still being enforced right now",
    },
  },
  ban: {
    description: "Ban a member",
    option: {
      target: "Member",
      reason: "Reason",
      duration: "Optional temp-ban duration",
      // Every destructive command carries this option and every one describes it
      // the same way. Keeping the four copies identical is now an edit here.
      confirm: "Confirm this destructive action",
    },
  },
  "bridge-suspend": { description: "Stop relaying between Discord and guild chat" },
  "bridge-unsuspend": { description: "Resume relaying between Discord and guild chat" },
  // The in-game door and roster. Every one of these ends as a line typed into
  // Minecraft by the bridge account, so the option copy says what Hypixel will
  // accept rather than what sounds friendly — a rejected duration is a command
  // that silently did nothing.
  tickets: {
    description: "Look at the ticket queue, and close or export one",
    option: {
      action: "What to do",
      id: "Ticket number or id",
      reason: "Why it is being closed",
    },
  },
  tag: {
    description: "Post one of this server's canned replies",
    option: { name: "Which reply to post" },
  },
  remind: {
    description: "Have me remind you about something later",
    option: { when: "How long from now — 30m, 2h30m, 1w", about: "What to remind you about" },
  },
  reminders: {
    description: "Your pending reminders",
    option: { cancel: "The id of one to cancel" },
  },
  levelalerts: {
    description: "Turn your own level-up announcements on or off",
    option: { state: "Leave it blank to see where you stand" },
  },
  whois: {
    description: "Who a member is here — Discord account, roles, link and standing",
    option: {
      member: "Whose card to show (defaults to you)",
      public: "Post it in the channel. Standing and your record are left off a public card",
    },
  },
  serverinfo: { description: "This Discord server at a glance" },
  rolemenu: {
    description: "Post a self-service role menu, or list the ones this server has",
    option: {
      action: "What to do",
      id: "Which menu",
      channel: "Where to post it (defaults to here)",
    },
  },
  sticky: {
    description: "Keep a message at the bottom of a channel",
    option: {
      action: "What to do",
      message: "What it should say",
      channel: "Which channel (defaults to here)",
    },
  },
  "join-queue": { description: "Live in-game join requests and how long is left to answer them" },
  "join-accept": {
    description: "Admit somebody who asked to join in-game",
    option: { ign: "Minecraft username" },
  },
  "join-deny": {
    description: "Refuse an in-game join request",
    option: { ign: "Minecraft username" },
  },
  "guild-invite": {
    description: "Invite a player who hasn't asked to join",
    option: { ign: "Minecraft username" },
  },
  "guild-kick": {
    description: "Remove a member from the in-game guild",
    option: {
      ign: "Minecraft username",
      reason: "Shown in-game; letters, numbers and basic punctuation",
    },
  },
  "guild-mute": {
    description: "Silence a member in guild chat",
    option: {
      ign: "Minecraft username",
      duration: "How long, e.g. 30m, 12h, 7d",
    },
  },
  "guild-unmute": {
    description: "Let a muted member speak in guild chat again",
    option: { ign: "Minecraft username" },
  },
  "guild-promote": {
    description: "Raise a member one in-game guild rank",
    option: { ign: "Minecraft username" },
  },
  "guild-demote": {
    description: "Lower a member one in-game guild rank",
    option: { ign: "Minecraft username" },
  },
  "deny-member": {
    description: "Reject an application",
    option: {
      id: "Application id",
      reason: "Why it was rejected",
    },
  },
  "feature-toggle": {
    description: "Turn a named feature on or off",
    option: {
      feature: "Feature key",
      enabled: "On or off",
    },
  },
  "filter-test": {
    description: "Check what the filter would do to a message",
    option: {
      text: "Message to test",
    },
  },
  case: {
    description: "Look up one moderation case by its id",
    option: {
      id: "The case id, e.g. act-1f3b",
    },
  },
  infractions: {
    description: "View a member's infraction history",
    option: {
      target: "Member",
    },
  },
  kick: {
    description: "Remove a member from the server",
    option: {
      target: "Member",
      reason: "Reason",
      confirm: "Confirm this destructive action",
    },
  },
  lockdown: {
    description: "Lock a channel or the whole server",
    option: {
      scope: "channel (default) or server",
      channel: "Channel to lock (defaults to here)",
      reason: "Why",
      duration: "Auto-lift after e.g. 30m",
      confirm: "Confirm this destructive action",
    },
  },
  "lockdown-lift": { description: "End an active lockdown early" },
  "member-note": {
    description: "Attach a private staff note to a member",
    option: {
      target: "Member",
      note: "The note",
    },
  },
  mute: {
    description: "Mute a member across Discord + guild chat",
    option: {
      target: "Member",
      duration: "e.g. 1h, 30m",
      reason: "Reason",
    },
  },
  purge: {
    description: "Bulk-delete recent messages in a channel",
    option: {
      count: "How many messages (1-100)",
      user: "Only this member's messages",
      channel: "Channel (defaults to here)",
      confirm: "Confirm this destructive action",
    },
  },
  "safety-status": { description: "Show any active lockdown or anti-raid posture" },
  "set-channel": {
    description: "Bind one of the platform's channels",
    option: {
      slot: "Which channel role to set",
      channel: "Leave empty to clear the slot",
    },
  },
  "set-recruitment": {
    description: "Open or close applications and set the entry bar",
    option: {
      open: "Accept applications?",
      min_weight: "Minimum Senither weight",
      min_networth: "Minimum networth in coins",
      clear_requirements: "Remove both thresholds",
    },
  },
  "set-role": {
    description: "Change a member's rank, or bind a rank to a Discord role",
    option: {
      role: "Platform rank",
      type: "member (default) or mapping",
      target: "Member (type:member)",
      discord_role: "Discord role id (type:mapping); empty clears it",
    },
  },
  unban: {
    description: "Lift a ban",
    option: {
      target: "Member (user ID — they aren't here to pick)",
      reason: "Reason",
    },
  },
  unmute: {
    description: "Lift a mute early, on Discord and in guild chat",
    option: {
      target: "Member",
      reason: "Reason",
    },
  },
  warn: {
    description: "Issue a formal warning",
    option: {
      target: "Member to warn",
      reason: "Reason",
    },
  },
  wordlist: { description: "List the chat-filter rules" },
  "wordlist-add": {
    description: "Add a chat-filter rule",
    option: {
      pattern: "Word, phrase, wildcard or regex",
      match_type: "How to match (default SUBSTRING)",
      action: "What to do on a match (default BLOCK)",
      severity: "1-5",
      note: "Why this rule exists",
    },
  },
  "wordlist-remove": {
    description: "Remove a chat-filter rule",
    option: {
      rule: "Rule id or exact pattern",
    },
  },
};

export type Commands = typeof DEFAULT_COMMANDS;
