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
import type { PackSelection, WordlistPack, WordlistVM } from "@sbr/panel-core";
import type { WordlistRuleDTO } from "@sbr/shared-types";
import { WordAction, WordMatchType } from "./enums.js";
import { postAction, type WriteResult } from "../api.js";
import { badge, card, emptyState } from "../components.js";
import { scope } from "../copy.js";
import { actionButton, fieldGroup, selectField, statusSlot, textField, toggleField } from "../forms.js";
import { describeSpan } from "../format.js";
import { h } from "../dom.js";

const t = scope("filter");

/** Mirrors the mutation layer's bounds; see forms.ts on why both exist. */
const PATTERN_MAX = 200;
const SEVERITY_MAX = 10;
const MAX_RUNGS = 10;
const WINDOW_MAX = 365;

/** Mirrors `MAX_GAME_MUTE_SECONDS` in @sbr/moderation; the client cannot import it. */
const MAX_GAME_MUTE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The in-game mappings the server will accept, in the order they are offered.
 * The list is closed on both sides — a free-text command box here would be a
 * configurable way to demote the guild — and the words for each come from copy.
 */
const GAME_ACTIONS = ["none", "g mute", "g unmute", "g kick"] as const;

/** A copy table read by a value the platform owns, falling back to the value. */
const lookup = (table: unknown, key: string, fallback: string): string =>
  (table as Readonly<Record<string, string>>)[key] ?? fallback;

const gameActionOptions = (): readonly (readonly [string, string])[] =>
  GAME_ACTIONS.map((v) => [v, lookup(t("gameActionLabel"), v, v)] as const);

const matchOptions = (): readonly (readonly [string, string])[] =>
  Object.keys(WordMatchType).map((v) => [v, lookup(t("matchOption"), v, v.toLowerCase())] as const);

const actionOptions = (): readonly (readonly [string, string])[] =>
  Object.keys(WordAction).map(
    (v) => [v, lookup(t("actionOption"), v, v.toLowerCase().replace(/_/g, " "))] as const,
  );

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
  const { installed, rules, escalation, relaySync, packs, packCatalogue } = vm;
  return [
    h("p", { class: "page-note" }, t("intro")),
    card(t("cardEscalation"), escalationForm(guildId, escalation, reload)),
    card(t("cardRelaySync"), relaySyncForm(guildId, relaySync, reload)),
    ...(installed
      ? [
          // Packs come before the create form deliberately: the first question
          // a new guild has is "do I have to write all of this myself", and the
          // answer is on screen before the empty pattern box is.
          card(t("cardPacks"), packsForm(guildId, packs, packCatalogue, reload)),
          card(t("cardImport"), importForm(guildId, reload)),
          card(t("cardCreate"), createForm(guildId, reload)),
          ...(rules.length === 0
            ? [card(t("cardRules"), emptyState("wordlistRules"))]
            : rules.map((rule) => ruleCard(guildId, rule, reload))),
        ]
      : [card(t("cardRules"), emptyState("wordlistDisabled"))]),
  ];
}

/**
 * The packaged lists, and the individual rules a guild has muted inside them.
 *
 * Every toggle sends the whole selection, because that is the shape the
 * mutation validates: a per-toggle endpoint would let the page ask to mute a
 * rule inside a pack that is off, which is a state nobody can see.
 *
 * A pack's rules are shown rather than summarised. The patterns are the whole
 * question — an admin deciding whether to switch on Risky links is deciding
 * about `bit.ly`, not about the word "risky" — and a pack nobody can read is a
 * pack nobody should enable.
 */
function packsForm(
  guildId: string,
  selection: PackSelection,
  catalogue: readonly WordlistPack[],
  reload: () => void,
): HTMLElement {
  const enabled = new Set(selection.enabled);
  const suppressed = new Set(selection.suppressed);

  const save = (): Promise<WriteResult> =>
    postAction(guildId, "wordlist.packs.save", {
      enabled: [...enabled],
      suppressed: [...suppressed],
    });

  const packBlock = (pack: WordlistPack): HTMLElement => {
    const on = enabled.has(pack.id);
    return h(
      "div",
      { class: "field" },
      toggleField({
        label: pack.name,
        hint: pack.description,
        checked: on,
        save: (next) => {
          if (next) enabled.add(pack.id);
          else enabled.delete(pack.id);
          // Reloaded so the rule list under the toggle appears or greys out
          // without the operator having to guess that it would have.
          return save().then((result) => {
            if (result.kind === "ok") reload();
            return result;
          });
        },
      }),
      h(
        "ul",
        { class: "roster-list pack-rules" },
        ...pack.rules.map((rule) => {
          const key = `${pack.id}:${rule.key}`;
          const muted = suppressed.has(key);
          return h(
            "li",
            { class: muted ? "pack-rule pack-rule-muted" : "pack-rule" },
            h("code", { class: "pack-pattern" }, rule.pattern),
            badge(rule.action.toLowerCase(), rule.action === "BLOCK" ? "bad" : "warn"),
            h("span", { class: "muted" }, rule.note),
            toggleField({
              label: t("packRuleOn"),
              checked: !muted,
              readOnly: !on,
              save: (next) => {
                if (next) suppressed.delete(key);
                else suppressed.add(key);
                return save();
              },
            }),
          );
        }),
      ),
    );
  };

  return h(
    "div",
    { class: "fields" },
    h("p", { class: "field-hint" }, t("packsIntro")),
    ...catalogue.map(packBlock),
  );
}

/**
 * Bulk import: a JSON array of rules, pasted or dropped in as a file.
 *
 * Both routes post the same text to the same mutation, which is what keeps the
 * two from disagreeing about what a valid file is. The file picker only reads
 * it — nothing is uploaded until the operator presses the button, so a
 * mis-clicked file is a re-pick rather than two hundred rules.
 */
function importForm(guildId: string, reload: () => void): HTMLElement {
  const status = statusSlot();

  const box = h("textarea", {
    class: "control control-area",
    rows: "6",
    placeholder: t("importPlaceholder"),
    "aria-label": t("importLabel"),
    spellcheck: "false",
  }) as HTMLTextAreaElement;

  const picker = h("input", {
    class: "control control-text pack-file",
    type: "file",
    accept: "application/json,.json",
    "aria-label": t("importFileLabel"),
  }) as HTMLInputElement;

  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      // Into the box rather than straight to the server: the operator sees what
      // they are about to add, which is the entire safeguard on an import.
      box.value = text;
      status.set("saved", t("importLoaded"));
    });
  });

  const submit = actionButton({
    label: t("importRun"),
    status,
    run: () => postAction(guildId, "wordlist.import", { rules: box.value }),
    onDone: () => {
      box.value = "";
      picker.value = "";
      reload();
    },
  });

  return h(
    "div",
    { class: "field" },
    h("p", { class: "field-hint" }, t("importIntro")),
    picker,
    box,
    h("div", { class: "field-row" }, submit),
    status.el,
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
    label: t("remove"),
    tone: "danger",
    confirm: t("removeConfirm"),
    status,
    run: () => postAction(guildId, "wordlist.delete", { id: rule.id }),
    onDone: reload,
  });

  return card(
    rule.pattern,
    h(
      "div",
      {},
      h("p", { class: "field-hint" }, lookup(t("action"), rule.action, "")),
      fieldGroup(
        toggleField({
          label: t("liveLabel"),
          hint: t("liveHint"),
          checked: rule.enabled,
          save: (enabled) => write({ enabled }),
        }),
        textField({
          label: t("patternLabel"),
          hint: t("patternHint"),
          value: rule.pattern,
          validate: (raw) =>
            raw.trim().length === 0 || raw.length > PATTERN_MAX
              ? t("errPattern").replace("{max}", String(PATTERN_MAX))
              : null,
          save: (raw) => write({ pattern: raw.trim() }),
        }),
        selectField({
          label: t("matchLabel"),
          hint: t("matchHint"),
          value: rule.matchType,
          options: matchOptions(),
          save: (next) => write({ matchType: next as WordlistRuleDTO["matchType"] }),
        }),
        selectField({
          label: t("verdictLabel"),
          hint: t("verdictHint"),
          value: rule.action,
          options: actionOptions(),
          save: (next) => write({ action: next as WordlistRuleDTO["action"] }),
        }),
        textField({
          label: t("severityLabel"),
          hint: t("severityHint").replace("{max}", String(SEVERITY_MAX)),
          value: String(rule.severity),
          validate: validateSeverity,
          save: (raw) => write({ severity: Number(raw.trim()) }),
        }),
      ),
      h("div", { class: "field-row" }, remove),
      status.el,
    ),
    badge(rule.enabled ? t("liveBadge") : t("offBadge"), rule.enabled ? "ok" : "neutral"),
  );
}

function createForm(guildId: string, reload: () => void): HTMLElement {
  const status = statusSlot();

  const pattern = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: t("createPatternPlaceholder"),
    "aria-label": t("patternLabel"),
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const severity = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: t("createSeverityPlaceholder"),
    "aria-label": t("severityLabel"),
    autocomplete: "off",
  }) as HTMLInputElement;

  let matchType = "SUBSTRING";
  let action = "BLOCK";

  const button = actionButton({
    label: t("create"),
    tone: "primary",
    status,
    run: async () => {
      const text = pattern.value.trim();
      if (text.length === 0 || text.length > PATTERN_MAX) {
        return { kind: "error", message: t("errPattern").replace("{max}", String(PATTERN_MAX)) };
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
    h("p", { class: "field-hint" }, t("createNote")),
    h("div", { class: "field-row" }, pattern, severity),
    selectField({
      label: t("matchLabel"),
      value: matchType,
      options: matchOptions(),
      // Nothing is stored until "Add rule"; the dropdown only records the
      // choice, so the save reports success without a write.
      save: async (next) => {
        matchType = next;
        return { kind: "ok" };
      },
    }),
    selectField({
      label: t("verdictLabel"),
      value: action,
      options: actionOptions(),
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

  const warnsInput = numberInput(t("warnsPlaceholder"), t("warnsLabel"));
  const durationInput = numberInput(t("durationPlaceholder"), t("durationLabel"));
  let newAction = "MUTE";

  const addRung = actionButton({
    label: t("addRung"),
    tone: "primary",
    status,
    run: async () => {
      if (rungs.length >= MAX_RUNGS) {
        return { kind: "error", message: t("errRungLimit").replace("{max}", String(MAX_RUNGS)) };
      }
      const warns = Number(warnsInput.value.trim());
      if (!Number.isInteger(warns) || warns < 1 || warns > 100) {
        return { kind: "error", message: t("errRungWarns") };
      }
      if (rungs.some((r) => r.warns === warns)) {
        return { kind: "error", message: t("errRungDuplicate").replace("{warns}", String(warns)) };
      }
      const raw = durationInput.value.trim();
      const durationSeconds = raw === "" ? null : Number(raw);
      if (durationSeconds !== null && (!Number.isInteger(durationSeconds) || durationSeconds < 1)) {
        return { kind: "error", message: t("errRungDuration") };
      }
      if (newAction === "MUTE" && durationSeconds === null) {
        return { kind: "error", message: t("errRungEndlessMute") };
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
      h(
        "span",
        { class: "job-cell" },
        describeRung(rung),
        badge(
          rung.source === "DEFAULT" ? t("rungBuiltIn") : t("rungCustom"),
          rung.source === "DEFAULT" ? "neutral" : "ok",
        ),
      ),
      actionButton({
        label: t("remove"),
        tone: "danger",
        confirm: t("removeConfirm"),
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
    h("p", { class: "field-hint" }, t("escalationHint")),
    fieldGroup(
      toggleField({
        label: t("escalateLabel"),
        hint: t("escalateHint"),
        checked: policy.enabled,
        save: (next) => {
          enabled = next;
          return save();
        },
      }),
      textField({
        label: t("windowLabel"),
        hint: t("windowHint").replace("{max}", String(WINDOW_MAX)),
        value: String(policy.windowDays),
        validate: (raw) => {
          const value = Number(raw.trim());
          return Number.isInteger(value) && value >= 1 && value <= WINDOW_MAX
            ? null
            : t("errWindow").replace("{max}", String(WINDOW_MAX));
        },
        save: (raw) => {
          windowDays = Number(raw.trim());
          return save();
        },
      }),
    ),
    ...rows,
    h("p", { class: "field-hint" }, t("addRungHint")),
    h("div", { class: "field-row" }, warnsInput, durationInput),
    selectField({
      label: t("thenLabel"),
      value: newAction,
      options: [
        ["MUTE", lookup(t("rungAction"), "MUTE", "mute")],
        ["BAN", lookup(t("rungAction"), "BAN", "ban")],
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
        label: t("rowLabel").replace("{action}", row.discordAction.toLowerCase()),
        hint: lookup(t("gameAction"), row.gameAction, ""),
        checked: row.enabled,
        save: (next) => {
          row.enabled = next;
          return save();
        },
      }),
      selectField({
        label: t("inGuildChatLabel"),
        value: row.gameAction,
        options: gameActionOptions(),
        save: (next) => {
          row.gameAction = next as typeof row.gameAction;
          return save();
        },
      }),
      // Only a mute has a length to argue about; a kick happens once.
      ...(row.gameAction === "g mute"
        ? [
            selectField({
              label: t("durationModeLabel"),
              value: row.durationMode,
              options: [
                ["same", t("durationModeSame")],
                ["fixed", t("durationModeFixed")],
              ],
              save: (next) => {
                row.durationMode = next as typeof row.durationMode;
                return save();
              },
            }),
            ...(row.durationMode === "fixed"
              ? [
                  textField({
                    label: t("lengthLabel"),
                    hint: t("lengthHint"),
                    value: row.fixedSeconds === null ? "" : String(row.fixedSeconds),
                    validate: (raw) => {
                      const value = Number(raw.trim());
                      return Number.isInteger(value) && value >= 1 && value <= MAX_GAME_MUTE_SECONDS
                        ? null
                        : t("errLength").replace("{max}", String(MAX_GAME_MUTE_SECONDS));
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
    h("p", { class: "field-hint" }, t("relaySyncHint")),
    fieldGroup(
      toggleField({
        label: t("relaySyncLabel"),
        hint: t("relaySyncFieldHint"),
        checked: policy.enabled,
        save: (next) => {
          enabled = next;
          return save();
        },
      }),
    ),
    ...rowFields,
    h("p", { class: "field-hint" }, t("relaySyncReverseNote")),
    status.el,
  );
}

function describeRung(rung: { warns: number; action: string; durationSeconds: number | null }): string {
  const how =
    rung.durationSeconds === null
      ? t("rungPermanent")
      : t("rungFor").replace("{span}", describeSpan(rung.durationSeconds * 1000));
  return t("rung")
    .replace("{warns}", String(rung.warns))
    .replace("{warnWord}", rung.warns === 1 ? t("warnOne") : t("warnMany"))
    .replace("{action}", lookup(t("rungAction"), rung.action, rung.action.toLowerCase()))
    .replace("{how}", how);
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
    return t("errSeverity").replace("{max}", String(SEVERITY_MAX));
  }
  return null;
}
