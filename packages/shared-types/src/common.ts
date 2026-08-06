/**
 * Core result & data-envelope primitives shared by every service contract.
 * No runtime dependencies — this package is the contract layer everything else
 * can depend on without creating cycles (see ARCHITECTURE.md).
 */

/** Discriminated result type. Domain code branches on `ok`, never try/catch across boundaries. */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

/** Freshness of a served value (HYPIXEL_DATA_LAYER.md). */
export type Freshness = "LIVE" | "STALE";

/** Where a served value came from. */
export type DataSource = "LIVE" | "CACHE" | "WORKER";

/** A value plus provenance so consumers can render "as of Xm ago" and detect staleness. */
export interface DataEnvelope<T> {
  readonly data: T;
  readonly freshness: Freshness;
  /** ISO-8601 timestamp of when the underlying data was fetched. */
  readonly fetchedAt: string;
  readonly source: DataSource;
}

/**
 * Typed fallback states for Hypixel-backed reads. Success carries a DataEnvelope
 * (possibly STALE); failure carries one of these states — never a thrown error.
 */
export type HypixelFailureState =
  | "NOT_LINKED"
  | "MISSING_PROFILE"
  | "API_DISABLED"
  | "RATE_LIMITED";

export interface HypixelFailure {
  readonly state: HypixelFailureState;
  readonly message?: string;
  /** Present on RATE_LIMITED, derived from Retry-After / bucket reset. */
  readonly retryAfterMs?: number;
}

export type HypixelResult<T> = Result<DataEnvelope<T>, HypixelFailure>;

export const hypixelFailure = (
  state: HypixelFailureState,
  extra?: { message?: string; retryAfterMs?: number },
): Result<never, HypixelFailure> => err({ state, ...extra });
