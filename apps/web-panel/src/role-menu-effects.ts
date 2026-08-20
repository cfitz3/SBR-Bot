/**
 * The panel's client for the bridge bot's role-menu API.
 *
 * A third near-copy of `ticket-effects.ts`, and deliberately not a shared
 * client with them: what differs between these files is the one thing worth
 * keeping separate — what a failure means and how it is worded to the person
 * who pressed the button. Merging them would save thirty lines and cost the
 * ability to say "give the menu a channel" instead of "500".
 *
 * The message itself belongs to the bridge bot, which is the member-facing one:
 * members press these buttons, so it must be that application's message.
 */
import type { RoleMenuEffects } from "@sbr/panel-core";
import type { Logger } from "@sbr/observability";

/** One Discord REST round trip on the bot's side, like the other two. */
const TIMEOUT_MS = 10_000;

interface RoleMenuEffectsDeps {
  /** Where the bridge bot listens. Loopback unless the two are split apart. */
  readonly baseUrl: string;
  /** Absent means the bridge isn't serving — the mutation says so instead. */
  readonly token: string | undefined;
  readonly logger: Logger;
}

interface Failure {
  readonly problem?: unknown;
  readonly detail?: unknown;
}

/**
 * Constructed unconditionally: a missing token becomes a readable refusal at
 * press time rather than a button that is absent for a reason nobody can see.
 */
export function createRoleMenuEffects(deps: RoleMenuEffectsDeps): RoleMenuEffects {
  return {
    async publishMenu(guildId, menuId, channelId) {
      if (deps.token === undefined) {
        throw new Error("No bot is connected to do that — set INTERNAL_API_TOKEN on the bridge bot and the panel");
      }
      const url = `${deps.baseUrl.replace(/\/+$/, "")}/internal/g/${encodeURIComponent(guildId)}/role-menu`;

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
          body: JSON.stringify({ menuId, channelId }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        deps.logger.warn("bridge role menu api unreachable", { guildId, menuId, error: String(error) });
        throw new Error("The bridge bot isn't reachable — check that it is running");
      }

      if (res.ok) return;

      // `detail` is written for whoever pressed the button ("I can't post in
      // that channel"), so it beats anything this file could say about a status.
      const payload = (await res.json().catch(() => ({}))) as Failure;
      const detail = typeof payload.detail === "string" ? payload.detail : null;
      if (detail !== null) throw new Error(detail);
      if (res.status === 401) throw new Error("INTERNAL_API_TOKEN differs between the panel and the bridge bot");
      throw new Error(`The bridge bot refused that (${String(res.status)})`);
    },
  };
}
