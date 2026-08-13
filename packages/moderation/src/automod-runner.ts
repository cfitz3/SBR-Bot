/**
 * The impure half of automod: read the policy, read the counters, evaluate, and
 * route whatever fired into the moderation service.
 *
 * Split from `automod.ts` so the decision stays a pure function of its inputs.
 * Everything that can fail, block or drift — Redis, the settings row, the
 * wordlist table — lives here, and there is exactly one of it. Both surfaces
 * call the same runner: the Discord message handler in bridge-bot, and the
 * relay pipeline in @sbr/bridge. A second copy for the game side is how the two
 * surfaces would end up enforcing different rules while claiming to share a
 * policy.
 *
 * **Automod issues nothing itself.** A `WARN` or `MUTE` goes through
 * `applyAction` like any staff action, which means it lands in the audit trail,
 * counts toward escalation, and reaches guild chat through the Phase-3 relay
 * sync without this file knowing any of that exists.
 *
 * **It fails open.** A message is only ever blocked by a decision that was
 * actually reached; if the policy cannot be read or the counters are
 * unreachable, the message goes through. The alternative is a Redis blip
 * silencing a guild, which is a worse failure than a slur getting through for
 * the thirty seconds it takes somebody to notice.
 */
import type { Logger } from "@sbr/observability";
import type { BridgeCapability, ModerationSurface, WordlistRuleDTO } from "@sbr/shared-types";
import {
  counterRequestsFor,
  evaluateAutomod,
  parseAutomod,
  ALLOW_DECISION,
  type AutomodCounterRequest,
  type AutomodCounters,
  type AutomodDecision,
} from "./automod.js";
import type { ModerationMetrics } from "./metrics.js";
import type { AutomodCounterStore, AutomodPolicySource, WordlistRepository } from "./ports.js";

/** The author whose messages are being judged, as each surface knows them. */
export interface AutomodSubject {
  /** Discord id, or the IGN on the guild-chat side. Keys the windowed counters. */
  readonly key: string;
  /** Null on the guild-chat side: automod can flag there, but cannot punish an unlinked name. */
  readonly discordId: string | null;
  readonly roleIds: readonly string[];
  readonly capabilities: readonly BridgeCapability[];
}

export interface AutomodInput {
  readonly guildId: string;
  readonly surface: ModerationSurface;
  readonly text: string;
  readonly mentionCount: number;
  readonly subject: AutomodSubject;
}

/**
 * What the caller has to do about it.
 *
 * `blocked` is the only thing a message pipeline needs; the decision is carried
 * alongside so a caller that wants to say *why* it dropped something can.
 */
export interface AutomodOutcome {
  readonly blocked: boolean;
  readonly decision: AutomodDecision;
}

const ALLOWED: AutomodOutcome = { blocked: false, decision: ALLOW_DECISION };

/** The subset of the moderation service automod needs. Narrow on purpose. */
export interface AutomodEnforcer {
  applyAction(input: {
    guildId: string;
    type: "WARN" | "MUTE";
    actorDiscordId: string;
    targetDiscordId: string | null;
    reason: string;
    durationSeconds?: number | null;
  }): Promise<{ ok: boolean }>;
}

export interface AutomodRunnerDeps {
  readonly policy: AutomodPolicySource;
  readonly counters: AutomodCounterStore;
  readonly wordlist: WordlistRepository;
  readonly moderation: AutomodEnforcer;
  /** Optional: absent means automod still fires, it is just not counted. */
  readonly metrics?: ModerationMetrics;
  readonly logger: Logger;
  /**
   * Recorded as the actor on anything automod issues. A real staff id would put
   * a person's name on a punishment they did not choose to give; a sentinel
   * makes "the platform did this" readable in the audit log at a glance.
   */
  readonly actorId?: string;
}

/** The actor id automod's own actions are recorded under. */
export const AUTOMOD_ACTOR = "automod";

export class AutomodRunner {
  private readonly d: AutomodRunnerDeps;
  private readonly log: Logger;
  private readonly actorId: string;

  constructor(deps: AutomodRunnerDeps) {
    this.d = deps;
    this.log = deps.logger.child({ service: "automod" });
    this.actorId = deps.actorId ?? AUTOMOD_ACTOR;
  }

  /**
   * Judge one message, punish if the policy says so, and report whether it
   * survives.
   *
   * The punishment is deliberately not awaited before returning: the caller is
   * a message pipeline with a member waiting on it, and whether the message is
   * delivered was already decided by the evaluation. A failed `applyAction` is
   * logged rather than turned into a dropped message, since the delete has
   * already been decided and reversing it here would be worse than a missing
   * audit row.
   */
  async run(input: AutomodInput): Promise<AutomodOutcome> {
    let decision: AutomodDecision;
    try {
      decision = await this.evaluate(input);
    } catch (error) {
      this.log.error("automod evaluation failed; message allowed", {
        guildId: input.guildId,
        surface: input.surface,
        error: String(error),
      });
      return ALLOWED;
    }

    if (decision.action === "ALLOW") return ALLOWED;

    this.log.info("automod fired", {
      guildId: input.guildId,
      surface: input.surface,
      subject: input.subject.key,
      action: decision.action,
      deleted: decision.deleteMessage,
      rules: decision.matched.map((m) => m.ruleId),
    });

    // One hit per matched rule, recorded whether or not the outcome was a
    // punishment: a FLAG rule doing all the catching is exactly the thing the
    // chart should be able to show.
    for (const match of decision.matched) {
      this.d.metrics?.filterHit(input.guildId, match.ruleId, decision.action);
    }

    if (decision.action !== "FLAG") void this.punish(input, decision);

    return { blocked: decision.deleteMessage, decision };
  }

  /**
   * The read-and-evaluate half, exposed on its own so the panel's "test a
   * message" box can run the real policy against real wordlist rules with
   * counters the operator supplies, and never write anything.
   */
  async evaluate(input: AutomodInput, countersOverride?: AutomodCounters): Promise<AutomodDecision> {
    const policy = parseAutomod(await this.d.policy.readPolicy(input.guildId));
    if (!policy.enabled || policy.rules.length === 0) return ALLOW_DECISION;

    // Only paid for when a rule actually needs it: a policy with no wordlist
    // rule never touches the table, and one with no windowed rule never touches
    // Redis.
    const needsWordlist = policy.rules.some(
      (r) => r.enabled && r.trigger.kind === "wordlist" && r.surfaces.includes(input.surface),
    );
    const requests: readonly AutomodCounterRequest[] = counterRequestsFor(policy, input.surface);

    const [wordlist, counters] = await Promise.all([
      needsWordlist ? this.readWordlist(input.guildId) : Promise.resolve<readonly WordlistRuleDTO[]>([]),
      countersOverride !== undefined
        ? Promise.resolve(countersOverride)
        : this.readCounters(input, requests),
    ]);

    return evaluateAutomod(policy, {
      text: input.text,
      surface: input.surface,
      authorRoleIds: input.subject.roleIds,
      authorCapabilities: input.subject.capabilities,
      mentionCount: input.mentionCount,
      counters,
      wordlist,
    });
  }

  private async readWordlist(guildId: string): Promise<readonly WordlistRuleDTO[]> {
    try {
      return await this.d.wordlist.list(guildId);
    } catch (error) {
      this.log.warn("automod could not read the wordlist; wordlist rules skipped", {
        guildId,
        error: String(error),
      });
      return [];
    }
  }

  private async readCounters(
    input: AutomodInput,
    requests: readonly AutomodCounterRequest[],
  ): Promise<AutomodCounters> {
    if (requests.length === 0) return {};
    try {
      return await this.d.counters.read(input.guildId, input.subject.key, input.text, requests);
    } catch (error) {
      // Zero, not "unknown": an unread counter must not be treated as a match.
      this.log.warn("automod counters unreadable; windowed rules skipped", {
        guildId: input.guildId,
        error: String(error),
      });
      return {};
    }
  }

  /**
   * Route the decision into the moderation service.
   *
   * A member with no Discord id — a guild-chat author who has never linked —
   * cannot be punished by the platform, because every punishment we can issue
   * is addressed to a Discord account. The message is still deleted and the
   * match still logged; what is skipped is the part we cannot honestly perform.
   */
  private async punish(input: AutomodInput, decision: AutomodDecision): Promise<void> {
    if (decision.action === "ALLOW" || decision.action === "FLAG") return;

    if (input.subject.discordId === null) {
      this.log.warn("automod could not punish an unlinked author", {
        guildId: input.guildId,
        surface: input.surface,
        subject: input.subject.key,
        action: decision.action,
      });
      return;
    }

    try {
      const result = await this.d.moderation.applyAction({
        guildId: input.guildId,
        type: decision.action,
        actorDiscordId: this.actorId,
        targetDiscordId: input.subject.discordId,
        reason: decision.reason,
        durationSeconds: decision.durationSeconds,
      });
      if (!result.ok) {
        this.log.warn("automod punishment refused", {
          guildId: input.guildId,
          target: input.subject.discordId,
          action: decision.action,
        });
      }
    } catch (error) {
      this.log.error("automod punishment failed", {
        guildId: input.guildId,
        target: input.subject.discordId,
        error: String(error),
      });
    }
  }
}
