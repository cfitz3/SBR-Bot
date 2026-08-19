/**
 * The panel's client for the bridge bot's ticket API.
 *
 * Sibling of `directory.ts`, and deliberately the opposite of it in one
 * respect: the directory never fails hard, because a picker is a convenience
 * and losing it must not take a settings page down. These two are the reverse.
 * "Publish" and "Re-send transcript" are the actions the tickets rebuild exists
 * to make trustworthy, so a failure here has to reach the operator as words —
 * a panel that reports "published" with no message in the channel is precisely
 * the bug being removed. Every failure throws, and `PanelMutations` turns the
 * thrown message into what the page shows.
 */
import type { TicketEffects } from "@sbr/panel-core";
import type { Logger } from "@sbr/observability";

/**
 * Longer than the directory's three seconds: publishing posts or edits a real
 * Discord message, and re-sending a transcript renders and uploads a file. Both
 * are one REST round trip on the bot's side, and Discord is occasionally slow
 * rather than down.
 */
const TIMEOUT_MS = 10_000;

interface TicketEffectsDeps {
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
 * The bridge's answer, or a thrown error carrying its `detail`.
 *
 * `detail` is written for the person who pressed the button ("check my
 * permissions in that channel"), so it is preferred over anything this file
 * could say about a status code. A response that is not JSON at all — a proxy
 * page, a truncated body — falls back to the status, which at least separates
 * "wrong token" from "bot is down".
 */
async function call(deps: TicketEffectsDeps, path: string, body: unknown): Promise<Record<string, unknown>> {
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
    deps.logger.warn("bridge ticket api unreachable", { path, error: String(error) });
    throw new Error("The bridge bot isn't reachable — check that it is running");
  }

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown> & Failure;
  if (res.ok) return payload;

  const detail = typeof payload.detail === "string" ? payload.detail : null;
  if (detail !== null) throw new Error(detail);
  if (res.status === 401) throw new Error("INTERNAL_API_TOKEN differs between the panel and the bridge bot");
  throw new Error(`The bridge bot refused that (${String(res.status)})`);
}

/**
 * Constructed unconditionally, like the directory: a missing token becomes a
 * readable refusal at press time rather than a mutation that reports "no bot is
 * connected" whether or not one is.
 */
export function createTicketEffects(deps: TicketEffectsDeps): TicketEffects {
  return {
    async publishPanel(guildId, panelId) {
      await call(deps, `/internal/g/${encodeURIComponent(guildId)}/ticket-panel`, { panelId });
    },
    async resendTranscript(guildId, ticketId) {
      await call(deps, `/internal/g/${encodeURIComponent(guildId)}/ticket-transcript`, { ticketId });
    },
  };
}
