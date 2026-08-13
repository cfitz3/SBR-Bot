/**
 * `npm run skykings:probe` — answers one question: is the scammer lookup back?
 *
 * The scammer route (`GET /user/lookup`) has been answering 404 while every
 * other route on the same host answers normally on the same key. That is an
 * awkward thing to be sure about from inside the bot, because "404" is also
 * what a wrong path, a wrong base URL, a bad key or a missing scope would look
 * like from the outside. This script settles it with one specific test.
 *
 * **The decisive test is the unauthenticated request.** SkyKings mounts its
 * auth middleware per-route, so a request with *no key at all* to a route that
 * exists is rejected by auth (401), and only a route that was never mounted
 * falls through the router to the 404 handler. So:
 *
 *   - `/user/lookup` with no key → **401/403** means the route exists and the
 *     problem is ours (key, scope, header form). Fix it here.
 *   - `/user/lookup` with no key → **404** means the route is not mounted, and
 *     no credential or header we send can change that. Nothing to fix here.
 *
 * Read-only, sends the key to nobody but SkyKings, and never prints it.
 * Exits 0 when the lookup works, 1 when it does not — so it can be a cron
 * canary rather than something somebody has to remember to run.
 */
import { c, readEnv, say } from "./lib.mjs";

const BASE = process.env["SKYKINGS_BASE_URL"] ?? "https://api.skykings.net";

/** The docs' own sample identifiers, so a failure can never be our formatting. */
const SAMPLE_UUID = "747cf09448c244059b5a67c53f509c6e";
const SAMPLE_USERID = "610547464033796106";

const PASS = c.green("✓");
const FAIL = c.red("✗");
const NOTE = c.yellow("!");

const env = readEnv();
const key = (env.get("SKYKINGS_API_KEY") ?? process.env["SKYKINGS_API_KEY"] ?? "").trim();

say(c.bold("\nSkyKings API probe"));
say(c.gray(`  base ${BASE}`));
say(c.gray(`  key  ${key.length > 0 ? `present (${key.length} chars)` : "absent"}`));

/**
 * One request, reduced to what the probe reasons about. A transport failure is
 * reported as its own status rather than thrown: "the host is unreachable" and
 * "the host said no" are different findings and the operator wants to see which.
 */
async function probe(path, { auth = true } = {}) {
  const headers = { Accept: "application/json" };
  if (auth && key.length > 0) headers["Authorization"] = key;
  try {
    const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* a non-JSON body is itself the finding; `body` stays null */
    }
    return { status: res.status, body, text: text.slice(0, 200) };
  } catch (error) {
    return { status: 0, body: null, text: error instanceof Error ? error.message : "request failed" };
  }
}

/** Upstream states its failures in `message`/`error`; a success has neither. */
const detail = (r) => r.body?.message ?? r.body?.error ?? (r.body === null ? r.text : "ok");

// ── the routes we know answer, so a total outage is distinguishable ──────────

say(c.bold("\nControl routes"));

const health = await probe("/health", { auth: false });
const healthOk = health.status === 200 && health.body?.status === "healthy";
say(`  ${healthOk ? PASS : FAIL} ${"/health".padEnd(24)} ${c.gray(`${health.status} ${detail(health)}`)}`);

const info = await probe(`/user/info?uuid=${SAMPLE_UUID}`);
const infoOk = info.status === 200 && info.body?.success === true;
say(`  ${infoOk ? PASS : FAIL} ${"/user/info".padEnd(24)} ${c.gray(`${info.status} ${detail(info)}`)}`);

// ── the route in question ────────────────────────────────────────────────────

say(c.bold("\nScammer lookup"));

const withKey = await probe(`/user/lookup?userid=${SAMPLE_USERID}`);
const readable = withKey.status === 200 && typeof withKey.body?.result?.scammer === "boolean";
say(`  ${readable ? PASS : FAIL} ${"with our key".padEnd(24)} ${c.gray(`${withKey.status} ${detail(withKey)}`)}`);

// Only asked when the keyed request failed: it is the discriminator, and there
// is no reason to send an extra anonymous request at a working endpoint.
const anon = readable ? null : await probe(`/user/lookup?userid=${SAMPLE_USERID}`, { auth: false });
if (anon !== null) {
  const routeExists = anon.status === 401 || anon.status === 403;
  say(`  ${routeExists ? NOTE : FAIL} ${"with no key".padEnd(24)} ${c.gray(`${anon.status} ${detail(anon)}`)}`);
}

// ── verdict ──────────────────────────────────────────────────────────────────

say("");
if (readable) {
  say(`${PASS} ${c.bold("The scammer lookup is answering.")}`);
  say(c.gray("  Screening will produce CLEAR/FLAGGED verdicts again with no code change."));
  say(c.gray("  Drop the outage notes in packages/skykings/src/client.ts and docs/BRIDGE_BOT.md §6A.3."));
  process.exit(0);
}

if (!healthOk) {
  say(`${FAIL} ${c.bold("The whole API is unreachable.")} This is an outage, not a routing question.`);
} else if (key.length === 0) {
  say(`${FAIL} ${c.bold("No SKYKINGS_API_KEY is set,")} so this probe cannot tell you anything about the route.`);
} else if (anon?.status === 404) {
  say(`${FAIL} ${c.bold("The route is not mounted upstream.")}`);
  say(c.gray("  An anonymous request 404s where /user/info 401s, so the router never reaches auth."));
  say(c.gray("  No key, header form, method or path variant we send can change that — ask SkyKings."));
} else if (anon?.status === 401 || anon?.status === 403) {
  say(`${FAIL} ${c.bold("The route exists and is refusing us.")} This one is ours to fix.`);
  say(c.gray("  Check the key's scopes and the Authorization header form in packages/skykings/src/client.ts."));
} else {
  say(`${FAIL} ${c.bold("The lookup failed in a way this probe does not recognise.")}`);
  say(c.gray(`  keyed: ${withKey.status} · anonymous: ${anon?.status ?? "n/a"}`));
}
process.exit(1);
