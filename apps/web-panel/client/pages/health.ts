/**
 * Health / status (WEB_PANEL.md §3.11).
 *
 * Sorted worst-first: a Health page is read when something is suspected to be
 * broken, and alphabetical order buries the one row that matters.
 */
import type { HealthVM } from "@sbr/panel-core";
import { loadPage, postAction } from "../api.js";
import { badge, card, deniedState, emptyState, errorState, pageTitle, spinner, table } from "../components.js";
import { scope } from "../copy.js";
import { h, replace } from "../dom.js";
import { actionButton, statusSlot } from "../forms.js";
import { count, describeSpan, duration, humanizeJob, relativeTime } from "../format.js";

const t = scope("health");
const c = scope("common");

type JobRow = HealthVM["jobs"][number];
type ServiceRow = HealthVM["services"][number];

export async function renderHealth(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("health"));

  const result = await loadPage<HealthVM>(`/api/guilds/${encodeURIComponent(guildId)}/health`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderHealth(host, guildId)));
  }

  const jobs = [...result.data.jobs].sort(bySeverity);
  const unhealthy = jobs.filter(isUnhealthy).length;

  const body =
    jobs.length === 0
      ? emptyState("healthJobs")
      : table(
          [t("colJob"), t("colStatus"), t("colLastRun"), t("colDuration"), t("colFailures"), ""],
          jobs.map((job) => [
            jobCell(job),
            statusBadge(job),
            relativeTime(job.lastRunAt),
            duration(job.durationMs),
            count(job.failuresLastDay),
            runCell(job, guildId, host),
          ]),
        );

  const services = result.data.services;
  const down = services.filter((s) => s.status !== "UP").length;
  const subtitle =
    down > 0
      ? t("subtitleServicesDown").replace("{n}", String(down))
      : unhealthy === 0
        ? t("subtitleHealthy")
        : t("subtitleJobsUnhealthy").replace("{n}", String(unhealthy));

  replace(
    host,
    h(
      "div",
      {},
      pageTitle(t("title"), subtitle),
      card(t("cardProcesses"), servicesBody(services)),
      card(t("cardWorkers"), body),
    ),
  );
}

/**
 * Live processes, from the Redis heartbeat keys.
 *
 * A service with no beat is rendered as a row saying DOWN rather than omitted:
 * the absence *is* the finding, and a table that only lists what answered can't
 * show you the bot that stopped.
 */
function servicesBody(services: readonly ServiceRow[]): HTMLElement {
  if (services.length === 0) return emptyState("healthServices");
  return table(
    [t("colService"), t("colStatus"), t("colInstances"), t("colLastBeat"), t("colDetail")],
    [...services].sort(byServiceSeverity).map((service) => [
      service.service,
      serviceBadge(service),
      count(service.instances.length),
      service.instances[0] === undefined
        ? c("never")
        : t("beatAgo").replace("{span}", describeSpan(service.instances[0].ageMs)),
      serviceDetail(service),
    ]),
  );
}

function serviceBadge(service: ServiceRow): HTMLElement {
  if (service.status === "DOWN") return badge(t("serviceDown"), "bad");
  if (service.status === "STALE") return badge(t("serviceStale"), "warn");
  return badge(t("serviceUp"), "ok");
}

/**
 * Whatever the process chose to report about itself — gateway readiness, ping,
 * whether the in-game session is spawned. Rendered as plain key=value because
 * each service publishes its own shape and the panel deliberately doesn't
 * hard-code a schema per bot.
 */
function serviceDetail(service: ServiceRow): HTMLElement {
  const freshest = service.instances[0];
  if (freshest === undefined) return h("span", { class: "muted" }, t("noHeartbeat"));
  const pairs = Object.entries(freshest.details).map(([key, value]) => `${key}=${String(value)}`);
  return h(
    "div",
    { class: "job-cell" },
    h("span", { class: "muted" }, freshest.instance),
    pairs.length > 0 ? h("span", { class: "job-detail" }, pairs.join("  ")) : null,
  );
}

function byServiceSeverity(a: ServiceRow, b: ServiceRow): number {
  const rank = (s: ServiceRow): number => (s.status === "DOWN" ? 0 : s.status === "STALE" ? 1 : 2);
  return rank(a) - rank(b) || a.service.localeCompare(b.service);
}

/** The job id, with its last error underneath when there is one. */
function jobCell(job: JobRow): HTMLElement {
  return h(
    "div",
    { class: "job-cell" },
    h("span", {}, humanizeJob(job.type)),
    job.error ? h("span", { class: "job-error" }, job.error) : null,
  );
}

/**
 * "Run now".
 *
 * The request is published to the worker fleet, not enqueued here, so a green
 * status line means *asked*, not *ran* — the note says so, and the last-run
 * column is what turns the request into a fact. A row this deployment will not
 * start by hand gets no button rather than a disabled one: there is nothing the
 * reader could do to enable it, so the affordance would only raise a question.
 */
function runCell(job: JobRow, guildId: string, host: HTMLElement): HTMLElement {
  if (!job.runnable) return h("span", { class: "muted" }, c("dash"));
  const status = statusSlot();
  return h(
    "div",
    { class: "job-run" },
    actionButton({
      label: t("runNow"),
      status,
      run: () => postAction(guildId, "health.run-job", { jobName: job.type }),
      // Re-read after a beat rather than immediately: the queue has to accept
      // the job and the runner has to write its log row before a re-read shows
      // anything, and a table that visibly redraws unchanged reads as failure.
      onDone: () => window.setTimeout(() => void renderHealth(host, guildId), 4_000),
    }),
    status.el,
  );
}

function statusBadge(job: JobRow): HTMLElement {
  if (job.lastStatus === "FAILED" || job.error) return badge(t("jobFailing"), "bad");
  if (job.stale) return badge(t("jobStale"), "warn");
  if (job.lastRunAt === null) return badge(t("jobNeverRun"), "bad");
  return badge(t("jobOk"), "ok");
}

function isUnhealthy(job: JobRow): boolean {
  return job.stale || job.error !== null || job.lastStatus === "FAILED" || job.lastRunAt === null;
}

/** Failing, then stale, then everything else; ties broken by name for stability. */
function severity(job: JobRow): number {
  if (job.lastStatus === "FAILED" || job.error) return 0;
  if (job.lastRunAt === null) return 1;
  if (job.stale) return 2;
  return 3;
}

function bySeverity(a: JobRow, b: JobRow): number {
  return severity(a) - severity(b) || a.type.localeCompare(b.type);
}
