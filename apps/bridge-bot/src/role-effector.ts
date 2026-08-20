/**
 * The bridge bot's client for the admin bot's role effector.
 *
 * The split is the ownership rule, not an accident of layout: members press
 * buttons on messages this bot posted, and this bot is the one they see — but
 * privileged writes to the member server belong to the admin bot, which holds
 * the intent, the permission and the preflight that refuses a staff role. So a
 * self-service press decides here and applies there, exactly as a ticket action
 * does.
 *
 * Same shape as `apps/workers/src/role-bridge.ts`; each app writing its own thin
 * client is the convention in this repo. And the same rule holds: **a failure is
 * never a claim.** An unreachable admin bot reports that nothing happened, so
 * the member is told the truth rather than shown a role they did not get.
 */
import type { Logger } from "@sbr/observability";

/** One member fetch plus at most two Discord writes. */
const TIMEOUT_MS = 10_000;

/** What the admin bot says it actually did. */
export interface RoleApplyOutcome {
  readonly ok: boolean;
  /** False when they are not in the Discord server at all. */
  readonly memberPresent: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly refused: readonly { readonly roleId: string; readonly detail: string }[];
}

/** Nothing happened, and we are not pretending otherwise. */
const NOTHING: RoleApplyOutcome = Object.freeze({
  ok: false,
  memberPresent: true,
  added: [],
  removed: [],
  refused: [],
});

export interface BridgeRoleEffectorDeps {
  readonly baseUrl: string;
  /** Absent means the admin bot isn't serving; every call reports as unapplied. */
  readonly token: string | undefined;
  readonly logger: Logger;
}

export interface BridgeRoleEffector {
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

export function createBridgeRoleEffector(deps: BridgeRoleEffectorDeps): BridgeRoleEffector {
  const base = deps.baseUrl.replace(/\/+$/, "");
  return {
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
          // 503 is the admin bot still connecting, which fixes itself; anything
          // else is worth an operator's attention.
          const level = res.status === 503 ? "debug" : "warn";
          deps.logger[level]("role apply refused", { guildId, userId, status: res.status });
          return NOTHING;
        }
        const body = (await res.json()) as Record<string, unknown>;
        const refused = Array.isArray(body["refused"]) ? body["refused"] : [];
        return {
          ok: body["ok"] === true,
          // Absent means present: the field only ever says "they have left".
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
