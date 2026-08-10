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
import { MILESTONE_METRICS, MilestoneType } from "@sbr/shared-types";
import { loadPage, postAction, type WriteResult } from "../api.js";
import { badge, card, deniedState, emptyState, errorState, pageTitle, spinner } from "../components.js";
import { actionButton, fieldGroup, selectField, statusSlot, textField, toggleField } from "../forms.js";
import { h, replace } from "../dom.js";

/** Mirrors the mutation layer's bounds; see forms.ts on why both exist. */
const MAX_REWARD = 1_000_000;
const KEY_SHAPE = /^[a-z0-9]+(?:[.:-][a-z0-9]+)*$/;

/** What each metric measures, in the admin's terms rather than the field name. */
const METRIC_COPY: Readonly<Record<string, string>> = {
  networth: "Networth, in coins",
  skillAverage: "Skill average",
  catacombsLevel: "Catacombs level",
  slayerXp: "Total slayer XP",
  senitherWeight: "Senither weight",
};

const METRIC_OPTIONS = MILESTONE_METRICS.map(
  (metric) => [metric, METRIC_COPY[metric] ?? metric] as const,
);
const TYPE_OPTIONS = Object.keys(MilestoneType).map((type) => [type, type.toLowerCase().replace(/_/g, " ")] as const);

export async function renderMilestones(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading milestones…"));

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
        pageTitle("Milestones", "Not enabled"),
        emptyState("Milestone tracking isn't switched on for this deployment, so there is nothing to configure."),
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
      pageTitle("Milestones", `${active} of ${definitions.length} being recognised`),
      h(
        "p",
        { class: "page-note" },
        "Detection compares each new snapshot against the one before it, so a threshold only fires when somebody " +
          "crosses it. Adding one now will not fire for members who are already past it.",
      ),
      card("Add a milestone", createForm(guildId, reload)),
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
          label: "Remove",
          tone: "danger",
          confirm: "Confirm remove",
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
        `${METRIC_COPY[definition.metric] ?? definition.metric} • key ${definition.key}`,
      ),
      fieldGroup(
        toggleField({
          label: "Recognised",
          hint: "Off stops this threshold firing for anybody from now on. Milestones already reached are kept.",
          checked: definition.enabled,
          save: (enabled) => write({ enabled }),
        }),
        toggleField({
          label: "Announced",
          hint: "Off still records and still pays the reward — it just doesn't post in the milestones channel.",
          checked: definition.announce,
          save: (announce) => write({ announce }),
        }),
        textField({
          label: "Name",
          hint: "How this reads in the announcement, e.g. \"1b networth\".",
          value: definition.label,
          validate: (raw) => (raw.trim().length === 0 || raw.length > 80 ? "Enter a name up to 80 characters." : null),
          save: (raw) => write({ label: raw.trim() }),
        }),
        textField({
          label: "Threshold",
          hint: "The value that has to be crossed. Coins for networth, levels for catacombs.",
          value: String(definition.threshold),
          validate: validatePositive,
          save: (raw) => write({ threshold: Number(raw.trim()) }),
        }),
        textField({
          label: "XP reward",
          hint: "Credited once, when the milestone is recorded. 0 recognises it without paying for it.",
          value: String(definition.xpReward),
          validate: (raw) => validateWholeReward(raw),
          save: (raw) => write({ xpReward: Number(raw.trim()) }),
        }),
      ),
      remove === null ? null : h("div", { class: "field-row" }, remove),
      status.el,
    ),
    badge(definition.source === "DEFAULT" ? "built-in" : "custom", definition.source === "DEFAULT" ? "neutral" : "ok"),
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

  const key = field("e.g. networth:250b", "Definition key");
  const label = field("e.g. 250b networth", "Milestone name");
  const threshold = field("e.g. 250000000000", "Threshold value");
  const reward = field("0", "XP reward");

  let metric: string = MILESTONE_METRICS[0];
  let type: string = "CUSTOM";

  const button = actionButton({
    label: "Add milestone",
    tone: "primary",
    status,
    run: async () => {
      const keyText = key.value.trim();
      if (!KEY_SHAPE.test(keyText)) {
        return { kind: "error", message: "Keys are lowercase, e.g. networth:250b." };
      }
      if (label.value.trim().length === 0) return { kind: "error", message: "Give it a name." };
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
      "Reusing an existing key edits that milestone instead of adding another one.",
    ),
    h("div", { class: "field-row" }, key, label),
    h("div", { class: "field-row" }, threshold, reward),
    selectField({
      label: "Measured against",
      value: metric,
      options: METRIC_OPTIONS.map(([v, l]) => [v, l] as const),
      // Nothing is stored until "Add milestone" — the dropdown only records the
      // choice, so the save reports success without a write.
      save: async (next) => {
        metric = next;
        return { kind: "ok" };
      },
    }),
    selectField({
      label: "Kind",
      hint: "Grouping only — it does not affect when the milestone fires.",
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
    return "Enter a number greater than zero.";
  }
  return null;
}

function validateWholeReward(raw: string): string | null {
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isInteger(value) || value < 0 || value > MAX_REWARD) {
    return `Enter a whole number between 0 and ${MAX_REWARD}.`;
  }
  return null;
}
