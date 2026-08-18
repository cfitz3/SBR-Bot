/**
 * The staff side of join screening: the queue of people waiting, and the three
 * commands that resolve one.
 *
 * Screening on its own only ever *reports*. `ScreeningService.screen()` decides
 * a verdict and writes a row; whether the guild door actually opens is a
 * separate act, and until this file existed there was exactly one way to
 * perform it — the bridge's own auto-accept. With auto-accept off, which is the
 * default and the setting most guilds want, a request was screened, recorded,
 * written up for staff, and then nothing could be done about it from anywhere
 * on the platform. Staff had to log into the game account and type the command
 * by hand, against a queue the panel was showing them.
 *
 * So this is the missing half, and it is deliberately thin: it validates the
 * name, sends one command, and records what it did. Three properties are worth
 * stating because each is a bug that would otherwise be easy to write:
 *
 * - **The name is validated before it becomes a command.** Everything here is
 *   ultimately typed into a Minecraft chat box by the bridge account. A name is
 *   `[A-Za-z0-9_]{1,16}` and nothing else; anything containing a space could
 *   append a second argument, and anything containing a newline could append a
 *   second *command*.
 * - **The row is only decided once the command is away.** Recording ACCEPTED
 *   for a command that was never sent is worse than recording nothing: it makes
 *   the platform's history disagree with the guild's, silently, in the
 *   direction of "we handled it".
 * - **A name we cannot resolve is still actionable.** Hypixel's uuid lookup is
 *   the flakiest dependency in the building, and staff typing `/join-accept` on
 *   somebody they can see in the request notice should not be refused because a
 *   third party is down. The command is sent; the caller is told the row could
 *   not be matched.
 */
import type { Logger } from "@sbr/observability";
import type { ScreeningService } from "./service.js";
import type { ScreeningRecord } from "./ports.js";
import type { ScreeningOutcome } from "./types.js";

/** A Minecraft username and nothing else. See the header. */
const IGN = /^[A-Za-z0-9_]{1,16}$/;

/**
 * Where a guild command goes.
 *
 * Returns false when it could not be handed off — an unresolved guild, a full
 * backlog, no bridge listening. False is not an error; it is the honest answer
 * that the door did not move, and the caller reports it rather than pretending.
 */
export interface GuildCommandSender {
  send(guildId: string, command: string): Promise<boolean> | boolean;
}

/** IGN → uuid, for matching a typed name back to its pending row. */
export interface JoinPlayerLookup {
  resolveIgn(ign: string): Promise<{ readonly uuid: string; readonly ign: string } | null>;
}

export interface JoinQueueDeps {
  readonly screening: ScreeningService;
  readonly commands: GuildCommandSender;
  readonly logger: Logger;
  /** Without it, a decision is sent but never matched to a row. */
  readonly players?: JoinPlayerLookup;
}

export type JoinActionFailure =
  /** The name is not a Minecraft username. Nothing was sent. */
  | "BAD_NAME"
  /** The bridge could not take the command. Nothing was sent, nothing recorded. */
  | "NOT_SENT";

export type JoinActionResult =
  | {
      readonly ok: true;
      /** The name as sent, in the casing Mojang reports where we could get it. */
      readonly ign: string;
      /** True when a pending screening row was found and marked. */
      readonly recorded: boolean;
      /** Set when the screening row was found, for the caller's summary line. */
      readonly screening: ScreeningRecord | null;
    }
  | { readonly ok: false; readonly reason: JoinActionFailure };

/** What each action does, in one table, so the three cannot drift apart. */
const ACTIONS = {
  ACCEPT: { verb: "accept", outcome: "ACCEPTED" },
  DENY: { verb: "deny", outcome: "DENIED" },
  /** An invite is not a decision on a request, so it marks no row. */
  INVITE: { verb: "invite", outcome: null },
} as const;

export type JoinAction = keyof typeof ACTIONS;

export class JoinQueueService {
  private readonly d: JoinQueueDeps;
  private readonly log: Logger;

  constructor(deps: JoinQueueDeps) {
    this.d = deps;
    this.log = deps.logger.child({ component: "join-queue" });
  }

  /** Everyone screened and still awaiting a decision, oldest first. */
  async pending(guildId: string, limit = 25): Promise<readonly ScreeningRecord[]> {
    return this.d.screening.pending(guildId, limit);
  }

  /** Admit an applicant who has asked. */
  async accept(guildId: string, ign: string, actorId: string): Promise<JoinActionResult> {
    return this.act("ACCEPT", guildId, ign, actorId);
  }

  /** Refuse one. */
  async deny(guildId: string, ign: string, actorId: string): Promise<JoinActionResult> {
    return this.act("DENY", guildId, ign, actorId);
  }

  /**
   * Invite somebody who never asked.
   *
   * Not interchangeable with accept: Hypixel refuses `invite` for a player with
   * a pending request and refuses `accept` for one without, so the two stay
   * separate commands rather than one that guesses.
   */
  async invite(guildId: string, ign: string, actorId: string): Promise<JoinActionResult> {
    return this.act("INVITE", guildId, ign, actorId);
  }

  private async act(action: JoinAction, guildId: string, rawIgn: string, actorId: string): Promise<JoinActionResult> {
    const typed = rawIgn.trim();
    if (!IGN.test(typed)) {
      this.log.warn("join action refused: not a Minecraft name", { action, guildId });
      return { ok: false, reason: "BAD_NAME" };
    }

    const { verb, outcome } = ACTIONS[action];

    // Resolved first, so the command carries Mojang's casing and so the row can
    // be found — but a failure here is not fatal, only unrecorded.
    const resolved = await this.resolve(typed);
    const ign = resolved?.ign ?? typed;

    const sent = await this.d.commands.send(guildId, `/guild ${verb} ${ign}`);
    if (!sent) {
      this.log.warn("join action not sent", { action, guildId, ign });
      return { ok: false, reason: "NOT_SENT" };
    }

    if (outcome === null || resolved === null) {
      if (outcome !== null) this.log.warn("join action sent but not recorded: name unresolved", { action, ign });
      return { ok: true, ign, recorded: false, screening: null };
    }

    const row = await this.d.screening.findPending(guildId, resolved.uuid);
    if (row === null) {
      // Common and legitimate: staff accepting somebody whose request predates
      // the bridge being up, or who was screened under a different name.
      this.log.info("join action sent with no pending row to mark", { action, ign });
      return { ok: true, ign, recorded: false, screening: null };
    }

    await this.d.screening.decide(row.id, outcome satisfies ScreeningOutcome, actorId);
    this.log.info("join action recorded", { action, guildId, ign, actor: actorId, screeningId: row.id });
    return { ok: true, ign, recorded: true, screening: row };
  }

  private async resolve(ign: string): Promise<{ readonly uuid: string; readonly ign: string } | null> {
    if (!this.d.players) return null;
    try {
      return await this.d.players.resolveIgn(ign);
    } catch (e) {
      this.log.warn("could not resolve applicant name", { ign, err: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }
}
