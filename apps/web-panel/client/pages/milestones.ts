/**
 * Milestones — what the guild recognises, and what reaching one pays.
 *
 * Configuration only, like the XP page and for the same reason: who has reached
 * what is member-facing and lives in the bots (`/milestones`). What this page
 * owns is the thresholds everybody is measured against.
 *
 * Built-in defaults are shown alongside a guild's own rows because they are
 * already in force — a page that listed only stored rows would show an empty
 * list for a guild that is, in fact, recognising thirty things. Editing a
 * default writes a row that shadows it, which is why every control here saves
 * the whole definition rather than a patch.
 */
import type { MilestonesVM } from "@sbr/panel-core";
import type { MilestoneDefinitionDTO } from "@sbr/shared-types";
import { MILESTONE_METRICS, MilestoneType } from "./enums.js";
import { loadPage, postAction, type WriteResult } from "../api.js";
import { badge, card, deniedState, emptyState, errorState, pageTitle, spinner } from "../components.js";
import { actionButton, fieldGroup, selectField, statusSlot, textField, toggleField } from "../forms.js";
import { scope } from "../copy.js";
import { h, replace } from "../dom.js";

const t = scope("milestones");

/** Mirrors the mutation layer's bounds; see forms.ts on why both exist. */
const MAX_REWARD = 1_000_000;
const KEY_SHAPE = /^[a-z0-9]+(?:[.:-][a-z0-9]+)*$/;

/**
 * What each metric measures, in the admin's terms rather than the field name.
 *
 * The fallback to the raw metric name is deliberate: a metric the platform gains
 * before the copy layer names it should still be selectable, reading as its own
 * key rather than vanishing from the dropdown.
 */
const metricLabel = (metric: string): string =>
  (t("metric") as Readonly<Record<string, string>>)[metric] ?? metric;

const metricOptions = (): readonly (readonly [string, string])[] =>
  MILESTONE_METRICS.map((metric) => [metric, metricLabel(metric)] as const);

// Kinds are grouping labels derived from the enum itself, not prose: they exist
// to sort the list, and inventing separate copy for each would be five keys
// nobody would ever change independently.
const TYPE_OPTIONS = Object.keys(MilestoneType).map((type) => [type, type.toLowerCase().replace(/_/g, " ")] as const);

export async function renderMilestones(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("milestones"));

  const result = await loadPage<MilestonesVM>(`/api/guilds/${encodeURIComponent(guildId)}/milestones`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderMilestones(host, guildId)));
  }

  const { installed, definitions } = result.data;
  if (!installed) {
    return replace(
      host,
      h(
        "div",
        {},
        pageTitle(t("title"), t("notEnabled")),
        emptyState("milestonesDisabled"),
      ),
    );
  }

  const reload = (): void => void renderMilestones(host, guildId);
  const active = definitions.filter((d) => d.enabled).length;

  replace(
    host,
    h(
      "div",
      {},
      pageTitle(
        t("title"),
        t("subtitle").replace("{active}", String(active)).replace("{total}", String(definitions.length)),
      ),
      h(
        "p",
        { class: "page-note" },
        t("note"),
      ),
      card(t("cardAdd"), createForm(guildId, reload)),
      ...definitions.map((definition) => definitionCard(guildId, definition, reload)),
    ),
  );
}

/**
 * One definition's rules.
 *
 * Every control writes the whole definition, because the mutation upserts a
 * whole row: a partial write would need the server to merge against what it
 * has, and for a default there is nothing on the server to merge with.
 */
function definitionCard(
  guildId: string,
  definition: MilestoneDefinitionDTO,
  reload: () => void,
): HTMLElement {
  const current: { -readonly [K in keyof MilestoneDefinitionDTO]: MilestoneDefinitionDTO[K] } = { ...definition };

  const write = (patch: Partial<MilestoneDefinitionDTO>): Promise<WriteResult> => {
    Object.assign(current, patch);
    return postAction(guildId, "milestone.upsert", {
      key: current.key,
      label: current.label,
      description: current.description,
      type: current.type,
      metric: current.metric,
      threshold: current.threshold,
      xpReward: current.xpReward,
      announce: current.announce,
      enabled: current.enabled,
    });
  };

  const status = statusSlot();
  // Only a stored row can be removed. A default has nothing to delete — the way
  // to stop recognising one is the "Recognised" toggle, which stores it off.
  const remove =
    definition.source === "GUILD"
      ? actionButton({
          label: t("remove"),
          tone: "danger",
          confirm: t("removeConfirm"),
          status,
          run: () => postAction(guildId, "milestone.remove", { key: definition.key }),
          onDone: reload,
        })
      : null;

  return card(
    definition.label,
    h(
      "div",
      {},
      h(
        "p",
        { class: "field-hint" },
        t("rowSummary").replace("{metric}", metricLabel(definition.metric)).replace("{key}", definition.key),
      ),
      fieldGroup(
        toggleField({
          label: t("recognisedLabel"),
          hint: t("recognisedHint"),
          checked: definition.enabled,
          save: (enabled) => write({ enabled }),
        }),
        toggleField({
          label: t("announcedLabel"),
          hint: t("announcedHint"),
          checked: definition.announce,
          save: (announce) => write({ announce }),
        }),
        textField({
          label: t("nameLabel"),
          hint: t("nameHint"),
          value: definition.label,
          validate: (raw) => (raw.trim().length === 0 || raw.length > 80 ? t("nameError") : null),
          save: (raw) => write({ label: raw.trim() }),
        }),
        textField({
          label: t("thresholdLabel"),
          hint: t("thresholdHint"),
          value: String(definition.threshold),
          validate: validatePositive,
          save: (raw) => write({ threshold: Number(raw.trim()) }),
        }),
        textField({
          label: t("rewardLabel"),
          hint: t("rewardHint"),
          value: String(definition.xpReward),
          validate: (raw) => validateWholeReward(raw),
          save: (raw) => write({ xpReward: Number(raw.trim()) }),
        }),
      ),
      remove === null ? null : h("div", { class: "field-row" }, remove),
      status.el,
    ),
    badge(
      definition.source === "DEFAULT" ? t("sourceBuiltIn") : t("sourceCustom"),
      definition.source === "DEFAULT" ? "neutral" : "ok",
    ),
  );
}

/**
 * The create form.
 *
 * The key is entered rather than derived from the name, because it is what
 * identifies the definition forever: a name is display text somebody will want
 * to reword, and a key that moved with it would orphan every milestone recorded
 * against the old one.
 */
function createForm(guildId: string, reload: () => void): HTMLElement {
  const status = statusSlot();

  const field = (placeholder: string, ariaLabel: string): HTMLInputElement =>
    h("input", {
      class: "control control-text",
      type: "text",
      placeholder,
      "aria-label": ariaLabel,
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;

  const key = field(t("keyPlaceholder"), t("keyLabel"));
  const label = field(t("labelPlaceholder"), t("labelLabel"));
  const threshold = field(t("thresholdPlaceholder"), t("thresholdValueLabel"));
  const reward = field(t("rewardPlaceholder"), t("rewardLabel"));

  let metric: string = MILESTONE_METRICS[0];
  let type: string = "CUSTOM";

  const button = actionButton({
    label: t("addButton"),
    tone: "primary",
    status,
    run: async () => {
      const keyText = key.value.trim();
      if (!KEY_SHAPE.test(keyText)) {
        return { kind: "error", message: t("keyError") };
      }
      if (label.value.trim().length === 0) return { kind: "error", message: t("labelError") };
      const thresholdError = validatePositive(threshold.value);
      if (thresholdError !== null) return { kind: "error", message: thresholdError };
      const rewardText = reward.value.trim() === "" ? "0" : reward.value;
      const rewardError = validateWholeReward(rewardText);
      if (rewardError !== null) return { kind: "error", message: rewardError };

      return postAction(guildId, "milestone.upsert", {
        key: keyText,
        label: label.value.trim(),
        description: null,
        type,
        metric,
        threshold: Number(threshold.value.trim()),
        xpReward: Number(rewardText.trim()),
        announce: true,
        enabled: true,
      });
    },
    // A reload rather than clearing the inputs: the new definition has to appear
    // in the list below, and an existing key is an edit, not a second row.
    onDone: reload,
  });

  return h(
    "div",
    { class: "field" },
    h(
      "p",
      { class: "field-hint" },
      t("addNote"),
    ),
    h("div", { class: "field-row" }, key, label),
    h("div", { class: "field-row" }, threshold, reward),
    selectField({
      label: t("measuredLabel"),
      value: metric,
      options: metricOptions(),
      // Nothing is stored until "Add milestone" — the dropdown only records the
      // choice, so the save reports success without a write.
      save: async (next) => {
        metric = next;
        return { kind: "ok" };
      },
    }),
    selectField({
      label: t("kindLabel"),
      hint: t("kindHint"),
      value: type,
      options: TYPE_OPTIONS.map(([v, l]) => [v, l] as const),
      save: async (next) => {
        type = next;
        return { kind: "ok" };
      },
    }),
    h("div", { class: "field-row" }, button),
    status.el,
  );
}

function validatePositive(raw: string): string | null {
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isFinite(value) || value <= 0) {
    return t("positiveError");
  }
  return null;
}

function validateWholeReward(raw: string): string | null {
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isInteger(value) || value < 0 || value > MAX_REWARD) {
    return t("rewardError").replace("{max}", String(MAX_REWARD));
  }
  return null;
}
