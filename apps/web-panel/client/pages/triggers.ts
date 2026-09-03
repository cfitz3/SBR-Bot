/**
 * Trigger rules: what the bot watches for, and what it does about it.
 *
 * This is the only editor in the panel that batches. Every other surface writes
 * on change, which is right when a control's new state *is* the intent — but a
 * rule is not one control. A starboard is an emoji, a count, a destination and
 * a scope, and saving after each of those would mean a rule that is briefly
 * "repost every star from anyone, into nowhere" while somebody finishes typing
 * it. So the draft is local, one Save writes the whole list, and the validator
 * that judges the list as a set is asked once.
 *
 * The list is redrawn whenever its shape changes — a rule added, removed, or
 * switched from a reaction to a phrase — because those change which controls
 * exist. Editing a value in place does not redraw, so a half-typed phrase is
 * never yanked out from under the cursor.
 */
import type { TriggerAction, TriggerCondition, TriggerRule } from "@sbr/shared-types";
import {
  MAX_PATTERN_LENGTH,
  MAX_REACTION_THRESHOLD,
  MAX_REPLY_LENGTH,
  MAX_TRIGGER_RULES,
  MIN_REACTION_THRESHOLD,
} from "./trigger-limits.js";
import { postAction, type WriteResult } from "../api.js";
import { scope } from "../copy.js";
import { actionButton, idChooser, statusSlot } from "../forms.js";
import { h } from "../dom.js";

const t = scope("triggers");

type ReactionCondition = Extract<TriggerCondition, { kind: "REACTION_COUNT" }>;

/** The draft's rules are edited in place, so this is the mutable twin. */
interface Draft {
  id: string;
  label: string;
  enabled: boolean;
  when: TriggerCondition;
  then: TriggerAction;
  channels: string[];
  exemptChannels: string[];
  includeBots: boolean;
  includeSelf: boolean;
}

function toDraft(rule: TriggerRule): Draft {
  return {
    id: rule.id,
    label: rule.label,
    enabled: rule.enabled,
    when: rule.when,
    then: rule.then,
    channels: [...rule.channels],
    exemptChannels: [...rule.exemptChannels],
    includeBots: rule.includeBots,
    includeSelf: rule.includeSelf,
  };
}

/**
 * A fresh rule is a working starboard, not an empty form.
 *
 * Almost every guild that opens this page wants the same first rule, and an
 * empty row would make them supply four answers before they can see what the
 * feature does. The destination is the one thing left blank, because it is the
 * one thing the platform cannot guess.
 */
function blankRule(existing: readonly Draft[]): Draft {
  const taken = new Set(existing.map((rule) => rule.id));
  let id = "rule";
  for (let n = 1; taken.has(id); n += 1) id = `rule-${n}`;
  return {
    id,
    label: t("newLabel"),
    enabled: true,
    when: { kind: "REACTION_COUNT", emoji: "⭐", threshold: 5 },
    then: { kind: "REPOST", channelId: "" },
    channels: [],
    exemptChannels: [],
    includeBots: false,
    includeSelf: false,
  };
}

function checkbox(label: string, checked: boolean, onChange: (next: boolean) => void): HTMLElement {
  const input = h("input", {
    class: "switch-check",
    type: "checkbox",
    ...(checked ? { checked: true } : {}),
  }) as HTMLInputElement;
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "field-row" }, input, h("span", {}, label));
}

function textInput(
  value: string,
  attrs: Record<string, unknown>,
  onInput: (next: string) => void,
): HTMLInputElement {
  const input = h("input", { class: "control", value, ...attrs }) as HTMLInputElement;
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

/**
 * A local chip list, because the shared multi-picker writes on change.
 *
 * Chips show the raw id rather than resolving a name: this list is redrawn on
 * every edit anywhere in its rule, and a directory fetch per redraw would be a
 * request per keystroke. The combobox above it is where a channel is *found* by
 * name, which is the half that matters.
 */
function channelSet(
  guildId: string,
  label: string,
  hint: string,
  values: string[],
  redraw: () => void,
): HTMLElement {
  const chooser = idChooser({
    guildId,
    kind: "channel",
    ariaLabel: label,
    placeholder: t("channelPlaceholder"),
    onPick: (id) => {
      if (!values.includes(id)) values.push(id);
      chooser.clear();
      redraw();
    },
  });

  return h(
    "div",
    { class: "field" },
    h("label", { class: "field-label" }, label),
    h(
      "div",
      { class: "picker-chips", ...(values.length === 0 ? { hidden: true } : {}) },
      ...values.map((id) =>
        h(
          "span",
          { class: "picker-chip" },
          h("span", { class: "picker-chip-label" }, `#${id}`),
          h(
            "button",
            {
              class: "picker-chip-remove",
              type: "button",
              "aria-label": t("chipRemove"),
              onclick: () => {
                values.splice(values.indexOf(id), 1);
                redraw();
              },
            },
            "×",
          ),
        ),
      ),
    ),
    h("div", { class: "field-row" }, chooser.el),
    h("p", { class: "field-hint" }, hint),
  );
}

function conditionFields(rule: Draft, redraw: () => void): readonly HTMLElement[] {
  const kind = h(
    "select",
    { class: "control control-select", "aria-label": t("whenLabel") },
    h(
      "option",
      { value: "REACTION_COUNT", selected: rule.when.kind === "REACTION_COUNT" },
      t("whenReaction"),
    ),
    h(
      "option",
      { value: "MESSAGE_CONTAINS", selected: rule.when.kind === "MESSAGE_CONTAINS" },
      t("whenPhrase"),
    ),
  ) as HTMLSelectElement;
  kind.addEventListener("change", () => {
    rule.when =
      kind.value === "MESSAGE_CONTAINS"
        ? { kind: "MESSAGE_CONTAINS", phrase: "" }
        : { kind: "REACTION_COUNT", emoji: "⭐", threshold: 5 };
    redraw();
  });

  const head = h("div", { class: "field" }, h("label", { class: "field-label" }, t("whenLabel")), kind);

  if (rule.when.kind === "MESSAGE_CONTAINS") {
    const phrase = rule.when.phrase;
    return [
      head,
      h(
        "div",
        { class: "field" },
        h("label", { class: "field-label" }, t("phraseLabel")),
        textInput(
          phrase,
          { type: "text", maxlength: MAX_PATTERN_LENGTH, placeholder: t("phrasePlaceholder") },
          (next) => {
            rule.when = { kind: "MESSAGE_CONTAINS", phrase: next };
          },
        ),
        h("p", { class: "field-hint" }, t("phraseHint")),
      ),
    ];
  }

  const when = rule.when;
  return [
    head,
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, t("emojiLabel")),
      textInput(when.emoji, { type: "text", maxlength: 64 }, (next) => {
        rule.when = { ...(rule.when as ReactionCondition), emoji: next };
      }),
      h("p", { class: "field-hint" }, t("emojiHint")),
    ),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, t("thresholdLabel")),
      textInput(
        String(when.threshold),
        {
          type: "number",
          class: "control control-short",
          min: MIN_REACTION_THRESHOLD,
          max: MAX_REACTION_THRESHOLD,
        },
        (next) => {
          rule.when = { ...(rule.when as ReactionCondition), threshold: Number.parseInt(next, 10) };
        },
      ),
      h("p", { class: "field-hint" }, t("thresholdHint")),
    ),
  ];
}

function actionFields(guildId: string, rule: Draft, redraw: () => void): readonly HTMLElement[] {
  const kind = h(
    "select",
    { class: "control control-select", "aria-label": t("thenLabel") },
    h("option", { value: "REPOST", selected: rule.then.kind === "REPOST" }, t("thenRepost")),
    h("option", { value: "PIN", selected: rule.then.kind === "PIN" }, t("thenPin")),
    h("option", { value: "REPLY", selected: rule.then.kind === "REPLY" }, t("thenReply")),
  ) as HTMLSelectElement;
  kind.addEventListener("change", () => {
    rule.then =
      kind.value === "PIN"
        ? { kind: "PIN" }
        : kind.value === "REPLY"
          ? { kind: "REPLY", text: "" }
          : { kind: "REPOST", channelId: "" };
    redraw();
  });

  const head = h("div", { class: "field" }, h("label", { class: "field-label" }, t("thenLabel")), kind);

  if (rule.then.kind === "PIN") {
    return [head, h("p", { class: "field-hint" }, t("pinHint"))];
  }

  if (rule.then.kind === "REPLY") {
    const box = h("textarea", {
      class: "control control-area",
      rows: 2,
      maxlength: MAX_REPLY_LENGTH,
      "aria-label": t("replyLabel"),
    }) as unknown as HTMLTextAreaElement;
    box.value = rule.then.text;
    box.addEventListener("input", () => {
      rule.then = { kind: "REPLY", text: box.value };
    });
    return [
      head,
      h(
        "div",
        { class: "field" },
        h("label", { class: "field-label" }, t("replyLabel")),
        box,
        h("p", { class: "field-hint" }, t("replyHint")),
      ),
    ];
  }

  const chooser = idChooser({
    guildId,
    kind: "channel",
    value: rule.then.channelId,
    ariaLabel: t("repostLabel"),
    placeholder: t("channelPlaceholder"),
    onPick: (id) => {
      rule.then = { kind: "REPOST", channelId: id };
    },
  });
  return [
    head,
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label" }, t("repostLabel")),
      chooser.el,
      h("p", { class: "field-hint" }, t("repostHint")),
    ),
  ];
}

/**
 * The whole editor, redrawn from the draft.
 *
 * The draft is posted as typed and the server both validates and normalises it,
 * so nothing here tries to be the authority on a legal rule — this only has to
 * make an illegal one hard to type by accident.
 */
export function triggersForm(guildId: string, initial: readonly TriggerRule[]): HTMLElement {
  const rules: Draft[] = initial.map(toDraft);
  const host = h("div", { class: "fields" });
  const status = statusSlot();

  function draw(): void {
    const save = actionButton({
      label: t("save"),
      tone: "primary",
      status,
      run: async (): Promise<WriteResult> => postAction(guildId, "config.triggers", { rules }),
    });

    const add = h(
      "button",
      {
        class: "button",
        type: "button",
        ...(rules.length >= MAX_TRIGGER_RULES ? { disabled: true } : {}),
        onclick: () => {
          rules.push(blankRule(rules));
          draw();
        },
      },
      t("add"),
    );

    host.replaceChildren(
      ...(rules.length === 0 ? [h("p", { class: "field-hint" }, t("empty"))] : []),
      ...rules.map((rule, index) =>
        h(
          "div",
          { class: "rule-card" },
          h(
            "div",
            { class: "field" },
            h("label", { class: "field-label" }, t("nameLabel")),
            textInput(rule.label, { type: "text", maxlength: 60 }, (next) => {
              rule.label = next;
            }),
            h("p", { class: "field-hint" }, t("nameHint").replace("{id}", rule.id)),
          ),
          checkbox(t("enabled"), rule.enabled, (next) => {
            rule.enabled = next;
          }),
          ...conditionFields(rule, draw),
          ...actionFields(guildId, rule, draw),
          channelSet(guildId, t("channelsLabel"), t("channelsHint"), rule.channels, draw),
          channelSet(guildId, t("exemptLabel"), t("exemptHint"), rule.exemptChannels, draw),
          checkbox(t("includeBots"), rule.includeBots, (next) => {
            rule.includeBots = next;
          }),
          checkbox(t("includeSelf"), rule.includeSelf, (next) => {
            rule.includeSelf = next;
          }),
          h(
            "div",
            { class: "field-row" },
            h(
              "button",
              {
                class: "button button-danger",
                type: "button",
                onclick: () => {
                  rules.splice(index, 1);
                  draw();
                },
              },
              t("remove"),
            ),
          ),
        ),
      ),
      h("div", { class: "field-row" }, add, save),
      h("p", { class: "field-hint" }, t("capHint").replace("{n}", String(MAX_TRIGGER_RULES))),
      status.el,
    );
  }

  draw();
  return host;
}
