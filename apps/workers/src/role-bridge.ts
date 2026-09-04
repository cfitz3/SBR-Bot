/**
 * The workers' client for the admin bot's role effector.
 *
 * The admin bot is the only process holding a gateway to the member server and
 * the only one permitted to make privileged writes to Discord, so a reconcile
 * that has decided somebody should gain a role asks it here. Same shape as
 * `ticket-bridge.ts` and `event-board-bridge.ts` — each app writing its own thin
 * client is the convention in this repo.
 *
 * A failure is never a claim. Everything this returns is what the bot said it
 * actually did, and an unreachable bot returns "nothing happened" rather than
 * an optimistic guess, because the caller writes a grant ledger from it.
 */
import type { Logger } from "@sbr/observability";
import type { RoleApplyOutcome } from "@sbr/jobs";

/** A couple of Discord writes, plus the bot's own member fetch. */
const TIMEOUT_MS = 10_000;

/** Nothing happened, and we are not pretending otherwise. */
const NOTHING: RoleApplyOutcome = Object.freeze({
  ok: false,
  memberPresent: true,
  added: [],
  removed: [],
  refused: [],
});

export interface WorkerRoleEffectorDeps {
  readonly baseUrl: string;
  /** Absent means the admin bot isn't serving; every call reports as unapplied. */
  readonly token: string | undefined;
  readonly logger: Logger;
}

export interface WorkerRoleEffector {
  /**
   * The roles this member holds on Discord now, or `undefined` when the bot
   * could not say.
   *
   * The distinction is the whole point. An empty list means "they hold
   * nothing", which is a fact a reconcile may act on; `undefined` means the
   * question went unanswered, and the caller must fall back to whatever it had
   * rather than conclude a member lost every role.
   */
  heldRoles(guildId: string, userId: string): Promise<readonly string[] | undefined>;
  apply(
    guildId: string,
    userId: string,
    add: readonly string[],
    remove: readonly string[],
    reason: string,
  ): Promise<RoleApplyOutcome>;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function createWorkerRoleEffector(deps: WorkerRoleEffectorDeps): WorkerRoleEffector {
  const base = deps.baseUrl.replace(/\/+$/, "");
  return {
    async heldRoles(guildId, userId) {
      if (deps.token === undefined) return undefined;
      try {
        const url = `${base}/internal/g/${encodeURIComponent(guildId)}/member-roles?userId=${encodeURIComponent(userId)}`;
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${deps.token}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return undefined;
        const body = (await res.json()) as Record<string, unknown>;
        if (body["ok"] !== true || body["present"] !== true) return undefined;
        return strings(body["roleIds"]);
      } catch (error) {
        deps.logger.debug("live role read unavailable", { guildId, userId, error: String(error) });
        return undefined;
      }
    },
    async apply(guildId, userId, add, remove, reason) {
      if (deps.token === undefined) return NOTHING;
      try {
        const res = await fetch(`${base}/internal/g/${encodeURIComponent(guildId)}/roles`, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
          body: JSON.stringify({ userId, add, remove, reason }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          // 404 is the bot not being in that server, which an operator fixes by
          // inviting it; 503 is it still connecting, which fixes itself.
          const level = res.status === 503 ? "debug" : "warn";
          deps.logger[level]("role apply refused", { guildId, userId, status: res.status });
          return NOTHING;
        }
        const body = (await res.json()) as Record<string, unknown>;
        const refused = Array.isArray(body["refused"]) ? body["refused"] : [];
        return {
          ok: body["ok"] === true,
          // Absent means present: the field only ever says "they have left", and
          // reading a missing field as a departure would close every grant they
          // hold on a malformed response.
          memberPresent: body["memberPresent"] !== false,
          added: strings(body["added"]),
          removed: strings(body["removed"]),
          refused: refused.flatMap((row) => {
            const r = row as Record<string, unknown>;
            return typeof r["roleId"] === "string" && typeof r["detail"] === "string"
              ? [{ roleId: r["roleId"], detail: r["detail"] }]
              : [];
          }),
        };
      } catch (error) {
        deps.logger.warn("admin bot role api unreachable", { guildId, userId, error: String(error) });
        return NOTHING;
      }
    },
  };
}
