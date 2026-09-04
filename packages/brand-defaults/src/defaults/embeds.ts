/**
 * Embed copy: card titles, footers, tone words and the placeholder text.
 *
 * The words here are the ones that repeat across cards. A title that belongs to
 * exactly one card is still a key — that is decision 2, exhaustive coverage — but
 * the shared vocabulary lands first because it is what makes the cards read as
 * one product rather than as several.
 */

export const DEFAULT_EMBEDS = {
  /**
   * What a missing value prints as, everywhere. Never "N/A", and never a silent
   * zero: a zero that means "we don't know" is the specific dishonesty the
   * platform's own rules forbid.
   */
  unknown: "—",

  /** Tone words, so a state reads the same on a card as it does in the panel. */
  tone: {
    ok: "OK",
    warn: "Warning",
    bad: "Failing",
    neutral: "Unknown",
  },

  /** Footers that appear on more than one card. */
  footer: {
    stale: "Data as of {at}",
    estimate: "Estimated",
    partial: "Some sources didn't answer; figures may be incomplete.",
  },

  /**
   * Field names that appear on more than one card.
   *
   * SkyBlock level, skill average and catacombs are on `/profile`, on `/stats`
   * and on the profile card, and before this they were three separate literals
   * that had already drifted once — "Slayer XP" on one card and "Slayer xp" on
   * another. One key each is the only way that stays fixed.
   */
  field: {
    skyblockLevel: "SkyBlock Level",
    skillAverage: "Skill average",
    /** The twelve skills as two lists: the ones the average counts, and the rest. */
    skills: "Skills",
    cosmeticSkills: "Cosmetic",
    /** The uncapped skill with the least XP left — the one worth an hour tonight. */
    closest: "Closest to next",
    catacombs: "Catacombs",
    /* ── /whois and /serverinfo ── */
    account: "Account",
    thisServer: "This server",
    /** The Hypixel half of the member card, consolidated. */
    skyblock: "SkyBlock",
    events: "Events",
    roles: "Roles",
    link: "Link",
    counts: "Counts",
    boosts: "Boosts",
    owner: "Owner",
    created: "Created",
    classAverage: "Class average",
    selected: "Selected",
    weight: "Weight",
    networth: "Networth",
    slayerXp: "Slayer xp",
    magicalPower: "Magical power",
    progress: "Progress",
    guildStanding: "Guild standing",
    achievements: "Achievements",
    leaderboards: "Leaderboards",
    yourRecord: "Your record",
    rank: "Rank",
    tenure: "Tenure",
    lastEarned: "Last earned",

    /* ── the event card ── */
    /** The consolidated block of small facts: when, who, how many, what for. */
    details: "Details",
    starts: "Starts",
    started: "Started",
    ends: "Ends",
    ended: "Ended",
    host: "Host",
    signedUp: "Signed up",
    prize: "Prize",
    /** The way out of the message and into Discord's own event. */
    reminder: "Reminder",
    /** What the event measures — one metric, or nothing. */
    scoring: "Scoring",
    /** Who is coming, while signups are the point of the message. */
    roster: "Who's coming",
    /** The leaderboard, once there is something to rank. */
    standings: "Standings",
    /**
     * The signed-up members nothing can score.
     *
     * Named without their count, deliberately: the number belongs in the value,
     * because a heading that reads "(1)" one minute and "(4)" the next is a
     * heading that changes under the reader.
     */
    notScored: "Not scored",
    whereFrom: "Where it came from",
    snapshots: "Snapshots",
    /** `/networth`: the vertical category list, and the sections behind it. */
    breakdown: "Where it is",
    notCounted: "Not counted",
    mostValuable: "Most valuable",
    pace: "Pace",
    target: "Target",
    trend: "Trend",
    goal: "Goal",

    /* ── market ── */
    /** `{range}` is the window in words — "24 hours", "7 days", "30 days". */
    priceNow: "Right now",
    priceVolume: "Moving",
    priceHistory: "History",
    cheapestListings: "Cheapest listings",
    /** `/serverinfo`: the server's shape, and the week behind it. */
    members: "Members",
    server: "Server",
    messagesWeek: "Messages this week",
    busiestWeek: "Busiest this week",
    /* Trigger reposts. "Context" is one field holding the count, the
       channel and the jump link, rather than three fields of one fact. */
    context: "Context",
    reactions: "Reactions",
    channel: "Channel",
    source: "Source",
    attachments: "Attachments",

    // Join notices. Four names for four questions a reviewer asks in order:
    // what are they like, what did we find, what do we already know about them,
    // and how long do I have. Each holds several facts, because a reviewer
    // reads a notice once and decides — not a card of eleven one-word fields.
    findings: "Findings",
    history: "History",
    window: "Window",
    /* -- perms -- */
    /** The roster itself: one line per seat, never one field per seat. */
    party: "Party",
    seats: "Seats",
    notes: "Notes",
    /** The perms a guild has, as lines inside one field. */
    perms: "Perms",
    /* -- lfg -- */
    /** What is being run: "Master Mode 7", not "M7" — the card has the room. */
    floor: "Floor",
    /** The classes the requester is short of. Never "Roles": people say class. */
    wanted: "Looking for",
    /** What the requester themselves brings — the class they run, and its level. */
    plays: "Plays",
  },

  /**
   * The same field names again, cut down for guild chat.
   *
   * Minecraft's chat packet stops at 256 characters, so a card that reads
   * comfortably in Discord spends most of that budget on its own labels:
   * "SkyBlock Level: 210 | Skill average: 41.2 | Catacombs: 38" is 57
   * characters of which 38 are words the reader already knows. In game these
   * become "SBL 210 | SA 41.2 | Cata 38" and the numbers get the room.
   *
   * Keyed identically to `field` on purpose — the in-game renderer looks a
   * rendered field name up in `field` to find its key, then prints the short
   * form — so a key here with no twin there is dead weight and a field with no
   * short form simply keeps its full name. `brand check` holds the two in step.
   */
  fieldShort: {
    skyblockLevel: "SBL",
    skillAverage: "SA",
    catacombs: "Cata",
    classAverage: "CA",
    selected: "On",
    weight: "Wt",
    networth: "NW",
    slayerXp: "Slayer",
    magicalPower: "MP",
    progress: "Prog",
    guildStanding: "Standing",
    achievements: "Achv",
    leaderboards: "Boards",
    yourRecord: "Best",
    rank: "Rank",
    tenure: "Tenure",
    lastEarned: "Last",
    whereFrom: "From",
    snapshots: "Snaps",
    pace: "Pace",
    target: "Goal",
    trend: "Trend",
    goal: "Goal",
    party: "Party",
    seats: "Seats",
    owner: "Owner",
    notes: "Notes",
    perms: "Perms",
    floor: "Floor",
    wanted: "Want",
    plays: "Plays",
  },

  /**
   * How a card is spoken aloud in guild chat.
   *
   * Deliberately *not* `FLATTEN_SEPARATOR` (" \u00b7 "), which is what the
   * Discord-side flattener uses. A middle dot is a legible separator in a
   * proportional font on a bright background; in Minecraft's chat font, over
   * whatever the player happens to be standing in front of, it is a speck.
   * The pipe is the shape COMMANDS.md documents for this surface and the shape
   * players already read it as, so the two surfaces differ on purpose and the
   * reason is written down here rather than looking like drift.
   */
  ingame: {
    /** Between fields, and the seam a too-long line is cut on. */
    separator: " | ",
    /** Between the title, the body, and the footer. */
    join: " \u2014 ",
    /** The footer is parenthesised so it doesn't read as another field. */
    footerOpen: "(",
    footerClose: ")",
    /** Marks a line that was cut. One character, because every one counts. */
    ellipsis: "\u2026",
  },

  /**
   * The same metrics again, but sentence-cased, because these are read *inside*
   * a sentence: "gains in networth", not "gains in Networth".
   *
   * A separate vocabulary from `field` rather than a casing rule applied to it.
   * "SkyBlock" keeps its capital in both — it is a proper noun and the lowercase
   * form is simply wrong — which no `toLowerCase()` would have got right, and
   * which is the whole reason these are written out.
   */
  metricPhrase: {
    skyblockLevel: "SkyBlock level",
    networth: "networth",
    skillAverage: "skill average",
    catacombsLevel: "catacombs level",
    slayerXp: "slayer XP",
    senitherWeight: "weight",
    // Per-class dungeon levels. Written as the game writes them — "healer
    // level", not "class healer" — because that is what somebody would say out
    // loud, and this table exists for the places a metric lands mid-sentence.
    classHealer: "healer level",
    classMage: "mage level",
    classBerserk: "berserk level",
    classArcher: "archer level",
    classTank: "tank level",
    // Per-boss slayer XP. The boss's own name rather than the mob's, since that
    // is how the slayer menu labels them and how people ask for carries.
    slayerZombie: "Revenant XP",
    slayerSpider: "Tarantula XP",
    slayerWolf: "Sven XP",
    slayerEnderman: "Voidgloom XP",
    slayerBlaze: "Inferno XP",
    slayerVampire: "Riftstalker XP",
    bestiaryMilestone: "bestiary milestone",
    // Per-skill levels. "mining level", not "skill mining" — the same rule as
    // the dungeon classes above, and for the same reason.
    skillFarming: "farming level",
    skillMining: "mining level",
    skillCombat: "combat level",
    skillForaging: "foraging level",
    skillFishing: "fishing level",
    skillEnchanting: "enchanting level",
    skillAlchemy: "alchemy level",
    skillTaming: "taming level",
    skillHunting: "hunting level",
    skillCarpentry: "carpentry level",
    // Collections. Plural nouns, because these land in sentences as counts
    // ("gained 12 fairy souls") rather than as levels.
    fairySouls: "fairy souls",
    museumDonations: "museum donations",
    petScore: "pet score",
    minionSlots: "minion slots",
    essence: "essence",
  },

  /**
   * How an activity is named on a card.
   *
   * `LFGActivity` is an enum shouted in SCREAMING_CASE, and `toLowerCase()` was
   * the old answer — which is why a party card said "dungeons" while every other
   * surface in the product said "Dungeons". A table rather than a casing rule,
   * for the same reason `metricPhrase` is one: the right casing is a fact about
   * each word, not a transform.
   */
  activity: {
    DUNGEONS: "Dungeons",
    KUUDRA: "Kuudra",
    SLAYERS: "Slayers",
    FISHING: "Fishing",
    MINING: "Mining",
    OTHER: "Other",
  },

  /**
   * How each XP source is named to a member — the member's word, not the enum's.
   *
   * Nobody earns "GUILD_CHAT_MESSAGE"; they talk in guild chat. `MANUAL` says
   * "staff adjustment" rather than anything that implies it was earned, because
   * dressing up an adjustment is exactly what makes people distrust the number.
   */
  xpSource: {
    GEXP: "Guild XP",
    DISCORD_MESSAGE: "Discord chat",
    GUILD_CHAT_MESSAGE: "Guild chat",
    TENURE: "Tenure",
    COMMAND_USAGE: "Command use",
    EVENT: "Events",
    MILESTONE: "Milestones",
    MANUAL: "Staff adjustment",
  },

  /**
   * `/health` — the one card a member reads when something else went wrong.
   *
   * Every sentence here is written to be read by someone who is already
   * annoyed, so none of them apologise and none of them explain. They say what
   * is true and what to do about it.
   */
  health: {
    title: "Platform status",
    /** The field holding the rows. Not the card title repeated — a field name
     * that echoes the heading above it is a wasted line on a phone. */
    checks: "Checks",
    ok: "Everything is answering.",
    degraded: "Something is slow or partly down. Commands may take longer or return less.",
    down: "Something is down. Commands that need it will fail until it is back.",
    /** `{n}` is a count, never a name — see `curateStatus`. */
    otherUnhealthy: "{n} other component(s) unhealthy.",
    /** What to do next, when there is nothing the member can do. */
    reportHint: "If this is still wrong in a few minutes, open a bug report.",
    unavailable: "Status checks aren't wired up on this deployment.",
  },

  /**
   * Per-card copy: the title pattern, the nouns it takes, and the prose a card
   * prints when it has nothing to show.
   *
   * The titles are one template and a vocabulary rather than fifteen sentences,
   * because every lookup card says the same thing in the same shape — *whose*
   * card, then *what* card — and fifteen literals is fifteen chances for one of
   * them to use a hyphen where the rest use an em dash.
   */
  card: {
    /** `{subject}` is an IGN or a member name; `{noun}` names the card. */
    title: "{subject} — {noun}",
    /** The second half of `title`. Lowercase: it is a noun, not a heading. */
    noun: {
      profile: "profile",
      profiles: "profiles",
      skills: "skills",
      slayers: "slayers",
      dungeons: "dungeons",
      stats: "stats",
      networth: "networth",
      accessories: "accessories",
      achievements: "achievements",
      standing: "standing",
    goals: "goals",
      leaderboard: "guild leaderboard",
    },
    /**
     * Reversed on purpose: an auction card is about an item far more often than
     * about a player, so the item is what a reader should hit first.
     */
    auctions: "Auctions — {subject}",
    /** `{item}` is the item's display name. The one market card. */
    market: "{item}",
    /** `{guild}` is the guild's own name, when the roster carries one. */
    roster: "{guild} — online now",
    /** …and when it does not. Not "Unknown — online now". */
    rosterUnnamed: "Online now",

    /** Empty and unavailable states, per card. */
    noProfiles: "No Skyblock profiles on this account.",
    skillsOff: "This profile's skill API is turned off, so none of it is readable.",
    /** One skill, asked for by name, that this profile does not expose. */
    skillHidden: "Hidden — this profile's skill API is off for this one.",
    /** `{name}` is what the member typed. */
    noSuchSkill: 'No skill called "{name}".',
    noKills: "No recorded kills.",
    noSlayerData: "No slayer data on this profile.",
    /** `{boss}` is the boss the member asked about by name. */
    noSlayerDataFor: "No {boss} slayer data on this profile.",
    noDungeons: "This player has never entered a dungeon.",
    bagUnreadable:
      "Couldn't read this profile's talisman bag — the inventory API is off, so ownership is unknown.",
    nobodyRanked: "Nobody is ranked here yet.",
    nobodyOnline: "Nobody is online right now.",

    /* ── /whois and /serverinfo ── */
    /** What the card is; the author row says who it is about. */
    whois: "Discord profile",
    /** `/me`. Says what the card is; the author row says whose it is. */
    memberCard: "Member card",
    noGateway: "That one needs Discord — I can't see the server from here.",
    noSuchAccount: "Discord has no account with that id.",
    serverUnreadable: "I can't see this server right now. Try again shortly.",
    noRoles: "None",
    /** Names the way out. A member reading this can fix it in one command. */
    notLinked: "Not linked — /link <ign>.",
    unknownOwner: "Unknown",
    noXpYet: "Nothing yet.",
    achievementsOff: "Achievements aren't switched on here.",
    achievementsNone: "This guild hasn't set up any achievements yet.",
    noAdvice: "No suggestions — nothing obvious to improve.",
    genericAdvice: "Couldn't read this profile, so this is general advice rather than advice about you.",
    /** `{subject}` is the item or player searched for. */
    noAuctions: "No active auctions for {subject}.",
    networthHidden: "Unknown — the profile's API settings hide the data this needs.",
    /** `/networth`. The card title; identity is the author row. */
    networth: "Networth",
    networthEstimate: " — estimate, some sections are hidden",
    networthNoCategories: "Nothing on this profile is worth anything yet.",
    networthPick: "Open a category",
    networthOfTotal: "of the total",
    networthNoItems: "The total is readable, the items behind it are not.",
    networthCategoryGone: "That category is empty on this profile now.",

    /* ── market ── */
    /** Neither book quotes it. Not "0 coins": nobody is trading it at any price. */
    marketNoPrice: "Nothing is being bought or sold right now.",
    /** History is context, so its absence is a note on the card, not a failure. */
    marketNoHistory: "No price history for this item yet.",
    /** The history source is down or paused. Says which, because they differ. */
    marketHistoryDown: "Price history is unavailable right now.",
    /** `{n}` is a signed percentage. */
    marketUp: "{n}% above the {range} average",
    marketDown: "{n}% below the {range} average",
    marketFlat: "in line with the {range} average",
    marketPickRange: "Pick a window",
    marketListings: "Listings",
    /** `{item}` is the display name. The sweep may simply not have reached it. */
    marketNoListings: "No buy-it-now listings for {item} in the last auction sweep.",

    /* ── /serverinfo ── */
    /** `{n}` is the member count Discord reports. */
    serverHeadline: "{n} members",
    /** Shown in place of the week's counters when nothing is wired to keep them. */
    serverNoActivity: "Activity isn't being counted here.",
    serverNobodyActive: "Nobody has said anything yet this week.",
    /**
     * `{n}` is the window in days.
     *
     * Both of these name the way out, because the empty state is now something
     * the member fixes rather than something they wait through: the platform
     * keeps one current reading per member, and a chart is built from markers
     * they save (docs/HYPIXEL_COMPLIANCE.md §1).
     */
    noSnapshots: "No markers in the last {n} days. Save one to set a starting point.",
    oneSnapshot: "One marker so far. Save another later and this shows the change between them.",

    /* ── saved snapshots ── */
    /** `{n}` saved, `{limit}` the cap. */
    snapshotSaved: "Marker saved — {n} of {limit}.",
    /** `{n}` is the label they gave it. */
    snapshotSavedNamed: 'Marker saved as "{name}" — {n} of {limit}.',
    snapshotUnchanged:
      "You've already saved this reading. Your numbers refresh about once an hour — try again after the next one.",
    snapshotNoReading:
      "Nothing to save yet — your profile hasn't been read. Link your account and give it an hour.",
    snapshotUnavailable: "Snapshots aren't switched on here.",

    /**
     * Not a staleness footer: standing is recomputed on a cadence rather than
     * fetched, so what a member needs to know is that today is still counting.
     */
    standingFooter: "XP is totalled a few times a day — today's activity may not be in yet.",

    /* ── goals ── */
    noGoals: "No goals set.",
    goalSet: "Tracking your {metric} to {target}.",
    goalCleared: "Cleared your {metric} goal.",
    goalNotSet: "You had no {metric} goal to clear.",
    /** Shown in place of an ETA when there is not enough history to project. */
    goalNoPace: "no pace yet",
    /** `~12d` — days at recent pace, deliberately hedged with the tilde. */
    goalEta: "~{n}d",
    goalDone: "done",
    goalsFooter: "Projections are recent pace extended, not a promise.",

    /* ── /help ── */
    helpTitle: "Member commands",
    /** The first line a member who has not linked reads. It is the next step, not a description. */
    helpUnlinked: "Start with `/link <your IGN>`. Nothing below knows who you are until you do.",
    /** `{ign}` — once linked, the headline stops nagging and confirms instead. */
    helpLinked: "Linked as **{ign}**. Everything below is yours.",
    /** `{n}` — a category too long to print in full. */
    helpMore: "and {n} more",
    helpFooter: "Every command here is ephemeral unless it posts for the guild.",
    /** The six groups, in the order a new member meets them. */
    helpCategory: {
      ACCOUNT: "Your account",
      PROGRESS: "Your numbers",
      MARKET: "The market",
      GUILD: "The guild",
      EVENTS: "Events",
      EXTRAS: "Everything else",
    },
    helpLinkButton: "How do I link?",
    helpLinkTitle: "Linking your account",
    /**
     * The built-in steps. A guild may add its own words underneath but never
     * replace these: a member whose client will not play the recording still
     * needs to be able to read what to do.
     */
    helpLinkSteps:
      "1. In-game, open the SkyBlock menu → **Social Media** → **Discord**.\n" +
      "2. Set it to your Discord username.\n" +
      "3. Back in Discord, run `/link <your IGN>`.",
    /** `{ign}` — a new link. */
    linkDone: "Linked to **{ign}**.",
    /**
     * `{ign}` — `/link` with no argument, which re-runs the check against the
     * account already on file. A different sentence from `linkDone` because it
     * is a different fact: saying "linked" to somebody repairing a link reads
     * as though it had come undone.
     */
    linkConfirmed: "Still linked as **{ign}** — the check passed.",
    /**
     * `{ign}` — the link itself succeeded, but Hypixel would not say whether
     * they are in the guild, so any guild-gated role is still outstanding. Said
     * plainly, because the member's next move is to wait rather than to retry.
     */
    linkPending:
      "Linked to **{ign}**. Hypixel is not answering right now, so your guild roles will arrive shortly.",
    helpLinkFooter: "The check reads your Hypixel social field live — nothing is stored from it.",

    /* ── triggers (starboard and its relatives) ── */
    /** `{label}` — what staff named the rule, so a second board is not mistaken for the first. */
    triggerTitle: "{label}",
    /** `{count}` `{emoji}` — what put the message here. */
    triggerReactions: "{count} × {emoji}",
    /** The link back to the original, which is the whole point of a repost. */
    triggerJump: "Jump to message",
    triggerAttachment: "Attachment on the original",
    triggerEmpty: "*No text — see the original.*",
    triggerFooter: "Reposted by a guild trigger.",

    /* ── /progression ── */
    /** The empty state, before a member has saved anything at all. */
    progressionUntracked:
      "No history yet. Save a marker to fix where you are now; the chart starts at the second one.",
    /** `{metric}` is the phrase, not the key — "no networth goal". */
    progressionNoGoal: "No {metric} goal set.",
    /** The one static note on the card. */
    progressionFooter: "Markers are yours — nothing is charted that you did not save.",
    /** A guild that has narrowed the offered set to nothing sees this, not an empty menu. */
    progressionNoMetrics: "No metrics are switched on here. Check /health.",
    /** The announcement when a goal is reached. Second person: it is their post. */
    goalAchievedTitle: "Goal reached",
    goalAchievedBody: "{ign} set out for {target} {metric} — and got there.",
    /** Per-day movement, e.g. `+2.4/day`. */
    perDay: "{n}/day",

    /* ── join notices ── */
    /**
     * The title says what happened, the headline says what was decided and how
     * confident the platform is about it. Staff scan a channel of these, so the
     * first word has to separate "do something" from "for the record".
     */
    joinReview: "Join request — needs a decision",
    joinAccepted: "Join request — accepted",
    joinDenied: "Join request — denied",
    joinJoined: "Joined the guild",
    joinUnscreened: "Join request — not screened",
    /** `{n}` is the risk score out of 100. */
    joinRisk: "Held for staff. Risk {n}/100.",
    joinRiskAccepted: "Accepted automatically. Risk {n}/100.",
    joinRiskDenied: "Refused automatically. Risk {n}/100.",
    joinRiskJoined: "Recorded for the guild's own reference. Risk {n}/100.",
    joinNoScreening: "The account could not be looked up, so nothing was checked. Decide from what you know.",
    joinNothingFound: "Nothing flagged.",
    /** `{at}` is a Discord relative timestamp, rendered by each reader's client. */
    joinExpires: "Closes {at}",
    joinExpiresNote: "After that they can only be invited.",
    /** `{n}` attempts inside the policy's repeat window. */
    joinAttempts: "{n} in the recent window",
    joinScammerListing: "Scammer listing: {reason}",
    joinTrouble: "Screening had trouble: {detail}",
    joinFooterPending: "Accept and Deny act on the request, not on this message.",
    /** Field labels inside the consolidated join-notice fields. */
    joinProfile: "Profile",
    joinCurrentGuild: "Currently in",
    joinLinked: "Linked Discord",
    joinPriorRemoval: "Previous removal",
    joinAttemptsLabel: "Attempts",
    joinDeadline: "Decide by",
    /* ── events ── */
    /**
     * The line the event card opens with, by status.
     *
     * One message carries an event from signups to result, so the headline is
     * the only part that has to say which of those is happening — everything
     * below it is the same sections with different contents.
     */
    eventOpen: "Signups are open — press Register to put your name down.",
    eventLive: "Live now. Standings update as the tracker polls.",
    eventDone: "Finished. Final standings below.",
    eventOff: "Cancelled.",
    /**
     * What the event ranks people by, in the opening lines rather than in a
     * field. `{metric}` is the sentence-cased phrase from `metricPhrase`.
     */
    eventScoredOn: "Scored on **{metric}**.",
    /** An event that measures nothing: a meeting, a giveaway, a social night. */
    eventUnscored: "Turnout only — nothing is scored.",
    /** `{id}` is the event id, which is how the bot finds its own message again. */
    eventId: "id {id}",
    eventNotify: "Remind me on Discord",
    /**
     * Where an External scheduled event says it happens.
     *
     * Discord requires a location on an external event and shows it in the
     * server's event list. It is the game, not a channel: the guild meets in
     * SkyBlock, and a channel name there would point at the message rather than
     * at the thing the message is about.
     */
    eventLocation: "Hypixel SkyBlock",
    eventNobody: "Nobody yet.",
    /** `{n}` going, `{n}` undecided — the two counts kept apart on purpose. */
    eventGoing: "**Going ({n})**",
    eventMaybe: "**Maybe ({n})**",
    /** `{n}` signed up with no linked account, so nothing can read their stats. */
    eventUnlinked: "**{n}** signed up with no linked account — /link, and the next poll counts them:",
    eventNoScores: "No scores yet — the first poll sets everyone's baseline.",
    /** `{metric}` reads mid-sentence, so it comes from `metricPhrase`. */
    eventLevel: "Nobody has gained any {metric} yet.",
    /* -- perms -- */
    /**
     * The headline of a party card. `{activity}` is the activity, sentence-cased
     * by `metricPhrase`'s rule rather than by `toLowerCase()`.
     */
    permHeadline: "{activity} — {filled} of {capacity} seats filled.",
    permDisbanded: "Disbanded. The name is free to use again.",
    permNoRoster: "No seats filled yet.",
    /**
     * Said of a seat, not of a person: the roster knows an IGN and has no
     * Discord account to put beside it. Short, because it sits at the end of a
     * line that is already carrying numbers.
     */
    permUnlinked: "unlinked",
    permLeftGuild: "left the guild",
    /** `{marker}` is the shared glyph, so the legend cannot name a different one. */
    permLagFooter: "{marker} marks a class level far behind the player's catacombs.",
    /** A static note, which is why it is a footer rather than a field. */
    permDefault: "Default party.",
    /**
     * The same two states again, as one word each, for a list line that has
     * already spent its room on the party's name and seat count.
     */
    permDefaultTag: "default",
    permDisbandedTag: "disbanded",
    permNone: "No parties yet.",
    /**
     * The console could not read the guild's parties. Points at `/health`
     * rather than narrating the failure: the member cannot fix a database, and
     * the one thing they can do is find out whether anything else is down too.
     */
    permUnavailable: "Couldn't load parties. /health has the current status.",
    permNotLinked: "Link your Minecraft account with /link before taking a seat.",
    permNotSeated: "You don't have a seat in this party.",
    /** A control from a message older than the thing it points at. */
    permStaleControl: "That control is out of date. Run /perm again.",
    /** The prompts on the two ephemeral menus that stand in front of a modal. */
    permPickActivity: "What will the party run?",
    permPickRole: "Which role are they filling?",
    /** Titles and labels for the two modals. Free text goes nowhere else. */
    permNameModalTitle: "New party",
    permNameLabel: "Name",
    permNotesLabel: "Notes (optional)",
    permIgnModalTitle: "Add someone",
    permIgnLabel: "Minecraft name",
    /** The list card's title. Not "Guild perms": the guild is implied. */
    permListTitle: "Standing parties",
    permListMineTitle: "Your parties",
    /** `{n}` of `{total}`, on a list that runs to more than one page. */
    permListPage: "Page {n} of {total}",

    /* -- lfg -- */
    /**
     * The prompts on the three steps. Each one asks for exactly the thing the
     * control under it offers, because a prompt that restates the command is a
     * line the reader has to skip to reach the menu.
     */
    lfgPickType: "What are you running?",
    lfgPickFloor: "Which floor?",
    lfgPickClasses: "Which classes are you short of? Post without picking for any.",
    /** The button that ends the flow, and the card it produces. */
    lfgPost: "Post",
    lfgTitle: "Looking for group",
    /**
     * The headline. `{who}` is a mention, so the card names the requester in the
     * first line even where the author row's IGN means nothing to the reader.
     */
    lfgHeadline: "{who} is looking for a group.",
    /** Said in the wanted field when no class was asked for. Not an empty field. */
    lfgAnyClass: "Any class",
    /** The ephemeral confirmation, naming where it went. */
    lfgPosted: "Posted in {channel}.",
    /**
     * Not a failure: nobody has set the channel yet, and the member cannot. It
     * says who can rather than pointing at a status page that would read healthy.
     */
    lfgNoChannel: "No looking-for-group channel is set — staff can set one on the panel.",
    lfgPostFailed: "Couldn't post that. /health has the current status.",
    lfgNotLinked: "Link your Minecraft account with /link before posting.",
    lfgStaleControl: "That control is out of date. Run /lfg again.",
    /**
     * Guild chat has no menus, so the floor has to be typed — and the answer to
     * "which floor" is the shape of the argument, spelled out.
     */
    lfgFloorNeeded: "Name a floor — !lfg f7.",
    lfgUnknownFloor: "No floor called \"{floor}\". Floors are f1-f7, m1-m7, e and k1-k5.",
  },
};

export type Embeds = typeof DEFAULT_EMBEDS;
