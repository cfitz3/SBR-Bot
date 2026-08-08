/**
 * Recruitment (WEB_PANEL.md §3.7) — the two queues that wait on a human:
 * applications to decide and tickets to close.
 *
 * They share a page because they share a working pattern — read what someone
 * wrote, type a reason, resolve it — not because they share a table. Each row
 * carries its own reason box and its own status line, so a refused decision
 * says which application it was about.
 *
 * The entry requirements are shown here but edited on Settings: this page is
 * where you find out that an applicant is under the bar, which is a different
 * job from deciding where the bar sits.
 */
import type { PanelApplication, PanelTicket, RecruitmentVM } from "@sbr/panel-core";
import { loadPage, postAction } from "../api.js";
import {
  badge,
  card,
  deniedState,
  emptyState,
  errorState,
  pageTitle,
  spinner,
  statTile,
  table,
  type BadgeTone,
} from "../components.js";
import { h, replace } from "../dom.js";
import { actionButton, reasonBox, statusSlot } from "../forms.js";
import { count, relativeTime } from "../format.js";

/** Statuses still waiting on a decision. */
const PENDING = new Set(["SUBMITTED", "UNDER_REVIEW"]);
/** Ticket statuses that are still someone's problem. */
const OPEN = new Set(["OPEN", "PENDING"]);

export async function renderRecruitment(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading recruitment…"));

  const result = await loadPage<RecruitmentVM>(`/api/guilds/${encodeURIComponent(guildId)}/recruitment`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderRecruitment(host, guildId)));
  }

  const data = result.data;
  const rerender = (): void => void renderRecruitment(host, guildId);

  const pending = data.applications.filter((a) => PENDING.has(a.status));
  const decided = data.applications.filter((a) => !PENDING.has(a.status));
  const open = data.tickets.filter((t) => OPEN.has(t.status));

  replace(
    host,
    h(
      "div",
      {},
      pageTitle(
        "Recruitment",
        `${count(pending.length)} application(s) and ${count(open.length)} ticket(s) waiting`,
      ),
      h(
        "div",
        { class: "tiles" },
        statTile("Applications open", data.recruitmentOpen ? "Yes" : "No", "Change on Settings"),
        statTile("Minimum weight", data.minWeight === null ? "none" : count(data.minWeight)),
        statTile("Minimum networth", data.minNetworth === null ? "none" : count(data.minNetworth)),
      ),
      card("Waiting on a decision", pendingBody(guildId, pending, rerender)),
      card("Open tickets", ticketsBody(guildId, open, rerender)),
      card("Recently decided", decidedBody(decided)),
    ),
  );
}

function pendingBody(
  guildId: string,
  applications: readonly PanelApplication[],
  rerender: () => void,
): HTMLElement {
  if (applications.length === 0) {
    return emptyState("Nothing to review. New applications land here as they're submitted.");
  }
  return h("div", { class: "queue" }, ...applications.map((app) => applicationRow(guildId, app, rerender)));
}

function applicationRow(guildId: string, app: PanelApplication, rerender: () => void): HTMLElement {
  const status = statusSlot();
  const reason = reasonBox("Reason — required to reject, optional to accept", 2);

  const decide = (accept: boolean) => async () =>
    postAction(guildId, "application.decide", {
      applicationId: app.id,
      accept,
      reason: reason.value.trim(),
    });

  return h(
    "article",
    { class: "queue-item" },
    h(
      "header",
      { class: "queue-head" },
      h("code", {}, app.applicantDiscordId),
      badge(app.status.toLowerCase().replace("_", " "), "neutral"),
      h("span", { class: "muted" }, `submitted ${relativeTime(app.submittedAt)}`),
    ),
    answersBody(app.answers),
    h("div", { class: "field-row" }, reason),
    h(
      "div",
      { class: "field-row" },
      actionButton({
        label: "Accept",
        tone: "primary",
        status,
        run: decide(true),
        onDone: rerender,
      }),
      actionButton({
        label: "Reject",
        tone: "danger",
        confirm: "Confirm reject",
        status,
        run: async () => {
          if (reason.value.trim().length === 0) {
            // The mutation layer refuses this too; catching it here keeps the
            // applicant-facing message from costing a round trip.
            return { kind: "error", message: "A rejection needs a reason — the applicant reads it." };
          }
          return decide(false)();
        },
        onDone: rerender,
      }),
      status.el,
    ),
  );
}

/**
 * Application answers are stored as free-form JSON, so this renders whatever
 * shape arrived rather than assuming a question set. Anything that isn't a flat
 * object is shown as text — unreadable is better than dropped, on a page whose
 * whole purpose is reading what someone wrote.
 */
function answersBody(answers: unknown): HTMLElement {
  if (answers === null || answers === undefined) {
    return h("p", { class: "muted" }, "No answers were recorded with this application.");
  }
  if (typeof answers !== "object" || Array.isArray(answers)) {
    return h("p", { class: "answer-value" }, String(answers));
  }

  const entries = Object.entries(answers as Record<string, unknown>);
  if (entries.length === 0) {
    return h("p", { class: "muted" }, "No answers were recorded with this application.");
  }

  return h(
    "dl",
    { class: "answers" },
    ...entries.flatMap(([question, answer]) => [
      h("dt", {}, question),
      h("dd", {}, answer === null || answer === undefined ? "—" : String(answer)),
    ]),
  );
}

function ticketsBody(guildId: string, tickets: readonly PanelTicket[], rerender: () => void): HTMLElement {
  if (tickets.length === 0) return emptyState("No open tickets.");
  return h("div", { class: "queue" }, ...tickets.map((ticket) => ticketRow(guildId, ticket, rerender)));
}

function ticketRow(guildId: string, ticket: PanelTicket, rerender: () => void): HTMLElement {
  const status = statusSlot();
  const reason = reasonBox("Closing note (optional)", 2);

  return h(
    "article",
    { class: "queue-item" },
    h(
      "header",
      { class: "queue-head" },
      h("strong", {}, ticket.subject ?? `${ticket.category} ticket`),
      badge(ticket.category.toLowerCase(), "neutral"),
      badge(ticket.status.toLowerCase(), ticket.status === "OPEN" ? "warn" : "neutral"),
      h("span", { class: "muted" }, `opened ${relativeTime(ticket.createdAt)}`),
    ),
    h(
      "p",
      { class: "muted" },
      "by ",
      h("code", {}, ticket.openerDiscordId),
      ticket.assigneeDiscordId ? " · assigned to " : " · unassigned",
      ticket.assigneeDiscordId ? h("code", {}, ticket.assigneeDiscordId) : null,
    ),
    h("div", { class: "field-row" }, reason),
    h(
      "div",
      { class: "field-row" },
      actionButton({
        label: "Close ticket",
        confirm: "Confirm close",
        status,
        run: () => postAction(guildId, "ticket.close", { ticketId: ticket.id, reason: reason.value.trim() }),
        onDone: rerender,
      }),
      status.el,
    ),
  );
}

function decidedBody(applications: readonly PanelApplication[]): HTMLElement {
  if (applications.length === 0) return emptyState("No decisions recorded yet.");
  return table(
    ["Applicant", "Outcome", "Reviewer", "Decided"],
    applications.map((app) => [
      h("code", {}, app.applicantDiscordId),
      badge(app.status.toLowerCase(), outcomeTone(app.status)),
      app.reviewerDiscordId ? h("code", {}, app.reviewerDiscordId) : "—",
      relativeTime(app.decidedAt),
    ]),
  );
}

function outcomeTone(status: string): BadgeTone {
  if (status === "ACCEPTED") return "ok";
  if (status === "REJECTED") return "bad";
  return "neutral";
}
