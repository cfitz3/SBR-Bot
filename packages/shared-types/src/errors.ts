/**
 * Cross-boundary error recognition.
 *
 * Most upstream problems are already typed — `HypixelResult` carries
 * `RATE_LIMITED`, `API_DISABLED`, `MISSING_PROFILE` as values. What is left is
 * the genuinely exceptional case: the source is unreachable *and* there is no
 * cache to fall back on, which the Hypixel client raises as
 * `HypixelUnavailableError`.
 *
 * The command layer has to render that honestly, but it must not depend on
 * `@sbr/hypixel` to do so — a data-source package is exactly the wrong thing for
 * a transport-agnostic command to import. So the check is structural.
 */

/** Error names that mean "upstream is down and we have nothing cached". */
const UNAVAILABLE_NAMES = new Set(["HypixelUnavailableError"]);

export function isUpstreamUnavailable(error: unknown): boolean {
  return error instanceof Error && UNAVAILABLE_NAMES.has(error.name);
}

// What a user *sees* when this predicate is true used to be a constant here.
// It now lives at `error.generic.upstreamDown` in the brand layer, with every
// other sentence the platform says, so a guild can reword it. The predicate
// stays: recognising the condition is shared-types' job, wording it is not —
// and this package cannot import the brand layer, which depends on it.
