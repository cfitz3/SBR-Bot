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

/**
 * What a user sees when a lookup could not be answered at all. Deliberately
 * distinct from the generic failure text: "try again shortly" is actionable,
 * whereas an invented number or a silent empty result is not.
 */
export const UPSTREAM_UNAVAILABLE_MESSAGE =
  "Hypixel isn't reachable right now and there's nothing cached to fall back on — try again in a minute.";
