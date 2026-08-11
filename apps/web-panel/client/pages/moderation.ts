/**
 * Moderation (WEB_PANEL.md §3.6) — look a member up, read their history, and
 * act on them.
 *
 * The page is organised around a *target*, because that is the question staff
 * actually arrive with ("what has this person done before?"). With no target it
 * still renders: the recent-actions table becomes the guild-wide audit trail,
 * which is the other reason to open this page.
 *
 * The action form deliberately does not pre-check rank. Whether the actor
 * outranks the target is `ModerationService`'s decision, and a second copy of
 * that rule here would be one that drifts — so a refusal arrives as a message on
 * the form rather than as a control that was never offered.
 */
import type { ModerationActionVM, ModerationVM } from "@sbr/panel-core";
import { loadPage, postAction } from "../api.js";
import {
  badge,
  card,
  deniedState,
  emptyState,
  errorState,
  pageTitle,
  spinner,
  table,
  type BadgeTone,
} from "../components.js";
import { h, replace } from "../dom.js";
import { actionButton, isSnowflake, reasonBox, statusSlot } from "../forms.js";
import { count, describeSpan, parseDurationSeconds, relativeTime } from "../format.js";

/** The actions the panel is allowed to issue — mirrors `PANEL_ACTIONS`. */
const ACTIONS: readonly (readonly [string, string, string])[] = [
  ["NOTE", "Note", "A private record. Nothing is enforced and the member is not told."],
  ["WARN", "Warn", "A logged warning the member is notified about."],
  ["MUTE", "Mute", "Silences the member on Discord and in guild chat."],
  ["UNMUTE", "Unmute", "Lifts an active mute early."],
  ["KICK", "Kick", "Removes the member; they can rejoin with an invite."],
  ["BAN", "Ban", "Removes the member and blocks their return."],
  ["UNBAN", "Unban", "Lifts a ban."],
];

/** Only these two carry a duration; the rest are instantaneous. */
const TIMED = new Set(["MUTE", "BAN"]);

/** Survives a tab switch so coming back to the page keeps your place. */
const state: { target: string } = { target: "" };

export async function renderModeration(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading moderation…"));

  const query = state.target ? `?target=${encodeURIComponent(state.target)}` : "";
  const result = await loadPage<ModerationVM>(
    `/api/guilds/${encodeURIComponent(guildId)}/moderation${query}`,
  );
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderModeration(host, guildId)));
  }

  const data = result.data;
  const rerender = (): void => void renderModeration(host, guildId);
  const subtitle = data.target
    ? `${count(data.infractionCount)} infraction(s) on record for this member`
    : "Guild-wide audit trail — enter a member id to narrow it";

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Moderation", subtitle),
      card("Look up a member", lookupBody(rerender)),
      card("Issue an action", actionForm(guildId, rerender)),
      data.target ? card("Infractions", infractionsBody(data)) : null,
      card("In force now", inForceBody(data)),
      card(data.target ? "Actions on this member" : "Recent actions", actionsBody(data)),
    ),
  );
}

function lookupBody(rerender: () => void): HTMLElement {
  const input = h("input", {
    class: "control control-text",
    type: "text",
    value: state.target,
    placeholder: "Discord user id",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Discord user id",
  }) as HTMLInputElement;

  const note = h("p", { class: "field-hint" }, "");

  function look(): void {
    const raw = input.value.trim();
    if (raw.length > 0 && !isSnowflake(raw)) {
      note.textContent = "That doesn't look like a Discord user id (17–20 digits).";
      return;
    }
    state.target = raw;
    rerender();
  }

  input.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") look();
  });

  return h(
    "div",
    { class: "fields" },
    h(
      "div",
      { class: "field" },
      h(
        "div",
        { class: "field-row" },
        input,
        h("button", { class: "button button-primary", type: "button", onclick: look }, "Look up"),
        state.target
          ? h("button", {
              class: "button",
              type: "button",
              onclick: () => {
                state.target = "";
                rerender();
              },
            }, "Clear")
          : null,
      ),
      note,
      h(
        "p",
        { class: "field-hint" },
        "Right-click a member in Discord with developer mode on to copy their id.",
      ),
    ),
  );
}

/**
 * The one composite form in the panel.
 *
 * Every other write is a single field that saves itself, but a moderation
 * action is not meaningful in pieces — a type without a reason is a row the
 * audit log should never hold — so this one submits as a unit.
 */
function actionForm(guildId: string, rerender: () => void): HTMLElement {
  const status = statusSlot();

  const type = h("select", { class: "control control-select", "aria-label": "Action" },
    ...ACTIONS.map(([value, label]) => h("option", { value }, label)),
  ) as HTMLSelectElement;

  const target = h("input", {
    class: "control control-text",
    type: "text",
    value: state.target,
    placeholder: "Discord user id",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Target Discord user id",
  }) as HTMLInputElement;

  const duration = h("input", {
    class: "control control-text control-short",
    type: "text",
    placeholder: "e.g. 30m, 2h, 7d",
    autocomplete: "off",
    "aria-label": "Duration",
  }) as HTMLInputElement;

  const durationRow = h(
    "div",
    { class: "field" },
    h("label", { class: "field-label" }, "Duration"),
    h("div", { class: "field-row" }, duration),
    h("p", { class: "field-hint" }, "Leave blank for permanent. Only mutes and bans take a duration."),
  );

  const reason = reasonBox("Why this action was taken — this is the audit record", 3);
  const explain = h("p", { class: "field-hint" }, ACTIONS[0]![2]);

  function syncType(): void {
    const chosen = ACTIONS.find(([value]) => value === type.value);
    explain.textContent = chosen ? chosen[2] : "";
    // Hidden rather than disabled: an untimed action has no duration at all, and
    // a greyed-out box invites the reader to wonder what would unlock it.
    durationRow.hidden = !TIMED.has(type.value);
  }
  type.addEventListener("change", syncType);
  syncType();

  const submit = actionButton({
    label: "Apply action",
    tone: "primary",
    status,
    run: async () => {
      const targetId = target.value.trim();
      if (!isSnowflake(targetId)) {
        return { kind: "error", message: "Enter the target's Discord user id (17–20 digits)." };
      }
      const note = reason.value.trim();
      if (note.length === 0) {
        return { kind: "error", message: "A reason is required — it's what the audit row will say." };
      }

      let durationSeconds: number | null = null;
      if (TIMED.has(type.value)) {
        const parsed = parseDurationSeconds(duration.value);
        if (parsed === "invalid") {
          return { kind: "error", message: "Duration must look like 30m, 2h or 7d, up to a year." };
        }
        durationSeconds = parsed;
      }

      return postAction(guildId, "moderation.action", {
        type: type.value,
        targetDiscordId: targetId,
        reason: note,
        // Omitted rather than nulled for the untimed actions, which refuse a
        // duration key outright.
        ...(durationSeconds === null ? {} : { durationSeconds }),
      });
    },
    onDone: () => {
      reason.value = "";
      duration.value = "";
      // The history below is now out of date by exactly this action.
      state.target = target.value.trim();
      rerender();
    },
  });

  return h(
    "div",
    { class: "fields" },
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, "Action"),
      h("div", { class: "field-row" }, type),
      explain,
    ),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, "Member"),
      h("div", { class: "field-row" }, target),
    ),
    durationRow,
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, "Reason"),
      h("div", { class: "field-row" }, reason),
    ),
    h("div", { class: "field-row" }, submit, status.el),
  );
}

function infractionsBody(data: ModerationVM): HTMLElement {
  if (data.infractions.length === 0) {
    return emptyState("No infractions on record for this member.");
  }
  return table(
    ["Type", "Severity", "Reason", "When"],
    data.infractions.map((row) => [
      row.type,
      badge(row.severity, severityTone(row.severity)),
      row.reason,
      relativeTime(row.createdAt),
    ]),
  );
}

/**
 * What is *currently being enforced*, as opposed to what has happened.
 *
 * The actions table below is a history and answers "what was done"; a staffer
 * deciding whether to escalate is asking the different question "is this person
 * already muted right now", and reading that off a history means eyeballing
 * every row's expiry. The server has already resolved it, so it gets its own
 * card.
 */
function inForceBody(data: ModerationVM): HTMLElement {
  if (data.inForce.length === 0) {
    return emptyState(
      data.target
        ? "Nothing is currently being enforced against this member."
        : "Nobody in this guild is muted or banned right now.",
    );
  }
  return table(
    ["Action", "Member", "By", "Reason", "Ends", "Since"],
    data.inForce.map((row) => [
      h("div", { class: "job-cell" }, row.type, badge("in force", "warn")),
      h("code", {}, row.targetDiscordId ?? "—"),
      h("code", {}, row.actorDiscordId),
      row.reason,
      row.expiresAt === null ? "never" : relativeTime(row.expiresAt),
      relativeTime(row.createdAt),
    ]),
  );
}

function actionsBody(data: ModerationVM): HTMLElement {
  if (data.actions.length === 0) {
    return emptyState(
      data.target ? "No panel or bot actions recorded against this member." : "No moderation actions recorded yet.",
    );
  }

  return table(
    ["Action", "Member", "By", "Reason", "Duration", "When"],
    data.actions.map((row) => [
      h("div", { class: "job-cell" }, row.type, stateBadge(row)),
      h("code", {}, row.targetDiscordId ?? "—"),
      h("code", {}, row.actorDiscordId),
      row.reason,
      describeDuration(row),
      relativeTime(row.createdAt),
    ]),
  );
}

/**
 * The `active` flag alone cannot say this, which is why the state is resolved
 * server-side: a swept mute and a hand-lifted one are both `active: false`, and
 * a kick is `active` forever because nothing lifts one. Labelling every cleared
 * flag "lifted" would credit a staffer with an unmute the clock performed.
 */
function stateBadge(row: ModerationActionVM): HTMLElement | null {
  switch (row.state) {
    case "ACTIVE":
      return badge("in force", "warn");
    case "EXPIRED":
      return badge("expired", "neutral");
    case "LIFTED":
      return badge("lifted", "ok");
    default:
      // MOMENTARY — a warn or a kick had no duration to run out.
      return null;
  }
}

function describeDuration(row: ModerationActionVM): string {
  if (row.durationSeconds === null) return TIMED.has(row.type) ? "permanent" : "—";
  const span = describeSpan(row.durationSeconds * 1000);
  if (row.expiresAt === null) return span;
  const remaining = Date.parse(row.expiresAt) - Date.now();
  return remaining > 0 ? `${span} (${describeSpan(remaining)} left)` : span;
}

function severityTone(severity: string): BadgeTone {
  switch (severity) {
    case "LOW":
      return "neutral";
    case "MEDIUM":
      return "warn";
    case "HIGH":
    case "CRITICAL":
      return "bad";
    default:
      return "neutral";
  }
}
