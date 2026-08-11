/**
 * What a member is told about their own standing with staff.
 *
 * This exists as a standalone read rather than a method on `ModerationService`
 * because of who calls it. `/me` runs in the member bot, and the member bot must
 * not hold a service that can punish people or read anyone else's history — see
 * `MemberRecordSource` in shared-types. The whole surface here is: this guild,
 * this member, no writes.
 *
 * Two rules from elsewhere are reused rather than restated, which matters:
 * `countWarnsInWindow` is the same counter the escalation ladder fires off, and
 * `inForce` is the same expiry check the audit surfaces use. If a member reads
 * "2 warnings" here and the third one triggers a mute, the two numbers came from
 * the same function; if the card says nothing is being enforced, that is the
 * same answer the bridge would give.
 */
import {
  ok,
  type MemberEscalationDTO,
  type MemberPunishmentDTO,
  type MemberRecordDTO,
  type MemberRecordSource,
  type Result,
} from "@sbr/shared-types";
import { countWarnsInWindow, parsePolicy, rungFor } from "./escalation.js";
import { inForce } from "./expiry.js";
import type { EscalationPolicySource, ModerationRepository } from "./ports.js";

export interface MemberRecordSourceDeps {
  readonly repo: Pick<ModerationRepository, "listActions">;
  /**
   * Omit where the deployment has no escalation policy source. The record then
   * reports warnings and enforcement but no next rung, which is honest: without
   * a policy nothing escalates, so there is no next step to warn about.
   */
  readonly escalation?: EscalationPolicySource;
  readonly now?: () => Date;
}

/**
 * How many rows back the warning count reaches.
 *
 * The window is a date filter, not a row count, so this cap only bites for a
 * member with hundreds of actions inside it — at which point the exact total is
 * not the number they need to see.
 */
const HISTORY_LIMIT = 200;

export function memberRecordSource(deps: MemberRecordSourceDeps): MemberRecordSource {
  const now = deps.now ?? (() => new Date());

  return {
    async forMember(guildId: string, discordId: string): Promise<Result<MemberRecordDTO>> {
      const at = now();
      // One query, filtered twice in memory: warnings by age and punishments by
      // whether they still hold. Asking the store twice for overlapping slices
      // of the same member's history would cost a round trip to answer a card.
      const [history, rawPolicy] = await Promise.all([
        deps.repo.listActions({
          guildId,
          targetDiscordId: discordId,
          limit: HISTORY_LIMIT,
        }),
        deps.escalation?.readPolicy(guildId) ?? Promise.resolve(null),
      ]);

      const policy = parsePolicy(rawPolicy);
      const warnings = countWarnsInWindow(history, policy.windowDays, at);

      const punishments: MemberPunishmentDTO[] = inForce(history, at).map((action) => ({
        type: action.type,
        reason: action.reason,
        expiresAt: action.expiresAt,
      }));
      // Soonest to end first, and anything permanent last: "your mute ends in an
      // hour" is the line a member is looking for, and a standing ban is not
      // news they will have missed.
      punishments.sort((a, b) => {
        if (a.expiresAt === null) return b.expiresAt === null ? 0 : 1;
        if (b.expiresAt === null) return -1;
        return Date.parse(a.expiresAt) - Date.parse(b.expiresAt);
      });

      // Deliberately the rung for `warnings + 1`, not for `warnings`: the member
      // has already served whatever their current count triggered, and the
      // question a record answers is what the *next* one does.
      const next =
        deps.escalation === undefined || !policy.enabled
          ? null
          : rungFor(policy.rungs, warnings + 1);
      const nextEscalation: MemberEscalationDTO | null =
        next === null ? null : { warns: next.warns, action: next.action, durationSeconds: next.durationSeconds };

      return ok({
        warnings,
        windowDays: policy.windowDays,
        inForce: punishments,
        nextEscalation,
      });
    },
  };
}
