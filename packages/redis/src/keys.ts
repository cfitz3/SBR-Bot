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
    analyticsBuffer: () => p(`buf:analytics`),

    // 4. Rate-limit buckets
    rlHypixel: () => p(`rl:hypixel`),
    rlHypixelEndpoint: (endpoint: string) => p(`rl:hypixel:${endpoint}`),

    // 5. Bridge flood counters
    floodUser: (guildId: string, userId: string) => p(`flood:user:${guildId}:${userId}`),
    floodGuild: (guildId: string) => p(`flood:guild:${guildId}`),
    floodMention: (guildId: string, userId: string) => p(`flood:mention:${guildId}:${userId}`),

    // 6. Temporary mutes / suspensions (mirror of Postgres, rehydrated on boot)
    mute: (guildId: string, userId: string) => p(`mute:${guildId}:${userId}`),
    ban: (guildId: string, userId: string) => p(`ban:${guildId}:${userId}`),
    suspendBridge: (guildId: string) => p(`suspend:bridge:${guildId}`),

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

    // 8. Worker locks
    lockJob: (name: string, scope?: string) => p(`lock:job:${name}${scope ? `:${scope}` : ""}`),
    lockSingleFlight: (cacheKey: string) => p(`lock:hypixel:${cacheKey}`),

    // 9. Deduplication keys
    dedupRelay: (guildId: string, hash: string) => p(`dedup:relay:${guildId}:${hash}`),
    dedupMilestone: (accountId: string, type: string, threshold: string | number) =>
      p(`dedup:milestone:${accountId}:${type}:${threshold}`),
    dedupReminder: (eventId: string, offset: string) => p(`dedup:reminder:${eventId}:${offset}`),
    dedupEvent: (eventId: string) => p(`dedup:event:${eventId}`),
  };
}
