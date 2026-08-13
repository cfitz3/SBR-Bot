/**
 * Filter — the chat filter's rules, and the ladder that answers repeat warnings.
 *
 * These are the two pieces of moderation that act on a member with nobody in
 * the loop: a rule blocks or shadow-mutes at relay time, and a rung mutes or
 * bans off a warning count.
 *
 * They are no longer a page of their own. `filterCards` is all this module
 * exports, and the Moderation page renders it as its Filter section — one place
 * to configure everything automatic, next to the automod rules that read this
 * same wordlist. The `wordlist` page id stays on the JSON API (WEB_PANEL.md §0)
 * because removing a route is a contract break for anything driving the API
 * directly; the panel simply reaches the data through the moderation view model
 * instead, which carries it already.
 *
 * The patterns themselves are shown, which is the point and also why every
 * control here is Admin-tier: the list is, by construction, a collection of the
 * slurs and scam URLs the guild is filtering.
 */
import type { WordlistVM } from "@sbr/panel-core";
import type { WordlistRuleDTO } from "@sbr/shared-types";
import { WordAction, WordMatchType } from "./enums.js";
import { postAction, type WriteResult } from "../api.js";
import { badge, card, emptyState } from "../components.js";
import { actionButton, fieldGroup, selectField, statusSlot, textField, toggleField } from "../forms.js";
import { describeSpan } from "../format.js";
import { h } from "../dom.js";

/** Mirrors the mutation layer's bounds; see forms.ts on why both exist. */
const PATTERN_MAX = 200;
const SEVERITY_MAX = 10;
const MAX_RUNGS = 10;
const WINDOW_MAX = 365;

/** Mirrors `MAX_GAME_MUTE_SECONDS` in @sbr/moderation; the client cannot import it. */
const MAX_GAME_MUTE_SECONDS = 30 * 24 * 60 * 60;

const GAME_ACTION_OPTIONS = [
  ["none", "nothing"],
  ["g mute", "mute in the guild"],
  ["g unmute", "unmute in the guild"],
  ["g kick", "kick from the guild"],
] as const;

/** What each mapping actually does, in the guild's terms. */
const GAME_ACTION_HINT: Readonly<Record<string, string>> = {
  none: "Nothing happens in the Hypixel guild.",
  "g mute": "The member is muted in guild chat.",
  "g unmute": "The member's guild-chat mute is lifted.",
  "g kick": "The member is removed from the Hypixel guild.",
};

const MATCH_OPTIONS = Object.keys(WordMatchType).map((v) => [v, v.toLowerCase()] as const);
const ACTION_OPTIONS = Object.keys(WordAction).map((v) => [v, v.toLowerCase().replace(/_/g, " ")] as const);

/** What each verdict actually does to a message, in the relay's terms. */
const ACTION_HINT: Readonly<Record<string, string>> = {
  FLAG: "Relayed as written, and recorded for staff to look at.",
  REPLACE: "Relayed with the match censored.",
  BLOCK: "Not relayed at all.",
  SHADOW_MUTE: "Not relayed, and the sender is not told.",
};

/**
 * The filter, as cards, for whichever surface is drawing it.
 *
 * Returned rather than rendered so the Moderation page can put these under its
 * own section heading without this module knowing anything about tabs. `reload`
 * is the caller's re-read: every control here writes the whole object it edits,
 * so the list on screen has to come back from the server rather than be patched
 * in place.
 */
export function filterCards(guildId: string, vm: WordlistVM, reload: () => void): readonly HTMLElement[] {
  const { installed, rules, escalation, relaySync } = vm;
  return [
    h(
      "p",
      { class: "page-note" },
      "Rules run on every message the bridge relays, in severity order — the harshest verdict among the " +
        "matches is the one applied. Test a phrase against the live set with /filter-test before saving it.",
    ),
    card("Repeat warnings", escalationForm(guildId, escalation, reload)),
    card("In-game punishment sync", relaySyncForm(guildId, relaySync, reload)),
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
  ];
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

/**
 * What a Discord punishment does in guild chat.
 *
 * One row per Discord action, each a `selectField` over a closed list. The list
 * is closed on the server too — a free-text command box here would be a
 * configurable way to demote the guild, since the bridge account holds officer
 * permissions.
 *
 * Saved whole, like the ladder above and for the same reason: what the page
 * shows is what gets stored, so pressing save on a list of built-in defaults
 * makes them the guild's own rather than leaving a half-stored mixture.
 */
function relaySyncForm(guildId: string, policy: WordlistVM["relaySync"], reload: () => void): HTMLElement {
  const rows = policy.rows.map((r) => ({ ...r }));
  let enabled = policy.enabled;

  const save = (): Promise<WriteResult> =>
    postAction(guildId, "moderation.relay-sync", {
      enabled,
      rows: rows.map((r) => ({
        discordAction: r.discordAction,
        gameAction: r.gameAction,
        durationMode: r.durationMode,
        fixedSeconds: r.fixedSeconds,
        enabled: r.enabled,
      })),
    });

  const status = statusSlot();

  const rowFields = rows.map((row) =>
    fieldGroup(
      toggleField({
        label: `On ${row.discordAction.toLowerCase()}`,
        hint: GAME_ACTION_HINT[row.gameAction] ?? "",
        checked: row.enabled,
        save: (next) => {
          row.enabled = next;
          return save();
        },
      }),
      selectField({
        label: "In guild chat",
        value: row.gameAction,
        options: GAME_ACTION_OPTIONS.map(([v, l]) => [v, l] as const),
        save: (next) => {
          row.gameAction = next as typeof row.gameAction;
          return save();
        },
      }),
      // Only a mute has a length to argue about; a kick happens once.
      ...(row.gameAction === "g mute"
        ? [
            selectField({
              label: "For how long",
              value: row.durationMode,
              options: [
                ["same", "the same as the Discord punishment"],
                ["fixed", "a fixed length"],
              ],
              save: (next) => {
                row.durationMode = next as typeof row.durationMode;
                return save();
              },
            }),
            ...(row.durationMode === "fixed"
              ? [
                  textField({
                    label: "Length",
                    hint: "Seconds. Hypixel caps a guild mute at 30 days.",
                    value: row.fixedSeconds === null ? "" : String(row.fixedSeconds),
                    validate: (raw) => {
                      const value = Number(raw.trim());
                      return Number.isInteger(value) && value >= 1 && value <= MAX_GAME_MUTE_SECONDS
                        ? null
                        : `Enter a whole number of seconds between 1 and ${MAX_GAME_MUTE_SECONDS}.`;
                    },
                    save: (raw) => {
                      row.fixedSeconds = Number(raw.trim());
                      return save();
                    },
                  }),
                ]
              : []),
          ]
        : []),
    ),
  );

  return h(
    "div",
    {},
    h(
      "p",
      { class: "field-hint" },
      "A punishment issued here can be carried into the Hypixel guild by the bridge account. Only members with a " +
        "linked account can be matched to an IGN — an unlinked member is punished on Discord and nowhere else, " +
        "which the audit log records.",
    ),
    fieldGroup(
      toggleField({
        label: "Carry punishments into guild chat",
        hint: "Off leaves every row below stored but inert.",
        checked: policy.enabled,
        save: (next) => {
          enabled = next;
          return save();
        },
      }),
    ),
    ...rowFields,
    h(
      "p",
      { class: "field-hint" },
      "The other direction is best-effort: Hypixel announces some in-game moderation in guild chat and not all of " +
        "it, so actions taken in-game appear in the history when the bridge saw them announced.",
    ),
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
