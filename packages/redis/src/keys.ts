/**
 * Redis keyspace builders. Every key is prefixed (default `sbr:`) and follows
 * `{category}:{scope}:{id}` so categories can be SCAN-ed/flushed independently.
 * See REDIS_KEYSPACE.md for the full specification.
 */

export type KeyFactory = ReturnType<typeof createKeyFactory>;

export function createKeyFactory(prefix: string) {
  const p = (s: string) => `${prefix}${s}`;

  return {
    prefix,

    // 1. Command cooldowns
    cooldown: (surface: string, command: string, userId: string) =>
      p(`cd:${surface}:${command}:${userId}`),
    cooldownIngame: (command: string, ign: string) => p(`cd:ingame:${command}:${ign}`),
    relayCooldown: (surface: string, userId: string) => p(`cd:relay:${surface}:${userId}`),

    // 2. Session & OAuth state
    session: (sessionId: string) => p(`sess:${sessionId}`),
    oauthState: (state: string) => p(`oauth:state:${state}`),

    // 3. Event dispatch (pub/sub channels) & analytics buffer
    chanBridge: (guildId: string) => p(`chan:bridge:${guildId}`),
    chanConfig: (guildId: string) => p(`chan:config:${guildId}`),
    chanMod: (guildId: string) => p(`chan:mod:${guildId}`),
    /**
     * Discord members arriving and leaving, observed by the admin bot.
     *
     * A separate channel from `chan:bridge` because the audiences differ: the
     * bridge inbox carries work for the member-facing bot to *do*, this carries
     * a fact about the server that several listeners may each care about.
     */
    chanMember: (guildId: string) => p(`chan:member:${guildId}`),
    /**
     * Manual job triggers, panel → workers. One channel for the whole platform
     * rather than one per guild: the subscriber is the worker fleet, which is
     * not scoped to a guild, and the guild a run is *for* travels in the payload
     * where the job handler can read it.
     */
    chanJobs: () => p(`chan:jobs`),
    analyticsBuffer: () => p(`buf:analytics`),

    // 3b. Liveness. One key per service instance, written on a timer and given a
    // TTL of a few beats: absence is the signal, so a crashed process stops
    // reporting healthy without anything having to notice it died.
    heartbeat: (service: string, instance: string) => p(`hb:${service}:${instance}`),
    heartbeatScan: () => p(`hb:*`),

    // 4. Rate-limit buckets
    rlHypixel: () => p(`rl:hypixel`),
    rlHypixelEndpoint: (endpoint: string) => p(`rl:hypixel:${endpoint}`),
    /**
     * The self-imposed per-player window (docs/HYPIXEL_COMPLIANCE.md). Subject
     * is `<uuid>:<endpoint family>`; the key's existence *is* the claim, so it
     * is written with NX and an expiry and never read back.
     */
    rlPlayer: (subject: string) => p(`rl:player:${subject}`),

    // 5. Bridge flood counters
    floodUser: (guildId: string, userId: string) => p(`flood:user:${guildId}:${userId}`),
    floodGuild: (guildId: string) => p(`flood:guild:${guildId}`),
    floodMention: (guildId: string, userId: string) => p(`flood:mention:${guildId}:${userId}`),

    // 5b. Automod windows. One key per rule, because two spam rules with
    // different windows are two independent counts of the same messages, and
    // sharing a key would make the tighter one decide for both. The repeat
    // counter carries a hash of the text: what it measures is "this line
    // again", not "another line".
    automodSpam: (guildId: string, ruleId: string, author: string) =>
      p(`am:spam:${guildId}:${ruleId}:${author}`),
    automodRepeat: (guildId: string, ruleId: string, author: string, textHash: string) =>
      p(`am:rep:${guildId}:${ruleId}:${author}:${textHash}`),

    // 6. Temporary mutes / suspensions (mirror of Postgres, rehydrated on boot)
    mute: (guildId: string, userId: string) => p(`mute:${guildId}:${userId}`),
    ban: (guildId: string, userId: string) => p(`ban:${guildId}:${userId}`),
    suspendBridge: (guildId: string) => p(`suspend:bridge:${guildId}`),

    // 6b. Safety postures. These outlive the posture itself: the record is what
    // says which channels to reopen, so expiry is decided by `expiresAt` inside
    // the value rather than by letting the key evaporate.
    lockdown: (guildId: string) => p(`safety:lockdown:${guildId}`),
    lockdownScan: () => p(`safety:lockdown:*`),
    antiRaid: (guildId: string) => p(`safety:antiraid:${guildId}`),
    antiRaidScan: () => p(`safety:antiraid:*`),

    // 7. Cached Hypixel responses
    cacheProfile: (uuid: string, profileId: string) =>
      p(`cache:hypixel:profile:${uuid}:${profileId}`),
    cachePlayer: (uuid: string) => p(`cache:hypixel:player:${uuid}`),
    cacheMuseum: (profileId: string) => p(`cache:hypixel:museum:${profileId}`),
    cacheResource: (name: string) => p(`cache:hypixel:res:${name}`),
    cacheBazaar: () => p(`cache:pricing:bazaar`),
    cachePriceItem: (itemId: string) => p(`cache:pricing:item:${itemId}`),
    cacheLowestBin: (itemId: string) => p(`cache:ah:lbin:${itemId}`),
    cacheGlobal: (name: string) => p(`cache:sb:${name}`),

    // 7b. Cached Discord directory answers (channels/roles/members) served to
    // the panel's pickers. Keyed by query as well as resource because the bot
    // filters server-side, so two searches are two different answers. Short TTL:
    // this is a convenience cache in front of a gateway cache, and a role
    // created a minute ago should show up without anyone flushing anything.
    directory: (guildId: string, resource: string, q: string) =>
      p(`dir:${guildId}:${resource}:${q}`),

    // 8. Worker locks
    lockJob: (name: string, scope?: string) => p(`lock:job:${name}${scope ? `:${scope}` : ""}`),
    /**
     * Members whose auto-roles may be out of date, drained by `role-sync`.
     *
     * A set, so marking somebody five times between passes is one unit of work.
     * Losing it to a flush costs one day of latency — the daily full sweep
     * re-marks everyone — and never costs correctness, which is the trade that
     * lets it live in Redis at all.
     */
    rolesDirty: (guildId: string) => p(`roles:dirty:${guildId}`),
    /** Held for a day by whichever worker claimed this guild's full sweep. */
    rolesSweep: (guildId: string) => p(`roles:sweep:${guildId}`),
    /**
     * Roles the effector could not apply, and why — the Health card's read.
     *
     * A diagnostic, not a record: a refusal means the guild has a role above
     * the bot or a role that no longer exists, which is a configuration problem
     * staff fix in the panel. It carries a TTL so a refusal that has since been
     * fixed stops being reported without anybody clearing it, and losing the
     * hash to a flush costs only the message, never the reconcile.
     */
    rolesRefused: (guildId: string) => p(`roles:refused:${guildId}`),
    lockSingleFlight: (cacheKey: string) => p(`lock:hypixel:${cacheKey}`),

    // 9. Deduplication keys
    dedupRelay: (guildId: string, hash: string) => p(`dedup:relay:${guildId}:${hash}`),
    dedupMilestone: (accountId: string, type: string, threshold: string | number) =>
      p(`dedup:milestone:${accountId}:${type}:${threshold}`),
    dedupReminder: (eventId: string, offset: string) => p(`dedup:reminder:${eventId}:${offset}`),
    dedupEvent: (eventId: string) => p(`dedup:event:${eventId}`),

    // 10. Joke counters (`!cringe`). The only fun-command state there is, and
    // the only category here that holds something a member can see days later —
    // so it carries a rolling TTL and is keyed by the *typed* name, never by a
    // Discord id: a running joke is about a name, not about an account.
    funTally: (guildId: string, name: string, subject: string) =>
      p(`fun:tally:${guildId}:${name}:${subject}`),
  };
}
