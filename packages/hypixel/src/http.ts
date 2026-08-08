/**
 * Default HttpFetcher backed by the global fetch (Node 18+). Only used at
 * runtime; tests inject a fake fetcher.
 *
 * Every request is bounded by an AbortSignal. Node's fetch has no default
 * timeout, so without this a connection that opens and then goes quiet blocks
 * the caller forever — and because the worker runs four jobs concurrently, four
 * such requests silently retire the whole process with nothing in the log. A
 * timeout is reported as a normal 5xx-shaped response so the client's existing
 * retry/backoff ladder handles it instead of an exception escaping the port.
 */
import type { HttpFetcher, HttpResponse } from "./ports.js";

/** Generous enough for a cold Hypixel profile read, short enough to fail a hung socket. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Synthetic status for a client-side timeout — retryable, like a gateway timeout. */
const TIMEOUT_STATUS = 504;

export function createFetchHttp(timeoutMs: number = DEFAULT_TIMEOUT_MS): HttpFetcher {
  return {
    async get(url, headers): Promise<HttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetch(url, {
          signal: controller.signal,
          ...(headers ? { headers: headers as Record<string, string> } : {}),
        });
      } catch (error) {
        clearTimeout(timer);
        // An abort is a timeout; anything else is a transport failure (DNS,
        // connection refused, TLS). Both are transient from the caller's point
        // of view, so both surface as a retryable status rather than a throw.
        const aborted = controller.signal.aborted;
        return {
          status: TIMEOUT_STATUS,
          headers: {},
          json: {
            cause: aborted ? "timeout" : "network",
            message: aborted
              ? `request exceeded ${timeoutMs}ms`
              : error instanceof Error
                ? error.message
                : "unknown transport error",
          },
        };
      }

      const flat: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        flat[key.toLowerCase()] = value;
      });

      // The body is read under the same deadline: headers can arrive promptly
      // and the stream then stall, which is indistinguishable from a hang to
      // everything upstream. Only clear the timer once the body is settled.
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      } finally {
        clearTimeout(timer);
      }

      return { status: res.status, headers: flat, json };
    },
  };
}

export const fetchHttp: HttpFetcher = createFetchHttp();
