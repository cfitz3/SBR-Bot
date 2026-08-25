/**
 * DiscordGuildEffects — the discord.js half of `/kick`, `/ban`, `/mute`,
 * `/purge` and `/lockdown`. The command layer never touches discord.js; it
 * reaches Discord only through the `GuildEffects` port, and this is the single
 * implementation.
 *
 * The client is supplied lazily because the composition root builds the
 * dispatcher before the gateway logs in: a `null` client means "not connected
 * yet", which is reported as a plain failure rather than a crash.
 */
import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type TextChannel,
} from "discord.js";
import { err, ok, type GuildEffectError, type GuildEffects, type PurgeInput, type Result } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";

/** Discord's bulk delete silently ignores anything older than this. */
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Discord refuses a communication timeout longer than 28 days. Clamped rather
 * than refused: the mirror and the audit row hold the real duration, the expiry
 * sweep lifts it at the real time, and a 60-day mute that silences someone for
 * 28 days is strictly better than one that silences them for none. Anything
 * genuinely longer wants to be a ban.
 */
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

/**
 * Codes that mean "the end state you asked for already holds".
 *
 * 10026 Unknown Ban and 10013 Unknown User on an unban, 10007 Unknown Member on
 * a kick or an untimeout. Treating these as failures would put a case into the
 * enforcement-failed queue for the one reason staff can do nothing about: the
 * person is already gone, or already not banned. The desired state is the
 * observed state, so the call succeeded.
 */
function isAlreadyDone(error: unknown, codes: readonly number[]): boolean {
  return error instanceof DiscordAPIError && codes.includes(Number(error.code));
}

function classify(error: unknown): GuildEffectError {
  if (error instanceof DiscordAPIError) {
    // 50013 Missing Permissions, 50001 Missing Access — both mean the bot's
    // role can't do this, which is a fixable configuration problem, not a bug.
    if (error.code === 50013 || error.code === 50001) return { kind: "MISSING_PERMISSION" };
    if (error.code === 10003 || error.code === 10007 || error.code === 10013) return { kind: "NOT_FOUND" };
    return { kind: "FAILED", detail: error.message };
  }
  return { kind: "FAILED", detail: error instanceof Error ? error.message : "unknown error" };
}

export interface DiscordGuildEffectsDeps {
  /** Resolves the platform's internal guild id back to the Discord snowflake. */
  readonly toDiscordGuildId: (internalGuildId: string) => Promise<string | null>;
  readonly logger: Logger;
}

export class DiscordGuildEffects implements GuildEffects {
  private client: Client | null = null;
  private readonly d: DiscordGuildEffectsDeps;
  private readonly log: Logger;

  constructor(deps: DiscordGuildEffectsDeps) {
    this.d = deps;
    this.log = deps.logger.child({ service: "guild-effects" });
  }

  /** Called once the gateway is ready. Until then every effect fails cleanly. */
  attach(client: Client): void {
    this.client = client;
  }

  private async guild(internalGuildId: string): Promise<Result<Guild, GuildEffectError>> {
    if (!this.client) return err<GuildEffectError>({ kind: "FAILED", detail: "not connected to Discord yet" });
    const discordGuildId = await this.d.toDiscordGuildId(internalGuildId);
    if (!discordGuildId) return err<GuildEffectError>({ kind: "NOT_FOUND" });
    try {
      return ok(await this.client.guilds.fetch(discordGuildId));
    } catch (error) {
      return err(classify(error));
    }
  }

  async kick(guildId: string, userId: string, reason: string): Promise<Result<void, GuildEffectError>> {
    const guild = await this.guild(guildId);
    if (!guild.ok) return err(guild.error);
    try {
      await guild.value.members.kick(userId, reason);
      return ok(undefined);
    } catch (error) {
      return err(classify(error));
    }
  }

  /**
   * The call that was missing entirely. `/ban` wrote its row, set its Redis
   * mirror key, published its relay command and replied "Banned" — and no code
   * path anywhere in the admin bot ever asked Discord to ban anybody.
   *
   * `deleteMessageSeconds` is deliberately zero: purging a banned member's
   * history is `/purge`'s decision to make, not a silent side effect of a ban.
   */
  async ban(guildId: string, userId: string, reason: string): Promise<Result<void, GuildEffectError>> {
    const guild = await this.guild(guildId);
    if (!guild.ok) return err(guild.error);
    try {
      await guild.value.bans.create(userId, { reason, deleteMessageSeconds: 0 });
      return ok(undefined);
    } catch (error) {
      return err(classify(error));
    }
  }

  async unban(guildId: string, userId: string, reason: string): Promise<Result<void, GuildEffectError>> {
    const guild = await this.guild(guildId);
    if (!guild.ok) return err(guild.error);
    try {
      await guild.value.bans.remove(userId, reason);
      return ok(undefined);
    } catch (error) {
      // Not banned is the state an unban was after.
      if (isAlreadyDone(error, [10026, 10013])) return ok(undefined);
      return err(classify(error));
    }
  }

  async timeout(
    guildId: string,
    userId: string,
    durationSeconds: number,
    reason: string,
  ): Promise<Result<void, GuildEffectError>> {
    const guild = await this.guild(guildId);
    if (!guild.ok) return err(guild.error);
    try {
      const member = await guild.value.members.fetch(userId);
      await member.timeout(Math.min(durationSeconds * 1000, MAX_TIMEOUT_MS), reason);
      return ok(undefined);
    } catch (error) {
      return err(classify(error));
    }
  }

  async untimeout(guildId: string, userId: string, reason: string): Promise<Result<void, GuildEffectError>> {
    const guild = await this.guild(guildId);
    if (!guild.ok) return err(guild.error);
    try {
      const member = await guild.value.members.fetch(userId);
      await member.timeout(null, reason);
      return ok(undefined);
    } catch (error) {
      // Nobody to un-silence: an unmute for someone who has left the server is
      // done, not failed.
      if (isAlreadyDone(error, [10007])) return ok(undefined);
      return err(classify(error));
    }
  }

  async purge(input: PurgeInput): Promise<Result<number, GuildEffectError>> {
    const guild = await this.guild(input.guildId);
    if (!guild.ok) return err(guild.error);
    try {
      const channel = await guild.value.channels.fetch(input.channelId);
      if (!channel || !channel.isTextBased()) return err<GuildEffectError>({ kind: "NOT_FOUND" });

      // Over-fetch when filtering by author, since the target's messages may be
      // scattered through the recent history rather than sitting at the end.
      const fetchLimit = input.userId ? Math.min(100, input.count * 5) : input.count;
      const recent = await (channel as TextChannel).messages.fetch({ limit: fetchLimit });
      const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
      const doomed = [...recent.values()]
        .filter((m) => (input.userId ? m.author.id === input.userId : true))
        .filter((m) => m.createdTimestamp > cutoff)
        .slice(0, input.count);

      if (doomed.length === 0) return ok(0);
      const deleted = await (channel as TextChannel).bulkDelete(doomed, true);
      return ok(deleted.size);
    } catch (error) {
      return err(classify(error));
    }
  }

  /**
   * Lock by denying SendMessages to @everyone. A channel that already denies it
   * is left alone and not counted, so lifting a lockdown can't hand out send
   * rights the server never granted in the first place.
   */
  async setLocked(
    guildId: string,
    channelId: string | null,
    locked: boolean,
  ): Promise<Result<number, GuildEffectError>> {
    const guild = await this.guild(guildId);
    if (!guild.ok) return err(guild.error);

    try {
      const everyone = guild.value.roles.everyone;
      const targets: GuildBasedChannel[] = [];

      if (channelId) {
        const one = await guild.value.channels.fetch(channelId);
        if (!one) return err<GuildEffectError>({ kind: "NOT_FOUND" });
        targets.push(one);
      } else {
        const all = await guild.value.channels.fetch();
        for (const channel of all.values()) {
          if (channel && channel.type === ChannelType.GuildText) targets.push(channel);
        }
      }

      let changed = 0;
      for (const channel of targets) {
        if (channel.type !== ChannelType.GuildText) continue;
        const current = channel.permissionOverwrites.cache.get(everyone.id);
        const alreadyDenied = current?.deny.has(PermissionFlagsBits.SendMessages) ?? false;
        if (locked === alreadyDenied) continue;

        try {
          await channel.permissionOverwrites.edit(everyone, { SendMessages: locked ? false : null });
          changed += 1;
        } catch (error) {
          // One un-editable channel must not abort the sweep: locking 19 of 20
          // channels is far better than locking none.
          this.log.warn("channel lock skipped", { channelId: channel.id, error: String(error) });
        }
      }
      return ok(changed);
    } catch (error) {
      return err(classify(error));
    }
  }
}
