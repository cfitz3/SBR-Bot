/**
 * Panel copy: nav labels, page titles and subtitles, and the shared state text.
 *
 * Phase D of the brand plan moves the remaining ~555 in-page literals behind
 * keys here, page by page. What is present today is the furniture every page
 * shares — the nav, the five state functions in `client/components.ts`, and each
 * page's own heading — which is the part that must be settled first, because it
 * is what the per-page namespaces hang off.
 *
 * Namespaces are structural, never sentence-derived: `panel.nav.<page>`,
 * `panel.<page>.title`, `panel.<page>.subtitle`, `panel.state.<context>`. A key
 * never encodes its English, so rewording never renames.
 */

export const DEFAULT_PANEL = {
  /** Sidebar. `group` labels head the three sections; ids match `GUILD_PAGES`. */
  nav: {
    group: {
      monitor: "Monitor",
      queues: "Queues",
      configure: "Configure",
    },
    overview: "Overview",
    analytics: "Analytics",
    health: "Health",
    events: "Events",
    moderation: "Moderation",
    members: "Members",
    tickets: "Tickets",
    settings: "Settings",
    milestones: "Milestones",
    permissions: "Permissions",
    xp: "XP",
    leaderboard: "Leaderboard",
  },

  /**
   * The chrome around every page: the guild switcher, the nav landmarks and the
   * browser tab. `title` is the product name and appears in three places, so
   * renaming the platform is one edit.
   */
  shell: {
    /** The browser tab, and the page heading on the guild picker. */
    title: "SBR Panel",
    /** The full product name, on the sidebar's brand link. */
    name: "SBR Guild Platform",
    /** The short mark; its first character is the glyph in the rounded square. */
    wordmark: "SBR",
    /** The brand link's tooltip. */
    tagline: "Guild control panel",
    signOut: "Sign out",
    /**
     * Rendered into `index.html` server-side, so it is the one panel string that
     * has to read correctly in a browser where `main.ts` never runs. It names
     * the JSON path rather than a `<code>` element: the sentence stays whole,
     * which matters more here than the monospace.
     */
    noscript: "The control panel needs JavaScript. The underlying data is also available as JSON under /api/guilds.",
    guildsTitle: "Your guilds",
    switchGuild: "Switch guild",
    navLabel: "Guild pages",
    allGuilds: "All guilds",
    /** Shown when the selector call failed, so the name is genuinely unknown. */
    unknownGuild: "Guild",
    memberOne: "1 member",
    /** `{count}` is substituted with the formatted number. */
    memberMany: "{count} members",
    /** Only reachable if `/api/copy` itself fails; see `main.ts`. */
    copyUnavailable: "The panel couldn't load its own text. Reload, or check the server logs.",
  },

  /**
   * The five shared states. Every page reports "nothing here", "not allowed" and
   * "something broke" in one voice; these are the words that voice is made of.
   */
  state: {
    loading: "Loading…",
    /**
     * Per-page loading text. A page names which wait this is; `spinner()` with
     * no context falls back to the generic line above.
     */
    loadingContext: {
      analytics: "Loading analytics…",
      events: "Loading events…",
      health: "Loading job health…",
      members: "Loading members…",
      milestones: "Loading milestones…",
      moderation: "Loading moderation…",
      overview: "Loading overview…",
      permissions: "Loading permissions…",
      selector: "Loading your guilds…",
      settings: "Loading settings…",
      tickets: "Loading tickets…",
    },
    retry: "Try again",
    signIn: "Sign in with Discord",
    /**
     * Per-context empty text. Emptiness is never one sentence: "no members
     * matched your search" and "no members have ever been scanned" are
     * different facts, and a page that blurs them makes the operator wonder
     * whether the panel is broken. Each key is one distinct situation.
     */
    empty: {
      default: "Nothing here yet.",

      analyticsMessages:
        "No messages were counted in this window. Counting starts when the bots are in the server.",
      analyticsEngagement: "Nobody has been counted as active in this window.",
      analyticsGexp: "No guild experience has been recorded yet. It fills in once the guild scan has run.",
      analyticsTopMembers: "No member activity has been recorded in this window.",
      analyticsCharts:
        "No events were recorded in this window. Analytics fill in as the bots are used — try a wider range.",
      analyticsCommands: "No commands have been used in this window.",

      eventsUpcoming: "Nothing scheduled. Anything you create above lands here.",
      eventsRsvp: "Nobody has responded yet.",
      eventsHistory: "No finished or cancelled events on record.",

      healthJobs: "No worker jobs have reported in yet.",
      healthServices: "Liveness reporting is unavailable — check Redis.",

      membersSearch: "Nobody matches that search.",
      membersDiscord: "Everyone in the server has a linked account.",
      membersGame: "Everyone in the guild is linked to somebody in the server.",
      membersUnlinked: "Everyone on both rosters is linked.",
      membersNone: "No members on record yet. They appear as the roster scans run.",

      milestonesDisabled:
        "Milestone tracking isn't switched on for this deployment, so there is nothing to configure.",

      moderationInfractionsMember: "No infractions on record for this member.",
      moderationInfractionsGuild: "No infractions recorded in this guild yet.",
      moderationInForceMember: "Nothing is currently being enforced against this member.",
      moderationInForceGuild: "Nobody in this guild is muted or banned right now.",
      moderationActionsMember: "No panel or bot actions recorded against this member.",
      moderationActionsGuild: "No moderation actions recorded yet.",
      moderationAutomod:
        "No automod rules yet. Start one on “record it” and watch what it catches before it acts.",

      overviewActivity:
        "Nothing has happened in this guild yet — no moderation, joins, milestones or events on record.",
      overviewJoinAttempts: "No join attempts have been screened yet.",

      permissionsRanks: "No in-game rank confers a level in this guild.",
      permissionsCommandsUnavailable:
        "The command list isn't available in this deployment, so command floors can't be edited here.",
      permissionsCommandsNone: "No staff commands are registered.",
      permissionsExceptionsUnavailable: "Per-person exceptions aren't available in this deployment.",
      permissionsExceptionsNone: "Nobody is an exception in this guild.",

      selectorGuilds:
        "No guilds to show. You need Manage Server on a Discord guild that the platform has been set up for.",

      ticketsDisabled: "Ticketing isn't switched on for this deployment, so there is nothing to configure.",
      ticketsQueue: "No open tickets.",

      wordlistRules: "Nothing is being filtered in this guild.",
      wordlistDisabled: "The chat filter isn't switched on for this deployment, so there are no rules to edit.",

      xpDisabled: "Guild XP isn't switched on for this deployment, so there is nothing to configure here.",
    },
  },

  /**
   * What the client says when a request itself goes wrong, as opposed to the
   * server saying no — which is `error.deny.*`, shared with the bots.
   *
   * `{n}`, `{code}`, `{status}` and `{detail}` are substituted by `api.ts`.
   */
  request: {
    unreachable: "Couldn't reach the panel server.",
    notFound: "That page doesn't exist.",
    serverError: "The panel server hit an error. Try again in a moment.",
    failedWithCode: "Request failed ({code}).",
    failedWithStatus: "Request failed (HTTP {status}).",
    oauthMissing: "Discord login isn't configured on this deployment.",
    rateLimited: "Too many changes at once — try again in {n}s.",
    invalidInput: "That value isn't valid.",
    invalidInputDetail: "That value isn't valid: {detail}.",
    refused: "The change was refused.",
    refusedDetail: "The change was refused ({detail}).",
  },

  /**
   * Words that belong to no single page.
   *
   * Not a dumping ground: everything here is a word the panel says in the same
   * sense everywhere it appears, so a guild that prefers "—" to "none" says
   * so once. A word that means something slightly different on two pages gets
   * two keys instead.
   */
  common: {
    /** The em dash the tables use for "this cell has no value". */
    dash: "—",
    /** The separator between two facts on one line. */
    dot: "·",
    never: "never",
    unknown: "unknown",
    // `yes`/`no`/`none`/`enabled`/`disabled` were here and are gone. The panel
    // says those with a switch, a badge or an empty state, never with the word,
    // so every one of them was a key an operator could edit to no effect —
    // which is worse than no key at all, because it looks like a control.
  },

  /**
   * Numbers, spans and dates as the panel says them.
   *
   * These are the smallest strings in the product and the most repeated, which
   * is exactly why they are here: "3 minutes ago" is assembled in one place, so
   * a guild that wants "3m ago" changes three keys rather than auditing every
   * table. The singular and plural forms are separate keys rather than an "s"
   * appended by code — English gets away with that and most languages do not.
   *
   * `{n}` is a formatted number, `{span}` an already-worded span ("3 minutes").
   */
  format: {
    /** The locale thousands separators are drawn from. */
    numberLocale: "en-US",

    /** Spans shorter than a minute, said once and reused by both directions. */
    lessThanAMinute: "less than a minute",
    minuteOne: "{n} minute",
    minuteMany: "{n} minutes",
    hourOne: "{n} hour",
    hourMany: "{n} hours",
    dayOne: "{n} day",
    dayMany: "{n} days",

    /** How a span is placed in time. */
    ago: "{span} ago",
    inSpan: "in {span}",
    now: "now",
    /** Clock skew between the worker box and the viewer's browser is normal. */
    future: "in the future",

    /** Job run times, which are milliseconds up to a few minutes. */
    durationMs: "{n}ms",
    durationSeconds: "{n}s",
    durationMinutes: "{m}m {s}s",

    /** Three significant figures of a Skyblock figure: "1.2b", "340m", "8.5k". */
    suffixBillion: "b",
    suffixMillion: "m",
    suffixThousand: "k",

    ratio: "{part} of {whole} ({percent}%)",
  },

  /**
   * The shared controls: a field that saves itself, and the pickers that stand
   * in for typing a snowflake.
   *
   * These words appear on every configuration page, so they are the ones worth
   * getting right once. The picker's two empty states stay distinct on purpose —
   * "no matches" is the operator's to fix by typing something else, "directory
   * unavailable" is not.
   */
  forms: {
    saving: "Saving…",
    saved: "Saved",
    saveError: "Couldn't save that.",
    save: "Save",
    clear: "Clear",

    /** A role Discord manages for a bot or a boost, which staff cannot assign. */
    roleManaged: "Managed by an integration",
    memberHandle: "@{username}",
    memberBotHandle: "@{username} · bot",

    pickerUnavailable: "Directory unavailable — paste the id instead.",
    pickerNoMatches: "No matches.",
    chipRemove: "Remove {label}",

    /** `{kind}` is channel, role or member. */
    errIdEmpty: "Enter a {kind} id, or use Clear to unset it.",
    errId: "That doesn't look like a Discord {kind} id (17–20 digits).",
    errWhole: "Enter a whole number between {min} and {max}.",
  },

  /**
   * The channel slots, and what breaks when one is empty.
   *
   * Keys are the slot ids from `CONFIG_CHANNEL_SLOTS`; `channel-slots.test.ts`
   * fails if the two lists drift. The hint answers the question people actually
   * arrive with, which is not "what is this slot" but "what stopped working".
   */
  channelSlot: {
    bridge: {
      label: "Bridge",
      hint: "Relayed to and from guild chat. Unset means the bridge has nowhere to speak.",
    },
    staff: { label: "Staff", hint: "Staff-only notices: safety sweeps, escalations." },
    log: { label: "Log", hint: "Moderation and config audit trail." },
    applications: { label: "Applications", hint: "Where new applications are posted for review." },
    events: { label: "Events", hint: "Event announcements and RSVP posts." },
    lfg: {
      label: "Looking for group",
      hint: "Where /lfg posts land. Unset and the post has nowhere to go, so the command refuses.",
    },
    tickets: {
      label: "Ticket panel",
      hint: "Holds the open-a-ticket message. Threads for new tickets are created under it.",
    },
    milestones: {
      label: "Milestones",
      hint: "Achievement and milestone announcements. Unset means they are recorded but never shown.",
    },
    leaderboard: { label: "Leaderboards", hint: "Where scheduled leaderboard posts are published." },
    modlog: {
      label: "Moderation log",
      hint: "Per-action moderation record. Separate from Log so audit noise can stay out of a staff-visible channel.",
    },
  },

  /** Guild selector — the one page with no guild in scope. */
  selector: {
    guildOne: "1 guild",
    /** `{count}` is the number of guilds. */
    guildMany: "{count} guilds",
    hypixelLinked: "Hypixel linked",
    noHypixelGuild: "No Hypixel guild",
  },

  /**
   * Health. The subtitle is the page's whole finding in one line, so it has
   * three forms rather than one with a number stuffed into it.
   */
  health: {
    title: "Health",
    subtitleServicesDown: "{n} service(s) not reporting",
    subtitleHealthy: "All services and jobs reporting healthy",
    subtitleJobsUnhealthy: "{n} job(s) need attention",
    cardProcesses: "Processes",
    cardWorkers: "Workers",
    colJob: "Job",
    colStatus: "Status",
    colLastRun: "Last run",
    colDuration: "Duration",
    colFailures: "Failures (24h)",
    colService: "Service",
    colInstances: "Instances",
    colLastBeat: "Last beat",
    colDetail: "Detail",
    /** `{span}` is a humanised duration. */
    beatAgo: "{span} ago",
    noHeartbeat: "no heartbeat",
    runNow: "Run now",
    serviceDown: "down",
    serviceStale: "stale",
    serviceUp: "up",
    jobFailing: "failing",
    jobStale: "stale",
    jobNeverRun: "never run",
    jobOk: "ok",
  },

  /**
   * Members — both rosters merged.
   *
   * `role.*` and `tab.*` are keyed by the value they stand for, never by the
   * English, so renaming a tier is one edit here and no edit anywhere else.
   */
  members: {
    title: "Members",
    /** `{count}` is how many rows this filter produced. */
    subtitle: "{count} shown",
    role: {
      MEMBER: "Member",
      MODERATOR: "Moderator",
      OFFICER: "Officer",
      ADMIN: "Admin",
      /** Not assignable — rendered as a badge, never offered in the dropdown. */
      OWNER: "owner",
    },
    tab: {
      all: "All",
      discord: "Discord only",
      game: "In-game only",
      unlinked: "Unlinked",
    },
    searchPlaceholder: "Search by name, IGN, rank, Discord id or uuid",
    searchLabel: "Search members",
    filterLabel: "Member filter",
    tileDiscord: "Discord members",
    tileGuild: "Guild members",
    tileLinked: "Linked",
    /** Shown on the Linked tile when there is no Discord roster to compare to. */
    noDiscordRoster: "No Discord roster yet",
    /** `{pct}`, `{linked}` and `{total}` — percent and fraction answer different questions. */
    linkedNote: "{pct}% of the server · {linked}/{total}",
    neverScanned: "Never scanned",
    /** `{when}` is a relative time. */
    scanned: "Scanned {when}",
    cardRoster: "Roster",
    truncated: "More members matched than fit on one page. Narrow the search to see the rest.",
    colMember: "Member",
    colMinecraft: "Minecraft",
    colLink: "Link",
    colGuildRank: "Guild rank",
    colWeeklyGexp: "Weekly GEXP",
    colRole: "Platform role",
    /** `{name}` is the member's display name or id. */
    roleLabel: "Platform role for {name}",
    unlink: "Unlink",
    unlinkConfirm: "Confirm unlink",
    notInDiscord: "Not in Discord",
    unknownName: "unknown",
    /** A uuid with no name attached — the account exists, the lookup did not answer. */
    unknownIgn: "unknown name",
    linked: "linked",
    unlinked: "unlinked",
  },

  /**
   * Milestones — what the guild recognises and what reaching one pays.
   *
   * `metric.*` is keyed by the stored metric name, so the dropdown's words and
   * the row's subtitle can never disagree: both read the same key.
   */
  milestones: {
    title: "Milestones",
    notEnabled: "Not enabled",
    /** `{active}` of `{total}` definitions switched on. */
    subtitle: "{active} of {total} being recognised",
    note:
      "Detection compares each new snapshot against the one before it, so a threshold only fires when somebody " +
      "crosses it. Adding one now will not fire for members who are already past it.",
    metric: {
      networth: "Networth, in coins",
      skillAverage: "Skill average",
      catacombsLevel: "Catacombs level",
      slayerXp: "Total slayer XP",
      senitherWeight: "Senither weight",
    },
    /** `{metric}` and `{key}` — what this row measures and what identifies it. */
    rowSummary: "{metric} • key {key}",
    cardAdd: "Add a milestone",
    remove: "Remove",
    removeConfirm: "Confirm remove",
    sourceBuiltIn: "built-in",
    sourceCustom: "custom",
    recognisedLabel: "Recognised",
    recognisedHint:
      "Off stops this threshold firing for anybody from now on. Milestones already reached are kept.",
    announcedLabel: "Announced",
    announcedHint:
      "Off still records and still pays the reward — it just doesn't post in the milestones channel.",
    nameLabel: "Name",
    nameHint: "How this reads in the announcement, e.g. “1b networth”.",
    nameError: "Enter a name up to 80 characters.",
    thresholdLabel: "Threshold",
    thresholdHint: "The value that has to be crossed. Coins for networth, levels for catacombs.",
    rewardLabel: "XP reward",
    rewardHint: "Credited once, when the milestone is recorded. 0 recognises it without paying for it.",
    addNote: "Reusing an existing key edits that milestone instead of adding another one.",
    keyPlaceholder: "e.g. networth:250b",
    keyLabel: "Definition key",
    labelPlaceholder: "e.g. 250b networth",
    labelLabel: "Milestone name",
    thresholdPlaceholder: "e.g. 250000000000",
    thresholdValueLabel: "Threshold value",
    rewardPlaceholder: "0",
    addButton: "Add milestone",
    keyError: "Keys are lowercase, e.g. networth:250b.",
    labelError: "Give it a name.",
    measuredLabel: "Measured against",
    kindLabel: "Kind",
    kindHint: "Grouping only — it does not affect when the milestone fires.",
    positiveError: "Enter a number greater than zero.",
    /** `{max}` is the mutation layer's ceiling. */
    rewardError: "Enter a whole number between 0 and {max}.",
  },

  /**
   * Overview. Two rules the words here have to keep: membership is reported as
   * two rosters and never blended, and the scam check keeps three states —
   * `scamClear`, `scamListed` and `scamUnchecked` are three keys because they are
   * three different facts.
   */
  overview: {
    title: "Overview",
    /** `{role}` is the viewer's own tier, lowercased. */
    subtitle: "Signed in as {role}",
    bannerSuspendedLead: "Bridge suspended. ",
    bannerSuspendedBody: "Guild chat is not being relayed in either direction.",
    cardQueue: "Waiting on a human",
    tileOpenTickets: "Open tickets",
    tileOpenInfractions: "Open infractions",
    tileActivePunishments: "Active punishments",
    tileUpcomingEvents: "Upcoming events",
    tabsLabel: "Overview sections",
    tab: {
      membership: "Membership",
      activity: "Activity log",
      joins: "Join attempts",
    },
    cardActivity: "Activity log",
    cardJoins: "Recent join attempts",
    cardDiscord: "Discord server",
    cardGame: "In-game guild",
    cardLinks: "Linked accounts",
    tileDiscordMembers: "Members",
    /** `{count}` includes members who have left, which the tile above does not. */
    discordMembersNote: "{count} rows including those who left",
    /** `{days}` is the window the counts cover. */
    tileJoined: "Joined ({days}d)",
    tileLeft: "Left ({days}d)",
    tileLastSnapshot: "Last profile snapshot",
    tileInGuild: "In guild",
    tileLinkedToDiscord: "Linked to Discord",
    tileLinkedOfGuild: "Linked of the guild",
    gameNote:
      "Movement here is counted from the guild scans themselves, so somebody who joined and left inside the window shows in both figures rather than cancelling out.",
    linkNote:
      "A link is verified or it does not exist — there is no waiting state. Members shows exactly who is on each side.",
    scanDiscord: "Discord roster",
    scanGame: "Guild roster",
    cadenceDiscord: "every 2 hours",
    cadenceGame: "every 6 hours",
    /** `{what}` is a roster name, `{when}` a relative time. */
    scanNote: "{what} last updated {when}",
    scanNeverRun: " — this scan has not run yet, so the counts above may be from an older write.",
    /** `{cadence}` completes the sentence started by `scanNote`. */
    scanCadence: " · runs {cadence}.",
    activityKind: {
      MODERATION: "Moderation",
      SCREENING: "Join",
      MILESTONE: "Milestone",
      EVENT: "Event",
      ROSTER: "Roster",
    },
    colWhen: "When",
    colWhat: "What",
    colDetail: "Detail",
    activityNote:
      "The newest of each kind, interleaved. Configuration changes are not here — they are in the audit trail, which records who changed what rather than what the platform did on its own.",
    colPlayer: "Player",
    colScamCheck: "Scam check",
    colVerdict: "Verdict",
    colStats: "Stats",
    joinsNote:
      "Stats are what the player's profile said at the moment they asked, not what it says now — and a dash means their API was unreadable, not that the number is zero. Nothing here is a membership gate any more: the scam check is the only bar.",
    /** The fallback when the list gives no reason of its own. */
    scamListed: "listed",
    scamClear: "clear",
    /** Not "clear": the check failed to reach an answer, which is a different thing. */
    scamUnchecked: "not checked",
    /** `{score}` is the screening risk score. */
    riskScore: "risk {score}",
    profileUnreadable: "profile unreadable",
    statSkyblock: "sb {value}",
    statSkillAverage: "sa {value}",
    statCatacombs: "cata {value}",
    statWeight: "weight {value}",
    statNetworth: "nw {value}",
  },

  /** Per-page headings. Bodies move here in Phase D. */
  /**
   * Analytics.
   *
   * Two rules are written into these words and should survive any rewording:
   * Discord and guild chat are never summed, and an unknown figure is the dash
   * rather than a zero. `playtimeNote` says "estimate" out loud because neither
   * surface measures time.
   */
  analytics: {
    title: "Analytics",
    /** `{period}` is the bucket size, `{span}` the range it covers. */
    subtitle: "{period} buckets over the last {span}",
    rangeLabel: "Range",
    rangeAria: "Time range",
    bucketLabel: "Bucket",
    bucketAria: "Bucket size",
    range: {
      day: "24 hours",
      week: "7 days",
      month: "30 days",
      quarter: "90 days",
      year: "1 year",
    },
    exportRollups: "Export rollups (CSV)",
    exportCommands: "Export command stats (CSV)",
    cardMessages: "Messages",
    cardEngagement: "Engagement",
    cardPlaytime: "Playtime",
    cardGexp: "Guild experience",
    cardMembers: "Top members",
    cardCommands: "Top commands",
    cardActivity: "Activity",
    tileDiscord: "Discord",
    tileGuildChat: "Guild chat",
    tileCommands: "Commands",
    /** `{count}` messages a day. */
    perDay: "{count} / day",
    tileActive: "Active members",
    /** `{days}` is the window length. */
    activeNote: "said something in {days} days",
    tileEach: "Messages each",
    eachNote: "per active member",
    tileTracked: "Tracked members",
    trackedNote: "with any recorded activity",
    tilePresence: "Discord presence",
    presenceNone: "Not sampled",
    presenceNoneNote: "no presence samples have been recorded yet",
    /** `{samples}` taken `{minutes}` apart. */
    presenceNote: "estimated from {samples} samples {minutes} minutes apart",
    tileGameDays: "In-game days active",
    gameDaysNote: "days with any GEXP earned",
    playtimeNote:
      "Both figures are estimates. Presence is sampled, not measured, and a day with GEXP says somebody played, not for how long.",
    gexpSeries: "GEXP",
    colMember: "Member",
    colDiscord: "Discord",
    colGuildChat: "Guild chat",
    colGexp: "GEXP",
    colActiveDays: "Days active",
    unknownMember: "Unknown",
    discordOnly: "Discord only",
    gameOnly: "In-game only",
    truncated: "Older buckets were trimmed to keep the chart readable. The CSV export is complete.",
    /** `{pct}` of calls succeeded. */
    commandOk: "{pct}% ok",
    commandFailed: "{count} failed",
    /** `{duration}` is the mean latency. */
    commandLatency: "~{duration}",
  },
  /**
   * Events and attendance.
   *
   * `type` is keyed by the schema's own enum so a guild can rename "Dungeon"
   * without the create form losing the value it writes.
   */
  events: {
    title: "Events",
    subtitle: "{count} scheduled",
    type: {
      DUNGEON: "Dungeon",
      SLAYER: "Slayer",
      FISHING: "Fishing",
      MINING: "Mining",
      GIVEAWAY: "Giveaway",
      MEETING: "Meeting",
      CUSTOM: "Custom",
    },
    tileUpcoming: "Upcoming",
    tileNext: "Next up",
    tileNextNone: "Nothing scheduled",
    tileGoing: "Going to next",
    cardCreate: "Schedule an event",
    cardUpcoming: "Upcoming",
    /** `{title}` is the open event's own name. */
    cardRoster: "Who's coming — {title}",
    cardPast: "Finished and cancelled",
    titlePlaceholder: "Catacombs F7 carry night",
    titleLabel: "Event title",
    typeLabel: "Event type",
    startsLabel: "Starts at",
    startsInline: "Starts",
    capacityLabel: "Capacity",
    capacityInline: "Capacity",
    capacityPlaceholder: "No limit",
    descriptionLabel: "Description",
    descriptionPlaceholder: "What is it, and what should people bring? (optional)",
    create: "Schedule",
    createNote: "You are recorded as the host, and the host is the only person who can cancel it.",
    errNoTitle: "Give the event a title.",
    errNoStart: "Pick a start date and time.",
    errPastStart: "That start time has already passed.",
    errCapacity: "Capacity has to be a whole number of at least 1.",
    showRsvps: "View RSVPs",
    hideRsvps: "Hide RSVPs",
    cancel: "Cancel event",
    cancelConfirm: "Confirm cancel",
    /** `{going}` already carries its own "of {capacity}" when the event is capped. */
    rowCounts: "{going} going · {maybe} maybe · {declined} declined",
    hostedBy: " · hosted by ",
    noHost: " · no host on record",
    /** `{going}` of `{capacity}`, when there is a cap. */
    seatsCapped: "{going} of {capacity}",
    rsvpGoing: "Going",
    rsvpWaitlist: "Waitlisted",
    rsvpMaybe: "Maybe",
    rsvpDeclined: "Declined",
    /** `{label}` is a column name, `{count}` its size. */
    rosterHeading: "{label} ({count})",
    colEvent: "Event",
    colType: "Type",
    colOutcome: "Outcome",
    colStarted: "Started",
    colWent: "Went",
  },
  /**
   * Moderation: what happens to a member, and who decided it.
   *
   * The four sections share one block because they share one page. The action
   * names and the automod trigger kinds are keyed by the values the platform
   * stores, so a kind gained before copy names it renders as its own key rather
   * than as a blank row.
   *
   * Two honesty rules are carried in the wording here and must survive a
   * rewrite: the duration hint says a blank field means permanent rather than
   * zero, and the test box says plainly that nothing is written and the tested
   * message is never recorded.
   */
  moderation: {
    title: "Moderation",
    subtitle: "History, automod, filter and cooldowns.",

    /** Tab strip. The ids are structure; these are the words on them. */
    tabsAria: "Moderation section",
    tabHistory: "History",
    tabAutomod: "Automod",
    tabFilter: "Filter",
    tabCooldowns: "Cooldowns",

    /** One subtitle per section, since the page's answer changes with the tab. */
    subtitleAutomod: "{live} of {total} rules live",
    subtitleAutomodOff: "Switched off — rules are kept but nothing fires",
    subtitleFilter: "The chat filter, the warning ladder, and what a punishment does in guild chat",
    subtitleCooldowns: "How long a member waits between commands, and between relayed messages",
    subtitleMember: "{count} infraction(s) on record for this member",
    subtitleGuild: "Guild-wide audit trail — pick a member to narrow it",

    cardLookup: "Look up a member",
    cardIssue: "Issue an action",
    cardInfractions: "Infractions",
    cardInForce: "In force now",
    cardActionsMember: "Actions on this member",
    cardActionsRecent: "Recent actions",
    cardRecentInfractions: "Recent infractions",
    cardAutomod: "Automod",
    cardTest: "Test a message",
    cardRules: "Rules",
    /** With at least one rule, the count goes in the heading. */
    cardRulesCount: "Rules ({count})",
    cardCooldowns: "Cooldowns",

    /** What each staff action does. Keyed by the values `PANEL_ACTIONS` allows. */
    actionName: {
      NOTE: "Note",
      WARN: "Warn",
      MUTE: "Mute",
      UNMUTE: "Unmute",
      KICK: "Kick",
      BAN: "Ban",
      UNBAN: "Unban",
    },
    actionHint: {
      NOTE: "A private record. Nothing is enforced and the member is not told.",
      WARN: "A logged warning the member is notified about.",
      MUTE: "Silences the member on Discord and in guild chat.",
      UNMUTE: "Lifts an active mute early.",
      KICK: "Removes the member; they can rejoin with an invite.",
      BAN: "Removes the member and blocks their return.",
      UNBAN: "Lifts a ban.",
    },

    lookupPlaceholder: "Search by name, IGN, or paste an id",
    lookupAria: "Member to look up",
    lookupNoMatch: "No member matched. Pick one from the list, or paste their Discord user id.",
    lookupGo: "Look up",
    lookupClear: "Clear",

    fieldAction: "Action",
    fieldMember: "Member",
    fieldDuration: "Duration",
    fieldReason: "Reason",
    targetPlaceholder: "Search by name, or paste an id",
    targetAria: "Member to act on",
    durationPlaceholder: "e.g. 30m, 2h, 7d",
    /** Blank is permanent, not zero — say so, because the two read alike. */
    durationHint: "Leave blank for permanent. Only mutes and bans take a duration.",
    reasonPlaceholder: "Why this action was taken — this is the audit record",
    apply: "Apply action",
    errNoTarget: "Pick the member to act on, or paste their Discord user id.",
    errNoReason: "A reason is required — it's what the audit row will say.",
    errDuration: "Duration must look like 30m, 2h or 7d, up to a year.",

    colMember: "Member",
    colType: "Type",
    colSeverity: "Severity",
    colReason: "Reason",
    colWhen: "When",
    colAction: "Action",
    colBy: "By",
    colEnds: "Ends",
    colSince: "Since",
    colDuration: "Duration",

    badgeInForce: "in force",
    badgeExpired: "expired",
    badgeLifted: "lifted",
    permanent: "permanent",
    /** A run-out mute reads as "2h (14m left)" while it still has time on it. */
    remaining: "{span} ({left} left)",

    automodIntro:
      "Automod acts on a message with nobody in the loop, on Discord and in guild chat alike. A rule that fires hands the action to the same pipeline as /warn — so the escalation ladder, the audit trail and the in-game punishment sync all apply to it.",
    automodLabel: "Automod on",
    automodHint: "Off stops every rule at once and keeps them all. Use this first when something is misfiring.",
    newRule: "New rule",

    surfaceDiscord: "discord",
    surfaceGuildChat: "guild chat",
    ruleLive: "live",
    ruleOff: "off",
    ruleEdit: "Edit",
    ruleClose: "Close",
    remove: "Remove",
    removeConfirm: "Confirm remove",

    draftNote: "Nothing here is stored until you press Add rule.",
    addRule: "Add rule",
    cancel: "Cancel",
    autosaveNote: "Every change here is saved as you make it.",

    nameLabel: "Name",
    nameHint: "What this rule is for. It appears in the audit row when the rule fires.",
    errName: "Enter a name up to {max} characters.",
    liveLabel: "Live",
    liveHint: "Off keeps the rule here and stops it firing.",
    discordLabel: "On Discord",
    guildChatLabel: "In guild chat",
    guildChatHint:
      "A member muted on Discord who carries on in guild chat has not been moderated, only redirected.",
    catchesLabel: "Catches",

    /** The trigger kinds, keyed by the value stored on the rule. */
    trigger: {
      wordlist: "a word on the chat filter",
      regex: "a pattern",
      spam: "too many messages",
      repeat: "the same message repeated",
      mentions: "too many mentions",
      caps: "shouting",
      links: "a link",
      invites: "a Discord invite",
    },
    /** What each trigger actually watches, in the guild's terms. */
    triggerHint: {
      wordlist: "Runs the guild's chat filter over the message. One list, both features.",
      regex: "A regular expression, compiled as written. Refused at save time if it doesn't compile.",
      spam: "Counts one author's messages in a rolling window.",
      repeat: "Counts how often one author sent this exact text in a rolling window.",
      mentions: "Counts the mentions in a single message.",
      caps: "The share of letters in upper case, over a minimum length so “OK” doesn't trip it.",
      links: "Any link whose host is not on the allowlist. An empty allowlist catches every link.",
      invites: "A discord.gg (or equivalent) invite anywhere in the message.",
    },

    thenLabel: "Then",
    /** What a fired rule does. Keyed by the action the rule stores. */
    automodAction: {
      FLAG: "record it",
      WARN: "warn them",
      MUTE: "mute them",
    },
    automodActionHint: {
      FLAG: "Recorded and shown to staff. Nothing happens to the member — start new rules here.",
      WARN: "A warning, which counts towards the escalation ladder on the Filter section.",
      MUTE: "A mute, carried into guild chat by the sync rows on the Filter section.",
    },
    deleteLabel: "Delete the message",
    deleteHint:
      "Separate from the action above: “delete it and say nothing” and “warn them but leave it up” are both things staff ask for.",
    muteForLabel: "Mute for",
    muteForHint: "Seconds, up to {max} (a day). Blank leaves it open-ended.",
    errMuteFor: "Enter 1–{max} seconds, or leave it blank.",

    exemptRolesLabel: "Roles that skip this rule",
    exemptRolesHint: "Discord only — guild chat has no roles. Leave empty and the rule applies to everyone.",
    exemptRolesPlaceholder: "Search roles",
    exemptCapabilityLabel: "Capability that skips this rule",
    exemptCapabilityHint: "The guild-chat side's staff check, since there are no roles there to exempt.",
    exemptNobody: "nobody",

    patternLabel: "Pattern",
    patternHint:
      "A regular expression. Refused at save time if it doesn't compile — better than storing one that silently never matches.",
    errPattern: "Enter a pattern up to {max} characters.",
    flagsLabel: "Flags",
    flagsHint: "Regex flags, e.g. i for case-insensitive. Leave blank for none.",
    errFlags: "Flags may only be g, i, m, s, u or y.",
    messagesLabel: "Messages",
    messagesHint: "How many messages from one author trip it.",
    withinLabel: "Within",
    withinHint: "Seconds, up to {max}.",
    repeatsLabel: "Repeats",
    repeatsHint: "How many times the same text has to be sent.",
    mentionsLabel: "Mentions allowed",
    mentionsHint: "The most mentions one message may carry.",
    capsLabel: "Upper case",
    capsHint: "Percent of letters in caps. The floor is 50 — below half, ordinary emphatic typing trips it.",
    minLengthLabel: "Only messages at least",
    minLengthHint: "Characters. Short messages are exempt so “OK” doesn't count as shouting.",
    allowlistLabel: "Allowed hosts",
    allowlistHint: "Comma-separated hostnames, up to {max}. Leave empty to catch every link.",
    errAllowlist: "At most {max} hosts.",
    errWhole: "Enter a whole number between {min} and {max}.",

    errNoRuleName: "Give the rule a name.",
    errNoSurface: "Pick at least one surface.",
    errNoPattern: "A pattern rule needs a pattern.",
    errFlagOnlyWordlist:
      "A flag-only wordlist rule duplicates the chat filter — give it an action or delete the message.",

    /** The badge on a collapsed rule row: what it does, in two words. */
    describeMute: "mute",
    describeMuteFor: "mute {span}",
    describeDelete: "{action} + delete",

    testIntro:
      "Nothing is written and nobody is punished — the answer below is what would have happened. The message itself is never recorded, which is the point: testing a slur rule should not file the slur in the audit log.",
    testPlaceholder: "Paste a message to run the rules against",
    testMessageLabel: "Message",
    testAsIfLabel: "As if sent",
    testAsIfDiscord: "in Discord",
    testAsIfGuildChat: "in guild chat",
    testMentionsLabel: "Mentions in it",
    testMentionsAria: "Mentions in the message",
    testCounterAria: "Counter for {rule}",
    testCounterLabel: "Already counted for “{rule}”",
    testRun: "Test it",
    errNoTestText: "Type a message to test.",
    errTestMentions: "Mentions must be a whole number from 0 to 100.",
    errTestCounters: "Counters must be whole numbers.",

    cooldownsIntro:
      "Every command ships with a cooldown its author chose. These override that: a guild-wide default, plus the handful of commands you actually care about.",
    defaultLabel: "Default command cooldown",
    /** Blank is "whatever the command shipped with", which is not zero. */
    defaultHint:
      "Seconds, 0–{max}. Blank leaves each command on the number it shipped with, which is not the same as 0.",
    errDefault: "Enter 0–{max} seconds, or leave it blank.",
    relayLabel: "Between relayed messages",
    relayHint:
      "Seconds one member waits between messages the bridge relays, 0–{max}. 0 disables it. This sits on top of flood control, which protects the bridge account from Hypixel's own limit and is deliberately not settable here.",
    errRelay: "Enter 0–{max} seconds.",
    overridesHeading: "Per-command overrides",
    noOverrides: "No per-command overrides. Every command uses the default above.",
    noCooldown: "no cooldown",
    overrideNamePlaceholder: "command name, e.g. networth",
    overrideNameAria: "Command name",
    overrideSecondsPlaceholder: "seconds",
    overrideSecondsAria: "Seconds",
    addOverride: "Add override",
    errCommandName: "That is not a command name.",
    errCommandSeconds: "Enter a whole number of seconds between 0 and {max}.",
  },

  /**
   * The chat filter and the two automatic ladders beside it — the parts of
   * moderation that act on a member with nobody in the loop.
   *
   * The rule *patterns* are never copy: they are the guild's own list of slurs
   * and scam URLs. What is here is everything said *about* a rule, including the
   * four verdict hints, which are the only place the panel explains that a
   * shadow mute does not tell the sender.
   */
  filter: {
    intro:
      "Rules run on every message the bridge relays, in severity order — the harshest verdict among the matches is the one applied. Test a phrase against the live set with /filter-test before saving it.",
    cardEscalation: "Repeat warnings",
    cardRelaySync: "In-game punishment sync",
    cardCreate: "Add a rule",
    cardRules: "Rules",
    /** What each verdict does to a message, in the relay's terms. */
    action: {
      FLAG: "Relayed as written, and recorded for staff to look at.",
      REPLACE: "Relayed with the match censored.",
      BLOCK: "Not relayed at all.",
      SHADOW_MUTE: "Not relayed, and the sender is not told.",
    },
    /** How a pattern is compared. Named, not derived, so "regex" can be reworded. */
    matchOption: {
      EXACT: "exact",
      SUBSTRING: "substring",
      REGEX: "regex",
      WILDCARD: "wildcard",
    },
    actionOption: {
      BLOCK: "block",
      FLAG: "flag",
      REPLACE: "replace",
      SHADOW_MUTE: "shadow mute",
    },
    liveLabel: "Live",
    liveHint: "Off leaves the rule here but stops it matching. Use this before removing one.",
    liveBadge: "live",
    offBadge: "off",
    patternLabel: "Pattern",
    patternHint: "What to match. Regex is compiled as written; wildcard takes * and ?.",
    /** `{max}` is the mutation layer's own cap. */
    errPattern: "Enter a pattern up to {max} characters.",
    matchLabel: "Match",
    matchHint: "How the pattern is compared against the message.",
    verdictLabel: "Verdict",
    verdictHint: "What the relay does when it matches.",
    severityLabel: "Severity",
    severityHint: "1–{max}. Higher wins when a message trips more than one rule.",
    errSeverity: "Enter a whole number between 1 and {max}.",
    remove: "Remove",
    removeConfirm: "Confirm remove",
    createNote: "An identical pattern and match type is refused as a duplicate — edit the existing rule instead.",
    createPatternPlaceholder: "the word or pattern to catch",
    createSeverityPlaceholder: "1",
    create: "Add rule",
    escalationHint:
      "When a warning brings a member to one of these counts, the platform applies the step itself, attributed to the staffer who warned. Warnings older than the window stop counting.",
    escalateLabel: "Escalate automatically",
    escalateHint: "Off leaves /warn as a record only. The ladder below is kept either way.",
    windowLabel: "Window",
    windowHint: "How many days a warning counts for, 1–{max}. Longer means one bad week follows a member further.",
    errWindow: "Enter a whole number of days between 1 and {max}.",
    /** One rung, e.g. "3 warnings → mute for 1 hour". */
    rung: "{warns} {warnWord} → {action} {how}",
    warnOne: "warning",
    warnMany: "warnings",
    rungAction: { MUTE: "mute", BAN: "ban" },
    /** A punishment with no end. Said plainly, because it is the harsh one. */
    rungPermanent: "permanently",
    rungFor: "for {span}",
    rungBuiltIn: "built-in",
    rungCustom: "custom",
    addRungHint: "Add a step: warnings, then seconds (blank for permanent, bans only).",
    warnsPlaceholder: "3",
    warnsLabel: "Warnings",
    durationPlaceholder: "3600",
    durationLabel: "Duration in seconds",
    thenLabel: "Then",
    addRung: "Add step",
    errRungLimit: "A ladder holds up to {max} steps.",
    errRungWarns: "Enter a warning count between 1 and 100.",
    errRungDuplicate: "There is already a step at {warns} warnings.",
    errRungDuration: "Enter a whole number of seconds, or leave it blank for permanent.",
    /** An endless mute is refused outright rather than stored and forgotten. */
    errRungEndlessMute: "A mute needs a duration — an endless mute is refused.",
    relaySyncHint:
      "A punishment issued here can be carried into the Hypixel guild by the bridge account. Only members with a linked account can be matched to an IGN — an unlinked member is punished on Discord and nowhere else, which the audit log records.",
    relaySyncLabel: "Carry punishments into guild chat",
    relaySyncFieldHint: "Off leaves every row below stored but inert.",
    /** The other direction is best-effort, and says so rather than implying parity. */
    relaySyncReverseNote:
      "The other direction is best-effort: Hypixel announces some in-game moderation in guild chat and not all of it, so actions taken in-game appear in the history when the bridge saw them announced.",
    /** `{action}` is the Discord punishment this row answers. */
    rowLabel: "On {action}",
    /** What each in-game mapping does, in the guild's terms. */
    gameAction: {
      none: "Nothing happens in the Hypixel guild.",
      "g mute": "The member is muted in guild chat.",
      "g unmute": "The member's guild-chat mute is lifted.",
      "g kick": "The member is removed from the Hypixel guild.",
    },
    gameActionLabel: {
      none: "nothing",
      "g mute": "mute in the guild",
      "g unmute": "unmute in the guild",
      "g kick": "kick from the guild",
    },
    inGuildChatLabel: "In guild chat",
    durationModeLabel: "For how long",
    durationModeSame: "the same as the Discord punishment",
    durationModeFixed: "a fixed length",
    lengthLabel: "Length",
    lengthHint: "Seconds. Hypixel caps a guild mute at 30 days.",
    errLength: "Enter a whole number of seconds between 1 and {max}.",
  },
  /**
   * Tickets.
   *
   * A type's *key* is never here — it is what a member types into `/ticket` and
   * what a guild's own row joins on, so it is data. Its name is copy, and the
   * two moving independently is the whole point of the split.
   */
  tickets: {
    title: "Tickets",
    /** `{count}` open right now; the queue is the part with a clock on it. */
    subtitle: "{count} open",
    /** The same line once the menu is visible too. */
    subtitleConfigured: "{count} open \u00b7 {offered} of {total} categories on offer",
    cardQueue: "Open tickets",
    cardCategories: "Categories",
    cardPanels: "Panels",
    cardTags: "Canned replies",
    cardSettings: "Settings",
    intro:
      "Members open a ticket from a panel, or with /ticket. Switching every category off closes ticketing without removing the history \u2014 the command then says so rather than opening one nobody watches.",
    /** Where a ticket is in its life. */
    status: {
      OPEN: "open",
      PENDING: "pending",
      RESOLVED: "resolved",
      CLOSED: "closed",
    },

    // ── queue ──
    /** A ticket with no topic, named by its category. `{category}` may be "\u2014". */
    untitled: "{category} ticket",
    /** `{when}` is a relative time, e.g. "2 hours ago". */
    openedAt: "opened {when}",
    by: "by ",
    assigned: " \u00b7 assigned to ",
    unassigned: " \u00b7 unassigned",
    /** `{who}` is a Discord id. Shown only once somebody has claimed it. */
    claimedBy: " \u00b7 claimed by ",
    /** Deliberately a dash, never "0": nobody has answered yet. */
    noReply: "no staff reply yet",
    /** `{when}` is relative. */
    firstReply: "first reply {when}",
    closeReason: "Closing note (optional)",
    close: "Close ticket",
    closeConfirm: "Confirm close",
    claim: "Claim",
    transferLabel: "Transfer to",
    transferPlaceholder: "pick a member",
    resendTranscript: "Re-send transcript",
    /** Shown on a closed ticket whose transcript was rendered. */
    transcriptReady: "transcript ready",

    // ── categories ──
    categoriesNote:
      "A category is what a member picks. The five here on a fresh install are seeded rows, not built-ins \u2014 rename or remove any of them.",
    remove: "Remove",
    removeConfirm: "Confirm remove",
    offeredLabel: "Offered",
    offeredHint: "Off removes it from every panel and from /ticket. Open tickets under it are untouched.",
    nameLabel: "Name",
    nameHint: 'What a member sees in the menu, e.g. "Report a member".',
    errName: "Enter a name up to 80 characters.",
    descriptionLabel: "Description",
    descriptionHint: "The line under the name in a select menu. Discord cuts it off past 100 characters.",
    errDescription: "Keep it under 100 characters.",
    emojiLabel: "Emoji",
    emojiHint: "Shown on the button or menu row. Blank for none.",
    openingLabel: "Opening message",
    openingHint:
      "Posted in the new channel. {num} {name} {nick} {avgRating} {avgResponseTime} {avgResolutionTime} are expanded.",
    errOpening: "Keep it under 2000 characters.",
    templateLabel: "Channel name",
    templateHint: "How the channel is named. {num} is the ticket's number, {name} the opener.",
    errTemplate: "Enter a template up to 100 characters.",
    parentLabel: "Category channel",
    parentHint: "Category new tickets open under. Clear it to use the server default.",
    parentPlaceholder: "server default",
    staffLabel: "Staff roles",
    staffHint: "Roles pulled into these tickets. None means the server-wide staff role only.",
    staffPlaceholder: "add a role",
    requiredLabel: "Required roles",
    requiredHint: "A member needs every one of these to open it. None means anyone may.",
    pingLabel: "Ping roles",
    pingHint: "Pinged when one opens. None means no ping.",
    errRoles: "Up to {max} roles.",
    positionLabel: "Menu position",
    positionHint: "Lower sorts first. Ties fall back to the name.",
    claimingLabel: "Claimable",
    claimingHint: "Lets one staff member take a ticket, hiding it from the rest until released.",
    memberLimitLabel: "Per-member limit",
    memberLimitHint: "How many of these one member may have open at once.",
    totalLimitLabel: "Total limit",
    totalLimitHint: "Discord allows 50 channels under one category, so 50 is the ceiling.",
    cooldownLabel: "Cooldown (seconds)",
    cooldownHint: "How long after closing one before the same member may open another. Blank for none.",
    slowModeLabel: "Slow mode (seconds)",
    slowModeHint: "Applied to the ticket channel. Blank for none; Discord's ceiling is 6 hours.",
    requireTopicLabel: "Ask for a topic",
    requireTopicHint: "Asks one free-text question before opening. Ignored when the category asks questions.",
    errNumber: "Enter a whole number, or leave it blank.",

    // ── panels ──
    panelsNote:
      "A panel is the message members click. Publishing posts it once and edits it in place afterwards \u2014 it never leaves a second copy behind.",
    panelUnposted: "Not published yet.",
    /** `{channel}` is where it currently lives. */
    panelPosted: "Published in {channel}. Publishing again edits that message rather than posting another.",
    panelSomeChannel: "a channel",
    panelNameLabel: "Panel name",
    panelNameHint: "For your own reference. Members never see it.",
    errPanelName: "Enter a name up to 80 characters.",
    panelChannelLabel: "Channel",
    panelChannelHint: "Where the panel is posted. It must be set before you can publish.",
    panelChannelPlaceholder: "not published",
    panelTitleLabel: "Title",
    panelTitleHint: "Heading on the panel embed.",
    errPanelTitle: "Enter a title up to 120 characters.",
    panelDescriptionLabel: "Description",
    panelDescriptionHint: "The paragraph under the heading. Blank for none.",
    errPanelDescription: "Keep it under 2000 characters.",
    panelStyleLabel: "Style",
    panelStyleHint: "Buttons take up to 5 categories, a select menu up to 25.",
    styleButtons: "Buttons",
    styleSelect: "Select menu",
    panelCategoriesLabel: "Categories",
    panelCategoriesHint: "Which categories this panel offers, in the order they appear.",
    publish: "Publish",
    publishConfirm: "Confirm publish",
    createPanel: "Add panel",
    createPanelNamePlaceholder: "e.g. Support desk",
    createPanelTitlePlaceholder: "e.g. Need a hand?",

    // ── tags ──
    tagsNote:
      "A canned reply staff can drop into a ticket. Give it a pattern and the bot posts it itself when a message matches.",
    tagNameLabel: "Name",
    tagNameHint: "What staff type to use it.",
    errTagName: "Enter a name up to 40 characters.",
    tagContentLabel: "Reply",
    tagContentHint: "What gets posted.",
    errTagContent: "Keep it under 2000 characters.",
    tagPatternLabel: "Auto-reply pattern",
    tagPatternHint: "A regular expression. Blank means staff-triggered only.",
    errTagPattern: "That is not a valid regular expression.",
    tagEnabledLabel: "Enabled",
    tagEnabledHint: "Off keeps the reply but stops it firing.",
    createTag: "Add reply",
    createTagNamePlaceholder: "e.g. refund",
    createTagContentPlaceholder: "What should it say?",

    // ── settings ──
    settingsNote: "Applies to every category unless a category overrides it.",
    archiveLabel: "Keep transcripts",
    archiveHint: "Off stops recording messages. Tickets closed while off have no transcript at all.",
    logChannelLabel: "Log channel",
    logChannelHint: "Where opens, claims and closes are announced. Clear it for none.",
    logChannelPlaceholder: "no log",
    blocklistLabel: "Blocked roles",
    blocklistHint: "Members with any of these cannot open a ticket.",
    footerLabel: "Embed footer",
    footerHint: "Appears at the bottom of every ticket embed. Blank for none.",
    errFooter: "Keep it under 2048 characters.",
    staleLabel: "Stale after (minutes)",
    staleHint: "Silence this long marks a ticket stale. Blank means no staleness clock at all.",
    autoCloseLabel: "Auto-close after (minutes)",
    autoCloseHint: "How long a pending-closure ticket waits before closing itself.",
    closeButtonLabel: "Close button",
    closeButtonHint: "Shows a close button in every ticket channel.",
    claimButtonLabel: "Claim button",
    claimButtonHint: "Shows a claim button in every ticket channel.",

    // ── shared ──
    createNote: "Reusing an existing key edits that category instead of adding another one.",
    createKeyPlaceholder: "e.g. staff-app",
    createKeyLabel: "Category key",
    createNamePlaceholder: "e.g. Staff application",
    createNameLabel: "Category name",
    create: "Add category",
    errKey: "Keys are lowercase, e.g. staff-app.",
    errNoName: "Give it a name.",
    /** No category rows at all \u2014 distinct from every category switched off. */
    noCategories: "No categories yet. Add one and it appears in /ticket straight away.",
    noPanels: "No panels yet.",
    noTags: "No canned replies yet.",
  },
  /**
   * Settings, which absorbed the old Mapping and XP pages.
   *
   * The screening bars are worded "blank for no requirement" rather than
   * "0 for none" on purpose: a blank bar and a zero bar are different policies,
   * and copy that blurs them invites an admin to type the one that gates
   * everybody out.
   */
  settings: {
    title: "Settings",
    subtitle: "Channels, roles and guild configuration.",
    /** `{count}` slots have no channel bound. */
    subtitleUnset: "{count} channel slot(s) not set",
    subtitleAllSet: "All channel slots assigned",
    noConfig: "This guild has no configuration row yet. Run any staff command once to create it, then reload.",
    cardGuild: "Guild",
    cardBridge: "Bridge",
    cardChannels: "Channels",
    cardFeatures: "Feature flags",
    cardScreening: "Join screening",
    channelUnset: "not set",
    suspendLabel: "Suspend the Discord ↔ in-game bridge",
    suspendHint: "Stops relaying in both directions without taking the bot offline. Commands keep working.",
    featureAddLabel: "Add a flag",
    featureAddHint: "Lowercase letters, digits and dashes. Created enabled; toggle it off above afterwards.",
    featureAddPlaceholder: "events",
    errFeatureName: "Use 2–40 lowercase letters, digits or dashes, starting with a letter.",
    screenEnabledLabel: "Screen join requests",
    screenEnabledHint: "Off means the bot still records every request but decides nothing.",
    autoAcceptLabel: "Auto-accept clean requests",
    autoAcceptHint:
      "Sends /guild accept when a request passes. Leave off for a week first and read what it would have done.",
    denyScammerLabel: "Deny listed scammers",
    denyScammerHint: "A SkyKings match is refused outright rather than queued.",
    holdScammerLabel: "Hold when the scammer list is unreachable",
    holdScammerHint: "An outage should not read as a clean record.",
    denyExpelledLabel: "Deny previously kicked or banned players",
    denyExpelledHint: "Checked against this guild's own record.",
    holdUnreadableLabel: "Hold when the account's stats can't be read",
    holdUnreadableHint: "Usually an applicant with their API off.",
    // The stat-bar labels lived here — level, skill average, catacombs, weight,
    // networth, account age and inactivity, plus the shared "no requirement"
    // placeholder. The bars are gone: the scam check is the guild's only entry
    // requirement, so screening has switches and counters and no thresholds.
    riskLabel: "Hold at risk score",
    riskHint: "0–100. A request that passes every rule but scores at or above this still waits for a human.",
    repeatWindowLabel: "Repeat window (days)",
    repeatWindowHint: "1–365. How far back repeat attempts are counted.",
    attemptsLabel: "Attempts allowed in that window",
    attemptsHint: "1–100. Beyond this, the request waits for a human.",
    hypixelLabel: "Hypixel guild",
    hypixelHint:
      "The guild whose roster syncs here. Enter its name or its 24-character id; clear the field to unlink. Nothing syncs until this is set.",
    hypixelPlaceholder: "Guild name or id",
    timezoneLabel: "Timezone",
    timezoneHint: "Used for event schedules and daily rollups. Change with /set-timezone.",
    prefixesLabel: "Command prefixes",
    prefixesHint: "In-game chat prefixes the bridge answers to.",
  },
  /**
   * Permissions.
   *
   * Level names are *not* here: they are per-guild data the Levels card writes,
   * so the page derives them from the stored value. What is here is everything
   * the page says *about* a level — including the rule that a denial beats a
   * grant, which is the one sentence on the page that prevents a real mistake.
   */
  permissions: {
    title: "Permissions",
    subtitle: "Who is staff, and what staff means",
    intro:
      "A member's level is the highest of what their Discord roles and their in-game rank give them. Levels grant capabilities; an exception overrides a level for one subject, and a denial there beats every grant and every level.",
    cardLevels: "Levels",
    cardRanks: "In-game ranks",
    cardCapabilities: "Bridge capabilities",
    cardCommands: "Command access",
    cardExceptions: "Exceptions",
    levelsHint:
      "Holding any of a level's roles puts a member at that level. Someone with roles at two levels gets the higher one. Members with none of these roles are at the base level.",
    /** `{article}` is "a" or "an" for `{level}`, which is the guild's own name for it. */
    levelHint: "Discord roles that make someone {article} {level}.",
    ranksHint: "Ranks are matched case-insensitively against the guild scan. A rank that isn't mapped confers nothing.",
    rankPlaceholder: "the rank's name in game",
    rankLabel: "In-game rank",
    rankAdd: "Map rank",
    rankGives: "Gives",
    rankLevel: "Level",
    rankUnmap: "Unmap",
    rankUnmapConfirm: "Confirm unmap",
    /** `{max}` is the longest rank name the mutation accepts. */
    errRankName: "Enter a rank name of up to {max} characters.",
    capabilitiesHint:
      "Every level at or above the floor holds the capability. ADMIN cannot be lowered below Admin, which is what stops this page from being used to give it away.",
    /** What holding each capability actually lets someone do, in the guild's terms. */
    capability: {
      RELAY_MESSAGE: "Speak through the bridge — their Discord messages reach guild chat.",
      RUN_COMMAND: "Run bot commands from guild chat.",
      MENTION: "Have @mentions survive the relay instead of being flattened.",
      BYPASS_FILTER: "Skip the chat filter entirely, in both directions.",
      BYPASS_COOLDOWN: "Skip relay and command cooldowns.",
      ADMIN: "Administrative bridge control. Only ever an Admin.",
    },
    /** `{default}` is the level the platform ships the row at. */
    platformDefault: "Platform default: {default}.",
    commandsHint:
      "Leave a command on its default unless you have a reason — the defaults are what the handlers were written against, and lowering one is how a destructive command reaches someone it wasn't meant for.",
    /** `{description}` is the command's own, `{default}` its shipped floor. */
    commandHint: "{description} Default: {default}.",
    /** The blank option: the command keeps whatever floor it ships with. */
    commandDefaultOption: "default — {default}",
    exceptionsHint:
      "An exception overrides the level for one subject. A denial wins over every grant and every level — removing a row is not the same as denying it, and restores whatever the level said.",
    subject: {
      DISCORD_USER: "one person",
      DISCORD_ROLE: "a Discord role",
      GUILD_RANK: "an in-game rank",
    },
    subjectLabel: "Applies to",
    subjectAria: "Member or role",
    subjectPlaceholder: "search members",
    subjectHint: "Search picks a member; a Discord role or in-game rank can be typed in by hand.",
    capabilityLabel: "Capability",
    effectLabel: "Effect",
    effectGrant: "grant it",
    effectDeny: "deny it",
    exceptionAdd: "Add exception",
    errNoSubject: "Choose who this applies to.",
    granted: "granted",
    denied: "denied",
    remove: "Remove",
    removeConfirm: "Confirm remove",
    colAppliesTo: "Applies to",
    colSubject: "Subject",
    colCapability: "Capability",
    colEffect: "Effect",
  },
  /**
   * The XP section of Settings.
   *
   * `source` is keyed by the `XpSource` enum rather than by prose, so a guild
   * that renames "Guild XP" changes one key and the fallback below still covers
   * a source the platform gains before this table names it.
   */
  xp: {
    title: "XP",
    subtitle: "Where XP comes from and what it's worth.",
    card: "XP",
    /** `{label}` is the source's own name. */
    cardSource: "XP — {label}",
    cardAdjust: "Adjust a member's XP",
    /** `{on}` of `{total}` sources are counting. */
    intro:
      "{on} of {total} sources counting. Changes apply from the next totalling pass onwards; days already scored keep the numbers they were scored under.",
    source: {
      GEXP: { label: "Guild XP", unit: "one unit per guild XP earned that day" },
      DISCORD_MESSAGE: { label: "Discord messages", unit: "one unit per counted message" },
      GUILD_CHAT_MESSAGE: { label: "Guild chat messages", unit: "one unit per counted message" },
      TENURE: { label: "Tenure", unit: "one unit per day in the guild" },
      COMMAND_USAGE: { label: "Command use", unit: "one unit per counted command" },
      EVENT: { label: "Events", unit: "one unit per event attended" },
      MILESTONE: { label: "Milestones", unit: "one unit per XP a milestone definition awards" },
      MANUAL: { label: "Staff adjustments", unit: "one unit per XP entered by hand" },
    },
    /** Used when a source has no entry above; the key stands in for the name. */
    sourceUnitFallback: "one unit per recorded action",
    enabledLabel: "Counts towards XP",
    /** `{unit}` is the source's unit line. */
    enabledHint: "Weight is {unit}.",
    weightLabel: "Weight",
    weightHint: "XP awarded per unit — {unit}. Fractions are allowed.",
    capLabel: "Daily cap",
    capHint: "Most XP one member can earn from this source in a day. Clear it for no cap.",
    capPlaceholder: "no cap",
    cooldownLabel: "Cooldown (seconds)",
    cooldownHint: "Minimum gap between two actions that count. 0 counts every one.",
    minLengthLabel: "Minimum message length",
    minLengthHint:
      "Shorter messages are ignored entirely. Keeps “gg” from being worth the same as a conversation.",
    /** `{max}` is the bound the mutation layer enforces. */
    errNumberRange: "Enter a number between 0 and {max}.",
    errWholeNumber: "Enter a whole number.",
    adjustIntro: "Adds or removes XP directly. Positive credits, negative deducts.",
    adjustMemberPlaceholder: "Search by name, or paste an id",
    adjustMemberLabel: "Member to adjust",
    adjustAmountPlaceholder: "e.g. 500 or -250",
    adjustAmountLabel: "XP amount, negative to deduct",
    adjustReason: "Why — this is stored on the member's XP history, not just the audit log.",
    adjustApply: "Apply adjustment",
    adjustConfirm: "Confirm adjustment",
    errNoMember: "Pick the member, or paste their Discord user id.",
    /** `{max}` is the largest adjustment in either direction. */
    errAmount: "Enter a non-zero whole number within ±{max}.",
    errNoReason: "A reason is required.",
  },
  leaderboard: { title: "Leaderboard", subtitle: "Guild standings." },
};

export type Panel = typeof DEFAULT_PANEL;
