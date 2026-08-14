/**
 * The Discord side of the member directory: mirror a server's member list into
 * `DiscordUser` + `GuildMember` so the panel can show everyone, linked or not.
 *
 * Pure, like `guild-scan`'s core: every read and write is a port, so the whole
 * decision — who joined, who left, whose name changed — is testable without a
 * gateway, a database, or a network.
 *
 * Why mirror at all, when the bot already holds a live gateway cache? Because
 * the panel's member page has to answer questions the cache cannot: who *left*
 * and when, who is linked to which Minecraft account, and what the roster looked
 * like when the bot was offline. The cache is the freshest source for a picker;
 * this table is the durable one for a roster.
 */

/** One member as the bot's internal API reports them. Mirrors `DirectoryMember`. */
export interface DiscordMemberRow {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly nick: string | null;
  readonly avatarHash: string | null;
  readonly roleIds: readonly string[];
  readonly joinedAt: string | null;
  readonly bot: boolean;
}

/** What the sync writes for one member. */
export interface DiscordMemberWrite {
  readonly discordId: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly nickname: string | null;
  readonly avatarHash: string | null;
  readonly joinedAt: Date | null;
  /**
   * The Discord roles this member holds, mirrored so permission resolution can
   * run without a gateway call. It is read on the relay's hot path — every
   * message asks "what is this author allowed to do" — and the bot is not always
   * up when the panel or a worker asks.
   */
  readonly roleIds: readonly string[];
}

export interface DiscordSyncPorts {
  /**
   * The server's members, or null when the bot could not be reached.
   *
   * Null and empty are deliberately different: an unreachable bot must not be
   * read as "everyone left", which is what an empty array would mean.
   */
  fetchMembers(guildId: string): Promise<readonly DiscordMemberRow[] | null>;
  /** Discord ids currently recorded as ACTIVE for this guild. */
  listActiveIds(guildId: string): Promise<readonly string[]>;
  upsertMembers(guildId: string, rows: readonly DiscordMemberWrite[]): Promise<void>;
  /** Flip to LEFT and stamp `leftAt`. Never deletes — history outlives membership. */
  markLeft(guildId: string, discordIds: readonly string[]): Promise<void>;
}

export interface DiscordSyncResult {
  /** Set when nothing was written, naming why. */
  readonly skipped?: "unreachable" | "implausible";
  readonly seen: number;
  readonly joined: number;
  readonly left: number;
}

/**
 * Reconcile one guild's Discord roster.
 *
 * **Bots are excluded.** Every consumer of this table — roles, XP, moderation
 * history, linking — is about people, and a webhook in the member count is a
 * number nobody wants. They stay visible in the pickers, which read the gateway
 * cache directly, because "which bot has this role" is a real question.
 */
export async function syncDiscordMembers(
  guildId: string,
  ports: DiscordSyncPorts,
): Promise<DiscordSyncResult> {
  const fetched = await ports.fetchMembers(guildId);
  if (fetched === null) return { skipped: "unreachable", seen: 0, joined: 0, left: 0 };

  const people = fetched.filter((row) => !row.bot);
  const present = new Set(people.map((row) => row.id));
  const known = new Set(await ports.listActiveIds(guildId));

  /*
   * A 200 that carries nobody is not the same claim as "everyone left", even
   * though the diff below cannot tell them apart. The realistic cause is the
   * Server Members privileged intent being off: the gateway then hands the bot
   * only itself, the bot is filtered out as a bot, and the fetch succeeds with
   * an empty list — which would mark the entire server as departed on the next
   * two-hourly run. `null` is the honest signal for that, but the bot has no way
   * to know its own cache is crippled, so the refusal has to live here.
   *
   * The cost of the guard is one genuinely-empty server staying stale, which
   * cannot happen while a member is present to look at the panel.
   */
  if (people.length === 0 && known.size > 0) {
    return { skipped: "implausible", seen: 0, joined: 0, left: 0 };
  }

  const writes: DiscordMemberWrite[] = people.map((row) => ({
    discordId: row.id,
    username: row.username,
    globalName: row.globalName,
    nickname: row.nick,
    avatarHash: row.avatarHash,
    joinedAt: parseJoinedAt(row.joinedAt),
    roleIds: row.roleIds,
  }));

  const departed = [...known].filter((id) => !present.has(id));

  if (writes.length > 0) await ports.upsertMembers(guildId, writes);
  if (departed.length > 0) await ports.markLeft(guildId, departed);

  return {
    seen: people.length,
    joined: people.filter((row) => !known.has(row.id)).length,
    left: departed.length,
  };
}

/** A malformed timestamp is dropped rather than stored as an Invalid Date. */
function parseJoinedAt(raw: string | null): Date | null {
  if (raw === null) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}
