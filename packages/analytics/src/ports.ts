import type { AnalyticsEvent } from "@sbr/shared-types";

/**
 * Append-only event sink. Backed by a Redis Stream (buf:analytics) at wiring
 * time so capture stays cheap on the hot path; workers drain + roll up later.
 */
export interface AnalyticsBuffer {
  append(event: AnalyticsEvent): Promise<void>;
}
