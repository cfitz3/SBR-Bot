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
 *
 * The list is grouped by family and each row is collapsed to a line, because
 * the catalog is now twenty-odd metrics across seven families: a flat list of
 * open cards was readable at six and is a scroll at forty. The summary line
 * carries what somebody scanning is actually checking — name, tier, what it
 * measures, whether it is on, and how many members hold it.
 */
import type { MilestonesVM } from "@sbr/panel-core";
import type { MilestoneDefinitionDTO } from "@sbr/shared-types";
import {
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_TIERS,
  CATEGORY_OF_METRIC,
  COMMUNITY_MILESTONE_METRICS,
  MILESTONE_METRICS,
  MilestoneType,
  type AchievementCategory,
} from "./enums.js";
import { loadPage, postAction, type WriteResult } from "../api.js";
import {
  badge,
  card,
  deniedState,
  emptyState,
  errorState,
  pageTitle,
  spinner,
  type BadgeTone,
} from "../components.js";
import { actionButton, fieldGroup, selectField, statusSlot, textField, toggleField } from "../forms.js";
import { scope } from "../copy.js";
import { h, replace } from "../dom.js";

const t = scope("milestones");

/** Mirrors the mutation layer's bounds; see forms.ts on why both exist. */
const MAX_REWARD = 1_000_000;
const MAX_ICON = 4;
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

const categoryLabel = (category: string): string =>
  (t("category") as Readonly<Record<string, string>>)[category] ?? category;

const tierLabel = (tier: string): string =>
  (t("tier") as Readonly<Record<string, string>>)[tier] ?? tier;

const metricOptions = (): readonly (readonly [string, string])[] =>
  MILESTONE_METRICS.map((metric) => [metric, metricLabel(metric)] as const);

const tierOptions = (): readonly (readonly [string, string])[] =>
  ACHIEVEMENT_TIERS.map((tier) => [tier, tierLabel(tier)] as const);

/**
 * Tier as a colour. Ascending scarcity reads as ascending weight, and the two
 * lowest are deliberately `neutral`: bronze is where every definition starts,
 * so colouring it would tint the whole list by default.
 */
const TIER_TONE: Readonly<Record<string, BadgeTone>> = {
  BRONZE: "neutral",
  SILVER: "neutral",
  GOLD: "warn",
  PLATINUM: "ok",
};

const isCommunity = (metric: string): boolean =>
  (COMMUNITY_MILESTONE_METRICS as readonly string[]).includes(metric);

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

  const { installed, definitions, holders, progressionMetrics, metricCatalog, maxProgressionMetrics } =
    result.data;
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
      card(
        t("offeredTitle"),
        chartedForm(guildId, progressionMetrics, metricCatalog, maxProgressionMetrics),
      ),
      card(t("cardAdd"), createForm(guildId, reload)),
      ...groupCards(guildId, definitions, holders, reload),
    ),
  );
}

/**
 * The definitions, one card per family.
 *
 * Families are walked in the platform's declared order rather than sorted by
 * name or by size, so the page reads the same on every guild — an admin who
 * learns that Dungeons is third should not find it fifth next month because
 * somebody added two wealth thresholds. An empty family is omitted entirely
 * rather than shown as a heading over nothing.
 *
 * A metric the browser's mirror does not know lands in PROGRESSION, matching
 * `categoryOfMetric` upstream: a definition in the wrong group still edits, and
 * one dropped from the list would silently become uneditable.
 */
function groupCards(
  guildId: string,
  definitions: readonly MilestoneDefinitionDTO[],
  holders: Readonly<Record<string, number>>,
  reload: () => void,
): readonly HTMLElement[] {
  const grouped = new Map<AchievementCategory, MilestoneDefinitionDTO[]>();
  for (const definition of definitions) {
    const category = CATEGORY_OF_METRIC[definition.metric] ?? "PROGRESSION";
    const bucket = grouped.get(category);
    if (bucket === undefined) grouped.set(category, [definition]);
    else bucket.push(definition);
  }

  const cards: HTMLElement[] = [];
  for (const category of ACHIEVEMENT_CATEGORIES) {
    const rows = grouped.get(category);
    if (rows === undefined || rows.length === 0) continue;
    // Within a family, by metric and then ascending threshold: the tiers of one
    // metric are a ladder, and ordering by key would put "1b" before "250b"
    // purely because of how the strings sort.
    const ordered = [...rows].sort((a, b) =>
      a.metric === b.metric ? a.threshold - b.threshold : a.metric.localeCompare(b.metric),
    );
    const on = ordered.filter((d) => d.enabled).length;
    const community = ordered.every((d) => isCommunity(d.metric));

    cards.push(
      card(
        categoryLabel(category),
        h(
          "div",
          {},
          community ? h("p", { class: "field-hint" }, t("communityNote")) : null,
          ...ordered.map((definition) =>
            definitionRow(guildId, definition, holders[definition.key] ?? null, reload),
          ),
        ),
        badge(
          t("groupSummary").replace("{active}", String(on)).replace("{total}", String(ordered.length)),
          on === 0 ? "neutral" : "ok",
        ),
      ),
    );
  }
  return cards;
}

/**
 * One definition's rules, collapsed to a line until you open it.
 *
 * Every control writes the whole definition, because the mutation upserts a
 * whole row: a partial write would need the server to merge against what it
 * has, and for a default there is nothing on the server to merge with.
 */
function definitionRow(
  guildId: string,
  definition: MilestoneDefinitionDTO,
  held: number | null,
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
      tier: current.tier,
      icon: current.icon,
      hidden: current.hidden,
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

  const community = isCommunity(definition.metric);

  return h(
    "details",
    { class: "collapse" },
    h(
      "summary",
      {},
      // The icon is the guild's own choice of character and goes in as text,
      // never as markup — the same rule the rest of this client follows.
      h("strong", {}, definition.icon === null ? definition.label : `${definition.icon} ${definition.label}`),
      badge(tierLabel(definition.tier), TIER_TONE[definition.tier] ?? "neutral"),
      badge(metricLabel(definition.metric), "neutral"),
      // "Held by 14" is the question staff ask of a threshold, and the two ways
      // of not having an answer are different facts: nobody has reached it, or
      // this family records no crossings to count in the first place.
      badge(holderText(community, held), !community && held !== null && held > 0 ? "ok" : "neutral"),
      definition.hidden ? badge(t("hiddenLabel"), "neutral") : null,
      definition.enabled ? null : badge(t("recognisedLabel"), "warn"),
      badge(
        definition.source === "DEFAULT" ? t("sourceBuiltIn") : t("sourceCustom"),
        definition.source === "DEFAULT" ? "neutral" : "ok",
      ),
    ),
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
      // Community definitions never announce — they are recognised from the
      // standing, not from a crossing, so there is no moment to post about.
      // The switch is omitted rather than shown-and-ignored: a control that
      // saves happily and does nothing is worse than no control at all.
      community
        ? null
        : toggleField({
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
      selectField({
        label: t("tierLabel"),
        hint: t("tierHint"),
        value: definition.tier,
        options: tierOptions(),
        save: (tier) => write({ tier: tier as MilestoneDefinitionDTO["tier"] }),
      }),
      textField({
        label: t("iconLabel"),
        hint: t("iconHint"),
        placeholder: t("iconPlaceholder"),
        value: definition.icon ?? "",
        validate: validateIcon,
        // Empty means "no icon", and null is how the row stores that — an empty
        // string would render as a leading space beside every name.
        save: (raw) => write({ icon: raw.trim() === "" ? null : raw.trim() }),
      }),
      toggleField({
        label: t("hiddenLabel"),
        hint: t("hiddenHint"),
        checked: definition.hidden,
        save: (hidden) => write({ hidden }),
      }),
    ),
    remove === null ? null : h("div", { class: "field-row" }, remove),
    status.el,
  );
}

/** The three things the holder badge can honestly say. */
function holderText(community: boolean, held: number | null): string {
  if (community) return t("holdersUnrecorded");
  if (held === null || held === 0) return t("holdersNone");
  return t("holders").replace("{n}", held.toLocaleString());
}

/**
 * Which metrics /progression offers to chart.
 *
 * It sits on this page rather than one of its own because it is the same
 * question the definitions below ask — which of the tracked numbers this guild
 * cares about — and splitting the two would let a guild recognise a fairy-souls
 * milestone while being unable to chart fairy souls.
 *
 * Unlike every other control here it saves as a unit, hence the plain boxes
 * rather than switches: the set is one value, the cap is on the set, and "at
 * least one" is a rule about the set. Writing each tick separately would mean
 * refusing the flip that empties the menu, which reads as a broken checkbox
 * rather than as the rule it is.
 */
function chartedForm(
  guildId: string,
  chosen: readonly string[],
  catalog: readonly string[],
  limit: number,
): HTMLElement {
  const status = statusSlot();
  const picked = new Set<string>(chosen);
  const count = h("p", { class: "field-hint" });

  const draw = (): void => {
    count.textContent = t("offeredCount")
      .replace("{n}", String(picked.size))
      .replace("{limit}", String(limit));
  };

  const boxes = catalog.map((metric) => {
    const box = h("input", {
      class: "switch-input",
      type: "checkbox",
      ...(picked.has(metric) ? { checked: true } : {}),
    }) as HTMLInputElement;
    box.addEventListener("change", () => {
      // The cap is Discord’s, not ours: a select menu of more than this many
      // options is a rejected payload, so the tick is refused at the box rather
      // than at the save.
      if (box.checked && picked.size >= limit) {
        box.checked = false;
        status.set("error", t("offeredFull").replace("{limit}", String(limit)));
        return;
      }
      if (box.checked) picked.add(metric);
      else picked.delete(metric);
      draw();
    });
    return h("label", { class: "switch-check" }, box, h("span", {}, metricLabel(metric)));
  });

  draw();

  const save = actionButton({
    label: t("offeredSave"),
    tone: "primary",
    status,
    run: async () => {
      // Mirrors the strict validator rather than leaving it to explain itself:
      // the server refuses the empty set by the same rule, but only after a
      // round trip that reads as a save having failed.
      if (picked.size === 0) return { kind: "error", message: t("offeredEmpty") };
      // Catalog order, not click order: the menu the member sees is this list,
      // and it should not depend on which box staff happened to tick first.
      return postAction(guildId, "progression.metrics", {
        metrics: catalog.filter((metric) => picked.has(metric)),
      });
    },
  });

  return h(
    "div",
    { class: "field" },
    h("p", { class: "field-hint" }, t("offeredNote")),
    h("div", { class: "field-row metric-grid" }, ...boxes),
    count,
    h("div", { class: "field-row" }, save),
    status.el,
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

/**
 * The icon cap counts characters the way the mutation layer does — code points,
 * not UTF-16 units, so a single emoji is one and not two.
 */
function validateIcon(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  return [...value].length > MAX_ICON ? t("iconError").replace("{max}", String(MAX_ICON)) : null;
}
