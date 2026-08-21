/**
 * XP — what activity is worth, what the rules produced, and what went around
 * them.
 *
 * This was a section of Settings until it outgrew it: eight source forms were
 * most of that page's height while none of the rest of it was about XP. Moving
 * it also let it gain the two things a configuration screen alone could never
 * answer. An admin changing a weight is guessing until they can see the
 * standings the current weights produced, and an adjustment nobody can see
 * afterwards is an unauditable write — so the page carries a short leaderboard
 * and a short adjustment history beside the rules.
 *
 * Neither list is a report. `/leaderboard` is the member-facing board and the
 * ledger is in the database; twenty rows each is enough to tell whether the
 * numbers are sane and whether anybody has been handing XP out.
 *
 * Each source is a row collapsed to a line, and the limits that most guilds
 * never touch — cap, cooldown, minimum length — sit behind a second disclosure
 * inside it. The weight and the switch are what an admin came for; the rest is
 * anti-abuse tuning, and putting all five controls on screen at once made eight
 * sources read as forty fields.
 */
import type { XpVM } from "@sbr/panel-core";
import type { XpSourcePolicyDTO, XpStandingDTO } from "@sbr/shared-types";
import { loadPage, postAction, type WriteResult } from "../api.js";
import { badge, card, deniedState, emptyState, errorState, pageTitle, spinner, table } from "../components.js";
import { scope, type PanelCopy } from "../copy.js";
import { count, dateTime } from "../format.js";
import {
  actionButton,
  fieldGroup,
  idChooser,
  isSnowflake,
  reasonBox,
  statusSlot,
  textField,
  toggleField,
} from "../forms.js";
import { h, replace } from "../dom.js";

const t = scope("xp");

/** Mirrors the mutation layer's bounds; see forms.ts on why both exist. */
const MAX_WEIGHT = 1_000;
const MAX_DAILY_CAP = 1_000_000;
const MAX_COOLDOWN_SEC = 24 * 60 * 60;
const MAX_MIN_LENGTH = 500;
const MAX_ADJUSTMENT = 1_000_000;

/**
 * What each source counts, in the admin's terms rather than the enum's.
 *
 * The unit matters more than the name: a weight only means something once you
 * know what it multiplies, and "1 per 1000 guild XP" is the difference between
 * a sensible 0.01 and a runaway 10.
 *
 * The fallback keeps a source the platform gains before the copy layer names it
 * selectable, reading as its own key rather than vanishing from the page.
 */
function copyFor(source: string): PanelCopy["xp"]["source"][keyof PanelCopy["xp"]["source"]] {
  const table = t("source") as Readonly<Record<string, { label: string; unit: string }>>;
  return table[source] ?? { label: source, unit: t("sourceUnitFallback") };
}

/** A number the admin typed, bounded. Empty is rejected, not defaulted to 0. */
function validateNumber(raw: string, max: number, whole: boolean): string | null {
  const text = raw.trim();
  const value = Number(text);
  if (text.length === 0 || !Number.isFinite(value) || value < 0 || value > max) {
    return t("errNumberRange").replace("{max}", String(max));
  }
  if (whole && !Number.isInteger(value)) return t("errWholeNumber");
  return null;
}

/**
 * A member, named where the platform knows the name and as their id where it
 * does not.
 *
 * The id is shown rather than hidden behind "Unknown member": somebody who
 * earned XP without linking an account is a real row, and an id can be pasted
 * into Discord while a placeholder cannot.
 */
function member(discordId: string, names: Readonly<Record<string, string>>): HTMLElement {
  const name = names[discordId];
  return name === undefined ? h("code", {}, discordId) : h("span", {}, name);
}

export async function renderXp(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("xp"));

  const result = await loadPage<XpVM>(`/api/guilds/${encodeURIComponent(guildId)}/xp`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderXp(host, guildId)));
  }

  const vm = result.data;
  if (!vm.installed) {
    return replace(host, h("div", {}, pageTitle(t("title"), t("notEnabled")), emptyState("xpDisabled")));
  }

  const reload = (): void => void renderXp(host, guildId);

  replace(
    host,
    h(
      "div",
      {},
      pageTitle(t("title"), t("subtitle")),
      card(t("card"), rulesBody(guildId, vm.sources, reload)),
      card(t("cardAdjust"), adjustForm(guildId, reload)),
      card(t("cardStandings"), standings(vm.leaderboard, vm.names)),
      card(t("cardHistory"), history(vm)),
    ),
  );
}

/**
 * The rules: how many sources are counting, the way to start from a sane set,
 * and one row per source.
 */
function rulesBody(
  guildId: string,
  sources: readonly XpSourcePolicyDTO[],
  reload: () => void,
): HTMLElement {
  const on = sources.filter((s) => s.enabled).length;
  const status = statusSlot();

  const suggest = actionButton({
    label: t("suggestApply"),
    tone: "plain",
    // Confirmed because it overwrites: an admin who has tuned six weights and
    // presses this to "see what it suggests" would lose all six.
    confirm: t("suggestConfirm"),
    status,
    run: () => postAction(guildId, "xp.suggest", {}),
    onDone: reload,
  });

  return h(
    "div",
    { class: "field" },
    h("p", { class: "field-hint" }, t("intro").replace("{on}", String(on)).replace("{total}", String(sources.length))),
    h("p", { class: "field-hint" }, t("suggestHint")),
    h("div", { class: "field-row" }, suggest),
    status.el,
    ...sources.map((policy) => sourceRow(guildId, policy)),
  );
}

/**
 * One source's rules, collapsed to a line until you open it.
 *
 * Every control writes the whole row, because the mutation takes a whole
 * policy: a partial write would need the server to merge against what it has,
 * and a merge is where "I turned the cap off" and "I left the cap alone"
 * become the same request.
 */
function sourceRow(guildId: string, policy: XpSourcePolicyDTO): HTMLElement {
  const { label, unit } = copyFor(policy.source);
  // Mutable local copy so each control saves alongside its siblings' current
  // values rather than the values the page happened to load with.
  const current: { -readonly [K in keyof XpSourcePolicyDTO]: XpSourcePolicyDTO[K] } = { ...policy };

  const write = (patch: Partial<XpSourcePolicyDTO>): Promise<WriteResult> => {
    Object.assign(current, patch);
    return postAction(guildId, "xp.source", { ...current });
  };

  const messageSource = policy.source === "DISCORD_MESSAGE" || policy.source === "GUILD_CHAT_MESSAGE";

  return h(
    "details",
    { class: "collapse" },
    h(
      "summary",
      {},
      h("strong", {}, label),
      badge(policy.enabled ? t("stateOn") : t("stateOff"), policy.enabled ? "ok" : "neutral"),
      // The weight is on the summary line because it is the number an admin
      // scans for: "is chat still worth 1?" should not need eight clicks.
      badge(t("weightBadge").replace("{weight}", String(policy.weight)), "neutral"),
      policy.dailyCap === null
        ? null
        : badge(t("capBadge").replace("{cap}", count(policy.dailyCap)), "neutral"),
    ),
    fieldGroup(
      toggleField({
        label: t("enabledLabel"),
        hint: t("enabledHint").replace("{unit}", unit),
        checked: policy.enabled,
        save: (enabled) => write({ enabled }),
      }),
      textField({
        label: t("weightLabel"),
        hint: t("weightHint").replace("{unit}", unit),
        value: String(policy.weight),
        validate: (raw) => validateNumber(raw, MAX_WEIGHT, false),
        save: (raw) => write({ weight: Number(raw.trim()) }),
      }),
    ),
    h(
      "details",
      { class: "collapse" },
      h("summary", {}, h("span", {}, t("advanced"))),
      h("p", { class: "field-hint" }, t("advancedHint")),
      fieldGroup(
        textField({
          label: t("capLabel"),
          hint: t("capHint"),
          value: policy.dailyCap === null ? "" : String(policy.dailyCap),
          placeholder: t("capPlaceholder"),
          validate: (raw) => (raw.trim().length === 0 ? null : validateNumber(raw, MAX_DAILY_CAP, true)),
          save: (raw) => write({ dailyCap: raw.trim().length === 0 ? null : Number(raw.trim()) }),
          clear: () => write({ dailyCap: null }),
        }),
        textField({
          label: t("cooldownLabel"),
          hint: t("cooldownHint"),
          value: String(policy.cooldownSec),
          validate: (raw) => validateNumber(raw, MAX_COOLDOWN_SEC, true),
          save: (raw) => write({ cooldownSec: Number(raw.trim()) }),
        }),
        // Only shown where it means anything: a minimum length on tenure or on
        // guild XP would be a control that does nothing, which is worse than a
        // missing one — it invites someone to set it and expect an effect.
        messageSource
          ? textField({
              label: t("minLengthLabel"),
              hint: t("minLengthHint"),
              value: String(policy.minLength),
              validate: (raw) => validateNumber(raw, MAX_MIN_LENGTH, true),
              save: (raw) => write({ minLength: Number(raw.trim()) }),
            })
          : null,
      ),
    ),
  );
}

/**
 * The manual adjustment form.
 *
 * Armed before it fires and cleared afterwards, because unlike everything else
 * on this page an adjustment is not a setting that can be corrected by typing
 * a different value — it is a ledger row, and the only way back is a second
 * adjustment in the other direction.
 */
function adjustForm(guildId: string, reload: () => void): HTMLElement {
  const status = statusSlot();

  const who = idChooser({
    guildId,
    kind: "member",
    placeholder: t("adjustMemberPlaceholder"),
    ariaLabel: t("adjustMemberLabel"),
  });

  const amount = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: t("adjustAmountPlaceholder"),
    "aria-label": t("adjustAmountLabel"),
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const reason = reasonBox(t("adjustReason"), 3);

  const button = actionButton({
    label: t("adjustApply"),
    tone: "danger",
    confirm: t("adjustConfirm"),
    status,
    run: async () => {
      const discordId = who.value();
      if (!isSnowflake(discordId)) {
        return { kind: "error", message: t("errNoMember") };
      }
      const value = Number(amount.value.trim());
      if (!Number.isInteger(value) || value === 0 || Math.abs(value) > MAX_ADJUSTMENT) {
        return { kind: "error", message: t("errAmount").replace("{max}", String(MAX_ADJUSTMENT)) };
      }
      if (reason.value.trim().length === 0) return { kind: "error", message: t("errNoReason") };
      return postAction(guildId, "xp.adjust", { discordId, amount: value, reason: reason.value.trim() });
    },
    onDone: () => {
      // Emptied on success so the next adjustment starts from nothing. A form
      // still holding the last amount is how the same 5,000 XP gets applied
      // twice to two different people.
      who.clear();
      amount.value = "";
      reason.value = "";
      // And reloaded, so the adjustment appears in the history below it: the
      // record is the point of writing one, and a page that still shows the
      // previous ten invites a second attempt at the same write.
      reload();
    },
  });

  return h(
    "div",
    { class: "field" },
    h("p", { class: "field-hint" }, t("adjustIntro")),
    h("div", { class: "field-row" }, who.el, amount),
    reason,
    h("div", { class: "field-row" }, button),
    status.el,
  );
}

/** The top standings under the current rules. Read-only, and deliberately short. */
function standings(rows: readonly XpStandingDTO[], names: Readonly<Record<string, string>>): HTMLElement {
  if (rows.length === 0) {
    return h("div", { class: "field" }, h("p", { class: "field-hint" }, t("standingsEmpty")));
  }
  return h(
    "div",
    { class: "field" },
    h("p", { class: "field-hint" }, t("standingsHint")),
    table(
      [t("colRank"), t("colMember"), t("colLevel"), t("colXp")],
      rows.map((row, index) => [
        // The rank the service gave, not the row's position: ties share a
        // position there, and renumbering them here would invent an order.
        String(row.rank ?? index + 1),
        member(row.discordId, names),
        String(row.level),
        count(row.totalXp),
      ]),
    ),
  );
}

/**
 * Recent hand-entered adjustments.
 *
 * Empty reads as "none recorded" rather than as a failure, because both are
 * genuinely possible: a guild may simply never have adjusted anybody, and a
 * deployment whose XP service predates this read has no history to give. Either
 * way the page has nothing to show and says so in the same words.
 */
function history(vm: XpVM): HTMLElement {
  if (vm.recentAdjustments.length === 0) {
    return h("div", { class: "field" }, h("p", { class: "field-hint" }, t("historyEmpty")));
  }
  return h(
    "div",
    { class: "field" },
    h("p", { class: "field-hint" }, t("historyHint")),
    table(
      [t("colWhen"), t("colMember"), t("colAmount"), t("colBy"), t("colReason")],
      vm.recentAdjustments.map((row) => [
        // Local time, because the person reading this is asking "was that
        // today" and the answer is in their day, not in UTC's.
        dateTime(row.at),
        member(row.discordId, vm.names),
        // Signed explicitly: a credit and a debit differ by one character, and
        // a bare "250" beside a bare "-250" is easy to misread in a column.
        (row.amount > 0 ? "+" : "") + count(row.amount),
        row.byDiscordId === null ? h("span", { class: "muted" }, t("byUnknown")) : member(row.byDiscordId, vm.names),
        row.reason.length === 0 ? h("span", { class: "muted" }, t("reasonMissing")) : row.reason,
      ]),
    ),
  );
}
