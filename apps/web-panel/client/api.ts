/**
 * Thin client over the panel's JSON API.
 *
 * Every guild-scoped endpoint answers with `PageResult` — the access decision
 * travels with the data — so this module's job is to turn HTTP status plus that
 * envelope into one value the pages can switch on, rather than leaving each page
 * to re-derive "am I logged out or just not allowed here".
 */
import type { AccessDecision, DenyReason, MutationResult, PageResult } from "@sbr/panel-core";

export type ApiResult<T> =
  | { readonly kind: "ok"; readonly data: T; readonly access: Extract<AccessDecision, { allowed: true }> }
  | { readonly kind: "denied"; readonly reason: DenyReason }
  | { readonly kind: "error"; readonly message: string };

export async function loadPage<T>(path: string): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: "application/json" }, credentials: "same-origin" });
  } catch {
    // Offline, DNS, or a dropped connection — distinct from the server saying no.
    return { kind: "error", message: "Couldn't reach the panel server." };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  const envelope = body as PageResult<T> | { error?: string } | undefined;

  if (envelope && "access" in envelope) {
    if (envelope.access.allowed) {
      return { kind: "ok", data: envelope.data as T, access: envelope.access };
    }
    return { kind: "denied", reason: envelope.access.reason };
  }

  // No envelope: either a transport-level failure or a route that answers with a
  // bare `{ error }`. 401 still means "log in", so it keeps its own shape.
  if (res.status === 401) return { kind: "denied", reason: "NOT_AUTHENTICATED" };
  const code = envelope && "error" in envelope ? envelope.error : undefined;
  return { kind: "error", message: describeError(res.status, code) };
}

/**
 * Perform a guild-scoped write.
 *
 * Success carries no payload on purpose: a write is followed by re-reading the
 * page it changed, so returning a partial view model here would give the UI two
 * sources of truth for the same config and a way for them to disagree. `note` is
 * the exception and not a payload — it is a caveat about the write itself, which
 * re-reading the page cannot recover.
 */
export type WriteResult =
  | { readonly kind: "ok"; readonly note?: string }
  | { readonly kind: "denied"; readonly reason: DenyReason }
  | { readonly kind: "error"; readonly message: string };

export async function postAction(
  guildId: string,
  action: string,
  body: Readonly<Record<string, unknown>>,
): Promise<WriteResult> {
  const csrf = readCookie(CSRF_COOKIE);
  if (csrf === null) {
    // The cookie is set at login beside the session, so its absence means the
    // session predates writes or has expired — either way, signing in again is
    // the fix, and saying so beats a bare 403 from the server.
    return { kind: "denied", reason: "NOT_AUTHENTICATED" };
  }

  let res: Response;
  try {
    res = await fetch(`/api/guilds/${encodeURIComponent(guildId)}/actions/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": csrf },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "error", message: "Couldn't reach the panel server." };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = undefined;
  }

  const envelope = payload as MutationResult | { error?: string } | undefined;
  if (envelope && "access" in envelope) {
    if (!envelope.access.allowed) return { kind: "denied", reason: envelope.access.reason };
    if (envelope.error === null) {
      const note = "note" in envelope ? envelope.note : undefined;
      return { kind: "ok", ...(note === undefined ? {} : { note }) };
    }
    return { kind: "error", message: describeWriteError(envelope.error) };
  }

  if (res.status === 401) return { kind: "denied", reason: "NOT_AUTHENTICATED" };
  const code = envelope && "error" in envelope ? envelope.error : undefined;
  return { kind: "error", message: describeError(res.status, code) };
}

const CSRF_COOKIE = "sbr_csrf";

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name && rest.length > 0) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function describeWriteError(error: Exclude<MutationResult["error"], null>): string {
  switch (error.kind) {
    case "RATE_LIMITED": {
      const seconds = Math.max(1, Math.ceil((error.retryAfterMs ?? 0) / 1000));
      return `Too many changes at once — try again in ${seconds}s.`;
    }
    case "INVALID_INPUT":
      return error.detail ? `That value isn't valid: ${error.detail}.` : "That value isn't valid.";
    case "SERVICE_ERROR":
      return error.detail ? `The change was refused (${error.detail}).` : "The change was refused.";
  }
}

function describeError(status: number, code: string | undefined): string {
  if (code === "oauth_not_configured") return "Discord login isn't configured on this deployment.";
  if (status === 404) return "That page doesn't exist.";
  if (status >= 500) return "The panel server hit an error. Try again in a moment.";
  return code ? `Request failed (${code}).` : `Request failed (HTTP ${status}).`;
}

export function denialMessage(reason: DenyReason): string {
  switch (reason) {
    case "NOT_AUTHENTICATED":
      return "Sign in with Discord to continue.";
    case "NOT_MANAGEABLE":
      return "You don't have Manage Server on this Discord guild, or the platform doesn't know about it yet.";
    case "INSUFFICIENT_ROLE":
      return "Your role in this guild doesn't reach the tier this page requires.";
  }
}
