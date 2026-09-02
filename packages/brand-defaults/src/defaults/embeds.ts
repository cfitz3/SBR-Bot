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
    catacombs: "Catacombs",
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
    whereFrom: "Where it came from",
    snapshots: "Snapshots",
    pace: "Pace",
    target: "Target",
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
    /** `{guild}` is the guild's own name, when the roster carries one. */
    roster: "{guild} — online now",
    /** …and when it does not. Not "Unknown — online now". */
    rosterUnnamed: "Online now",

    /** Empty and unavailable states, per card. */
    noProfiles: "No Skyblock profiles on this account.",
    skillsOff: "This profile's skill API is turned off, so none of it is readable.",
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
    noXpYet: "Nothing yet.",
    achievementsOff: "Achievements aren't switched on here.",
    achievementsNone: "This guild hasn't set up any achievements yet.",
    noAdvice: "No suggestions — nothing obvious to improve.",
    genericAdvice: "Couldn't read this profile, so this is general advice rather than advice about you.",
    /** `{subject}` is the item or player searched for. */
    noAuctions: "No active auctions for {subject}.",
    networthHidden: "Unknown — the profile's API settings hide the data this needs.",
    /**
     * `{n}` is the window in days.
     *
     * Both of these name the way out, because the empty state is now something
     * the member fixes rather than something they wait through: the platform
     * keeps one current reading per member, and a chart is built from markers
     * they save (docs/HYPIXEL_COMPLIANCE.md §1).
     */
    noSnapshots: "No saved snapshots in the last {n} days. Run /snapshot to pin where you are now.",
    oneSnapshot: "Only one saved snapshot — run /snapshot again later and this will show the change.",

    /* ── saved snapshots ── */
    /** `{n}` saved, `{limit}` the cap. */
    snapshotSaved: "Saved. You're holding {n} of {limit} — /progress charts them.",
    /** `{n}` is the label they gave it. */
    snapshotSavedNamed: 'Saved as "{name}". You\'re holding {n} of {limit} — /progress charts them.',
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
    noGoals: "No goals yet. Set one with /goal set.",
    goalSet: "Tracking your {metric} to {target}.",
    goalCleared: "Cleared your {metric} goal.",
    goalNotSet: "You had no {metric} goal to clear.",
    /** Shown in place of an ETA when there is not enough history to project. */
    goalNoPace: "no pace yet",
    /** `~12d` — days at recent pace, deliberately hedged with the tilde. */
    goalEta: "~{n}d",
    goalDone: "done",
    goalsFooter: "Projections are recent pace extended, not a promise.",
    /** The announcement when a goal is reached. Second person: it is their post. */
    goalAchievedTitle: "Goal reached",
    goalAchievedBody: "{ign} set out for {target} {metric} — and got there.",
    /** Per-day movement, e.g. `+2.4/day`. */
    perDay: "{n}/day",
  },
};

export type Embeds = typeof DEFAULT_EMBEDS;
