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
    /** `{n}` is the window in days. */
    noSnapshots: "No snapshots in the last {n} days.",
    oneSnapshot: "Only one reading so far — come back after the next snapshot.",

    /**
     * Not a staleness footer: standing is recomputed on a cadence rather than
     * fetched, so what a member needs to know is that today is still counting.
     */
    standingFooter: "XP is totalled a few times a day — today's activity may not be in yet.",
  },
};

export type Embeds = typeof DEFAULT_EMBEDS;
