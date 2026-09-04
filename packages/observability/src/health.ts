/**
 * Health-check registry. Apps register component probes (db, redis, bots, workers)
 * and `run()` aggregates them into a HealthReportDTO for the panel Health page
 * (WEB_PANEL.md §3.11) and container liveness/readiness endpoints.
 */
import type {
  ComponentHealthDTO,
  HealthAggregator,
  HealthCheck,
  HealthReportDTO,
} from "@sbr/shared-types";

export class HealthRegistry implements HealthAggregator {
  private readonly checks: HealthCheck[] = [];

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  async run(): Promise<HealthReportDTO> {
    const components: ComponentHealthDTO[] = await Promise.all(
      this.checks.map(async (c): Promise<ComponentHealthDTO> => {
        try {
          const r = await c.check();
          return r.detail !== undefined
            ? { name: c.name, status: r.status, latencyMs: r.latencyMs, detail: r.detail }
            : { name: c.name, status: r.status, latencyMs: r.latencyMs };
        } catch (error) {
          return {
            name: c.name,
            status: "down",
            latencyMs: null,
            detail: error instanceof Error ? error.message : "check threw",
          };
        }
      }),
    );

    return {
      status: worst(components),
      checkedAt: new Date().toISOString(),
      components,
    };
  }
}

function worst(components: readonly ComponentHealthDTO[]): "ok" | "degraded" | "down" {
  if (components.some((c) => c.status === "down")) return "down";
  if (components.some((c) => c.status === "degraded")) return "degraded";
  return "ok";
}

/** Adapt a simple `{ ok, latencyMs, detail? }` ping into a named HealthCheck. */
export function pingCheck(
  name: string,
  ping: () => Promise<{ ok: boolean; latencyMs: number | null; detail?: string }>,
): HealthCheck {
  return {
    name,
    async check() {
      const r = await ping();
      const status = r.ok ? "ok" : "down";
      return r.detail !== undefined
        ? { status, latencyMs: r.latencyMs, detail: r.detail }
        : { status, latencyMs: r.latencyMs };
    },
  };
}
