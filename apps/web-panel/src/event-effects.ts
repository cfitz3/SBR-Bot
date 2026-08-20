/**
 * The panel's client for the bridge bot's event-board API.
 *
 * A near-copy of `ticket-effects.ts` rather than a shared client, for the same
 * reason `event-board-bridge.ts` is a near-copy of `ticket-bridge.ts` on the
 * worker side: the two differ in exactly the part that matters — what a failure
 * means. A worker's board pass swallows an error and tries again in half an
 * hour; a person who pressed "Update board" is standing there waiting, so every
 * failure here throws and `PanelMutations` turns the message into what the page
 * shows. Merging them would mean one of the two silently getting the other's
 * behaviour.
 */
import type { EventEffects } from "@sbr/panel-core";
import type { Logger } from "@sbr/observability";

/** One Discord REST round trip on the bot's side, like the ticket effects. */
const TIMEOUT_MS = 10_000;

interface EventEffectsDeps {
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
 * `detail` is written for whoever pressed the button ("the board opens when the
 * event goes live"), so it is preferred over anything this file could say about
 * a status code. A body that is not JSON at all falls back to the status, which
 * still separates "wrong token" from "bot is down".
 */
async function call(deps: EventEffectsDeps, path: string, body: unknown): Promise<void> {
  if (deps.token === undefined) {
    throw new Error("No bot is connected to do that — set INTERNAL_API_TOKEN on the bridge bot and the panel");
  }
  const url = `${deps.baseUrl.replace(/\/+$/, "")}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    deps.logger.warn("bridge event api unreachable", { path, error: String(error) });
    throw new Error("The bridge bot isn't reachable — check that it is running");
  }

  if (res.ok) return;

  const payload = (await res.json().catch(() => ({}))) as Failure;
  const detail = typeof payload.detail === "string" ? payload.detail : null;
  if (detail !== null) throw new Error(detail);
  if (res.status === 401) throw new Error("INTERNAL_API_TOKEN differs between the panel and the bridge bot");
  throw new Error(`The bridge bot refused that (${String(res.status)})`);
}

/**
 * Constructed unconditionally, like the ticket effects: a missing token becomes
 * a readable refusal at press time rather than a button that is absent for a
 * reason nobody can see.
 */
export function createEventEffects(deps: EventEffectsDeps): EventEffects {
  return {
    async publishBoard(guildId, eventId) {
      await call(deps, `/internal/g/${encodeURIComponent(guildId)}/event-board`, { eventId });
    },
  };
}
