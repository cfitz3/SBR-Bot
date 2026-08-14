/**
 * The XP section of the Settings page: what activity is worth, and the limits
 * that stop one member farming it.
 *
 * Deliberately configuration only — there is no leaderboard and no member
 * standing here. Those are member-facing, and the panel is not a member-facing
 * surface: `/standing` and `/leaderboard` are where a member sees where they
 * are. What this section owns is the rules everyone is scored by, plus the one
 * write that bypasses them: a hand-entered adjustment.
 *
 * Kept in its own module rather than inlined into `settings.ts` because it is
 * the one section with real logic of its own — eight source forms and a ledger
 * write — and folding it in would bury the rest of the page under it.
 */
import type { XpSettingsVM } from "@sbr/panel-core";
import type { XpSourcePolicyDTO } from "@sbr/shared-types";
import { postAction, type WriteResult } from "../api.js";
import { card, emptyState } from "../components.js";
import { scope, type PanelCopy } from "../copy.js";
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
import { h } from "../dom.js";

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
 * The whole XP section, as cards ready to drop into the Settings page.
 *
 * Returns a list rather than one wrapping card because each source is its own
 * card: eight sources in a single card would be one scroll with no landmarks,
 * and the source is the unit an admin actually thinks in.
 */
export function xpSection(guildId: string, vm: XpSettingsVM): readonly HTMLElement[] {
  if (!vm.installed) {
    return [
      card(t("card"), emptyState("xpDisabled")),
    ];
  }

  return [
    card(
      t("card"),
      h(
        "p",
        { class: "field-hint" },
        t("intro")
          .replace("{on}", String(vm.sources.filter((s) => s.enabled).length))
          .replace("{total}", String(vm.sources.length)),
      ),
    ),
    ...vm.sources.map((policy) => sourceCard(guildId, policy)),
    card(t("cardAdjust"), adjustForm(guildId)),
  ];
}

/**
 * One source's rules.
 *
 * Every control writes the whole row, because the mutation takes a whole
 * policy: a partial write would need the server to merge against what it has,
 * and a merge is where "I turned the cap off" and "I left the cap alone"
 * become the same request.
 */
function sourceCard(guildId: string, policy: XpSourcePolicyDTO): HTMLElement {
  const { label, unit } = copyFor(policy.source);
  // Mutable local copy so each control saves alongside its siblings' current
  // values rather than the values the page happened to load with.
  const current: { -readonly [K in keyof XpSourcePolicyDTO]: XpSourcePolicyDTO[K] } = { ...policy };

  const write = (patch: Partial<XpSourcePolicyDTO>): Promise<WriteResult> => {
    Object.assign(current, patch);
    return postAction(guildId, "xp.source", { ...current });
  };

  const messageSource = policy.source === "DISCORD_MESSAGE" || policy.source === "GUILD_CHAT_MESSAGE";

  return card(
    t("cardSource").replace("{label}", label),
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
function adjustForm(guildId: string): HTMLElement {
  const status = statusSlot();

  const member = idChooser({
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
      const discordId = member.value();
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
      member.clear();
      amount.value = "";
      reason.value = "";
    },
  });

  return h(
    "div",
    { class: "field" },
    h("p", { class: "field-hint" }, t("adjustIntro")),
    h("div", { class: "field-row" }, member.el, amount),
    reason,
    h("div", { class: "field-row" }, button),
    status.el,
  );
}
