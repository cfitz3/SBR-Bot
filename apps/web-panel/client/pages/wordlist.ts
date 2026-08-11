/**
 * Filter — the chat filter's rules, and the ladder that answers repeat warnings.
 *
 * Two things share this page because they are the two pieces of moderation that
 * act on a member with nobody in the loop: a rule blocks or shadow-mutes at
 * relay time, and a rung mutes or bans off a warning count. The Moderation page
 * next door is the opposite — a record of what people did on purpose.
 *
 * The patterns themselves are shown, which is the point of the page and also
 * why it is Admin-tier: the list is, by construction, a collection of the slurs
 * and scam URLs the guild is filtering.
 */
import type { WordlistVM } from "@sbr/panel-core";
import type { WordlistRuleDTO } from "@sbr/shared-types";
import { WordAction, WordMatchType } from "@sbr/shared-types";
import { loadPage, postAction, type WriteResult } from "../api.js";
import { badge, card, deniedState, emptyState, errorState, pageTitle, spinner } from "../components.js";
import { actionButton, fieldGroup, selectField, statusSlot, textField, toggleField } from "../forms.js";
import { describeSpan } from "../format.js";
import { h, replace } from "../dom.js";

/** Mirrors the mutation layer's bounds; see forms.ts on why both exist. */
const PATTERN_MAX = 200;
const SEVERITY_MAX = 10;
const MAX_RUNGS = 10;
const WINDOW_MAX = 365;

const MATCH_OPTIONS = Object.keys(WordMatchType).map((v) => [v, v.toLowerCase()] as const);
const ACTION_OPTIONS = Object.keys(WordAction).map((v) => [v, v.toLowerCase().replace(/_/g, " ")] as const);

/** What each verdict actually does to a message, in the relay's terms. */
const ACTION_HINT: Readonly<Record<string, string>> = {
  FLAG: "Relayed as written, and recorded for staff to look at.",
  REPLACE: "Relayed with the match censored.",
  BLOCK: "Not relayed at all.",
  SHADOW_MUTE: "Not relayed, and the sender is not told.",
};

export async function renderWordlist(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading filter…"));

  const result = await loadPage<WordlistVM>(`/api/guilds/${encodeURIComponent(guildId)}/wordlist`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderWordlist(host, guildId)));
  }

  const { installed, rules, escalation } = result.data;
  const reload = (): void => void renderWordlist(host, guildId);
  const live = rules.filter((r) => r.enabled).length;

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Filter", installed ? `${live} of ${rules.length} rules live` : "Not enabled"),
      h(
        "p",
        { class: "page-note" },
        "Rules run on every message the bridge relays, in severity order — the harshest verdict among the " +
          "matches is the one applied. Test a phrase against the live set with /filter-test before saving it.",
      ),
      card("Repeat warnings", escalationForm(guildId, escalation, reload)),
      ...(installed
        ? [
            card("Add a rule", createForm(guildId, reload)),
            ...(rules.length === 0
              ? [card("Rules", emptyState("Nothing is being filtered in this guild."))]
              : rules.map((rule) => ruleCard(guildId, rule, reload))),
          ]
        : [
            card(
              "Rules",
              emptyState("The chat filter isn't switched on for this deployment, so there are no rules to edit."),
            ),
          ]),
    ),
  );
}

/**
 * One rule.
 *
 * Every control writes the whole rule, as on the Tickets page and for the same
 * reason: the mutation takes a complete rule so it can validate the *result* —
 * changing only the match type can turn a legal substring into an invalid regex
 * or a collision with a rule three rows down, neither of which is visible from
 * the changed field alone.
 *
 * The note a `/wordlist-add` may have carried is deliberately not sent: it is
 * not on the DTO, so this page has never seen it, and an edit here leaves it
 * where it was rather than clearing what it cannot show.
 */
function ruleCard(guildId: string, rule: WordlistRuleDTO, reload: () => void): HTMLElement {
  const current: { -readonly [K in keyof WordlistRuleDTO]: WordlistRuleDTO[K] } = { ...rule };

  const write = (patch: Partial<WordlistRuleDTO>): Promise<WriteResult> => {
    Object.assign(current, patch);
    return postAction(guildId, "wordlist.upsert", {
      id: current.id,
      pattern: current.pattern,
      matchType: current.matchType,
      action: current.action,
      severity: current.severity,
      enabled: current.enabled,
    });
  };

  const status = statusSlot();
  const remove = actionButton({
    label: "Remove",
    tone: "danger",
    confirm: "Confirm remove",
    status,
    run: () => postAction(guildId, "wordlist.delete", { id: rule.id }),
    onDone: reload,
  });

  return card(
    rule.pattern,
    h(
      "div",
      {},
      h("p", { class: "field-hint" }, ACTION_HINT[rule.action] ?? ""),
      fieldGroup(
        toggleField({
          label: "Live",
          hint: "Off leaves the rule here but stops it matching. Use this before removing one.",
          checked: rule.enabled,
          save: (enabled) => write({ enabled }),
        }),
        textField({
          label: "Pattern",
          hint: "What to match. Regex is compiled as written; wildcard takes * and ?.",
          value: rule.pattern,
          validate: (raw) =>
            raw.trim().length === 0 || raw.length > PATTERN_MAX
              ? `Enter a pattern up to ${PATTERN_MAX} characters.`
              : null,
          save: (raw) => write({ pattern: raw.trim() }),
        }),
        selectField({
          label: "Match",
          hint: "How the pattern is compared against the message.",
          value: rule.matchType,
          options: MATCH_OPTIONS.map(([v, l]) => [v, l] as const),
          save: (next) => write({ matchType: next as WordlistRuleDTO["matchType"] }),
        }),
        selectField({
          label: "Verdict",
          hint: "What the relay does when it matches.",
          value: rule.action,
          options: ACTION_OPTIONS.map(([v, l]) => [v, l] as const),
          save: (next) => write({ action: next as WordlistRuleDTO["action"] }),
        }),
        textField({
          label: "Severity",
          hint: `1–${SEVERITY_MAX}. Higher wins when a message trips more than one rule.`,
          value: String(rule.severity),
          validate: validateSeverity,
          save: (raw) => write({ severity: Number(raw.trim()) }),
        }),
      ),
      h("div", { class: "field-row" }, remove),
      status.el,
    ),
    badge(rule.enabled ? "live" : "off", rule.enabled ? "ok" : "neutral"),
  );
}

function createForm(guildId: string, reload: () => void): HTMLElement {
  const status = statusSlot();

  const pattern = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: "the word or pattern to catch",
    "aria-label": "Pattern",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const severity = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: "1",
    "aria-label": "Severity",
    autocomplete: "off",
  }) as HTMLInputElement;

  let matchType = "SUBSTRING";
  let action = "BLOCK";

  const button = actionButton({
    label: "Add rule",
    tone: "primary",
    status,
    run: async () => {
      const text = pattern.value.trim();
      if (text.length === 0 || text.length > PATTERN_MAX) {
        return { kind: "error", message: `Enter a pattern up to ${PATTERN_MAX} characters.` };
      }
      const severityText = severity.value.trim() === "" ? "1" : severity.value;
      const severityError = validateSeverity(severityText);
      if (severityError !== null) return { kind: "error", message: severityError };

      return postAction(guildId, "wordlist.upsert", {
        id: null,
        pattern: text,
        matchType,
        action,
        severity: Number(severityText.trim()),
        enabled: true,
      });
    },
    // Reload rather than clearing: the new rule has to appear in the list, and
    // a duplicate is refused rather than silently merged into the one above it.
    onDone: reload,
  });

  return h(
    "div",
    { class: "field" },
    h(
      "p",
      { class: "field-hint" },
      "An identical pattern and match type is refused as a duplicate — edit the existing rule instead.",
    ),
    h("div", { class: "field-row" }, pattern, severity),
    selectField({
      label: "Match",
      value: matchType,
      options: MATCH_OPTIONS.map(([v, l]) => [v, l] as const),
      // Nothing is stored until "Add rule"; the dropdown only records the
      // choice, so the save reports success without a write.
      save: async (next) => {
        matchType = next;
        return { kind: "ok" };
      },
    }),
    selectField({
      label: "Verdict",
      value: action,
      options: ACTION_OPTIONS.map(([v, l]) => [v, l] as const),
      save: async (next) => {
        action = next;
        return { kind: "ok" };
      },
    }),
    h("div", { class: "field-row" }, button),
    status.el,
  );
}

/**
 * The escalation ladder.
 *
 * Shown as a whole rather than as editable rows, because the rungs a guild has
 * not customised are the platform's built-ins: there is nothing stored to edit
 * until the first save, and a row-by-row editor would have to pretend otherwise.
 * Saving writes the ladder exactly as displayed, which turns whatever is shown
 * into the guild's own — including the built-ins, which is the honest reading of
 * "I pressed save on this list".
 */
function escalationForm(guildId: string, policy: WordlistVM["escalation"], reload: () => void): HTMLElement {
  // A local, mutable copy. Nothing is written until a control saves.
  const rungs = policy.rungs.map((r) => ({ ...r }));
  let enabled = policy.enabled;
  let windowDays = policy.windowDays;

  const save = (): Promise<WriteResult> =>
    postAction(guildId, "moderation.defaults", {
      enabled,
      windowDays,
      rungs: rungs.map((r) => ({ warns: r.warns, action: r.action, durationSeconds: r.durationSeconds })),
    });

  const status = statusSlot();

  const warnsInput = numberInput("3", "Warnings");
  const durationInput = numberInput("3600", "Duration in seconds");
  let newAction = "MUTE";

  const addRung = actionButton({
    label: "Add step",
    tone: "primary",
    status,
    run: async () => {
      if (rungs.length >= MAX_RUNGS) return { kind: "error", message: `A ladder holds up to ${MAX_RUNGS} steps.` };
      const warns = Number(warnsInput.value.trim());
      if (!Number.isInteger(warns) || warns < 1 || warns > 100) {
        return { kind: "error", message: "Enter a warning count between 1 and 100." };
      }
      if (rungs.some((r) => r.warns === warns)) {
        return { kind: "error", message: `There is already a step at ${warns} warnings.` };
      }
      const raw = durationInput.value.trim();
      const durationSeconds = raw === "" ? null : Number(raw);
      if (durationSeconds !== null && (!Number.isInteger(durationSeconds) || durationSeconds < 1)) {
        return { kind: "error", message: "Enter a whole number of seconds, or leave it blank for permanent." };
      }
      if (newAction === "MUTE" && durationSeconds === null) {
        return { kind: "error", message: "A mute needs a duration — an endless mute is refused." };
      }
      rungs.push({ warns, action: newAction as "MUTE" | "BAN", durationSeconds, source: "GUILD" });
      return save();
    },
    onDone: reload,
  });

  const rows = rungs.map((rung) =>
    h(
      "div",
      { class: "field-row" },
      h("span", { class: "job-cell" }, describeRung(rung), badge(rung.source === "DEFAULT" ? "built-in" : "custom",
        rung.source === "DEFAULT" ? "neutral" : "ok")),
      actionButton({
        label: "Remove",
        tone: "danger",
        confirm: "Confirm remove",
        status,
        run: () => {
          const at = rungs.findIndex((r) => r.warns === rung.warns);
          if (at >= 0) rungs.splice(at, 1);
          return save();
        },
        onDone: reload,
      }),
    ),
  );

  return h(
    "div",
    {},
    h(
      "p",
      { class: "field-hint" },
      "When a warning brings a member to one of these counts, the platform applies the step itself, attributed " +
        "to the staffer who warned. Warnings older than the window stop counting.",
    ),
    fieldGroup(
      toggleField({
        label: "Escalate automatically",
        hint: "Off leaves /warn as a record only. The ladder below is kept either way.",
        checked: policy.enabled,
        save: (next) => {
          enabled = next;
          return save();
        },
      }),
      textField({
        label: "Window",
        hint: `How many days a warning counts for, 1–${WINDOW_MAX}. Longer means one bad week follows a member further.`,
        value: String(policy.windowDays),
        validate: (raw) => {
          const value = Number(raw.trim());
          return Number.isInteger(value) && value >= 1 && value <= WINDOW_MAX
            ? null
            : `Enter a whole number of days between 1 and ${WINDOW_MAX}.`;
        },
        save: (raw) => {
          windowDays = Number(raw.trim());
          return save();
        },
      }),
    ),
    ...rows,
    h("p", { class: "field-hint" }, "Add a step: warnings, then seconds (blank for permanent, bans only)."),
    h("div", { class: "field-row" }, warnsInput, durationInput),
    selectField({
      label: "Then",
      value: newAction,
      options: [
        ["MUTE", "mute"],
        ["BAN", "ban"],
      ],
      save: async (next) => {
        newAction = next;
        return { kind: "ok" };
      },
    }),
    h("div", { class: "field-row" }, addRung),
    status.el,
  );
}

function describeRung(rung: { warns: number; action: string; durationSeconds: number | null }): string {
  const how = rung.durationSeconds === null ? "permanently" : `for ${describeSpan(rung.durationSeconds * 1000)}`;
  return `${rung.warns} warning${rung.warns === 1 ? "" : "s"} → ${rung.action.toLowerCase()} ${how}`;
}

function numberInput(placeholder: string, ariaLabel: string): HTMLInputElement {
  return h("input", {
    class: "control control-text",
    type: "text",
    placeholder,
    "aria-label": ariaLabel,
    autocomplete: "off",
  }) as HTMLInputElement;
}

function validateSeverity(raw: string): string | null {
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isInteger(value) || value < 1 || value > SEVERITY_MAX) {
    return `Enter a whole number between 1 and ${SEVERITY_MAX}.`;
  }
  return null;
}
