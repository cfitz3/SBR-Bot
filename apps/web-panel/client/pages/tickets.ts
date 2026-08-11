/**
 * Tickets — what a member may open, and the panel that advertises it.
 *
 * Configuration only, like Milestones and for the same reason: the tickets
 * themselves, and whatever a member wrote in one, stay in the bot where the
 * people in them are. What this page owns is the menu.
 *
 * The five built-in types are shown alongside a guild's own rows because they
 * are already in force — listing only stored rows would show an empty page for
 * a guild that is, in fact, offering five things. Editing a built-in writes a
 * row that shadows it, which is why every control saves the whole type rather
 * than a patch.
 */
import type { TicketsVM } from "@sbr/panel-core";
import type { TicketTypeDTO } from "@sbr/shared-types";
import { TicketCategory } from "./enums.js";
import { loadPage, postAction, type WriteResult } from "../api.js";
import { badge, card, deniedState, emptyState, errorState, pageTitle, spinner } from "../components.js";
import { actionButton, fieldGroup, selectField, statusSlot, textField, toggleField } from "../forms.js";
import { h, replace } from "../dom.js";

/** Mirrors the mutation layer's bounds; see forms.ts on why both exist. */
const KEY_SHAPE = /^[a-z0-9]+(?:[.:-][a-z0-9]+)*$/;
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_STAFF_ROLES = 10;
const PROMPT_MAX = 500;

const CATEGORY_OPTIONS = Object.keys(TicketCategory).map(
  (category) => [category, category.toLowerCase().replace(/_/g, " ")] as const,
);

export async function renderTickets(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading tickets…"));

  const result = await loadPage<TicketsVM>(`/api/guilds/${encodeURIComponent(guildId)}/tickets`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderTickets(host, guildId)));
  }

  const { installed, types, panel } = result.data;
  if (!installed || panel === null) {
    return replace(
      host,
      h(
        "div",
        {},
        pageTitle("Tickets", "Not enabled"),
        emptyState("Ticketing isn't switched on for this deployment, so there is nothing to configure."),
      ),
    );
  }

  const reload = (): void => void renderTickets(host, guildId);
  const open = types.filter((t) => t.enabled).length;

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Tickets", `${open} of ${types.length} on offer`),
      h(
        "p",
        { class: "page-note" },
        "Members pick a type with /ticket. Turning every type off closes ticketing without removing the " +
          "history — the command then says so rather than opening one under a category nobody watches.",
      ),
      card("Panel", panelForm(guildId, panel)),
      card("Add a ticket type", createForm(guildId, reload)),
      ...types.map((type) => typeCard(guildId, type, reload)),
    ),
  );
}

/**
 * One type's rules.
 *
 * Every control writes the whole type, because the mutation upserts a whole
 * row: a partial write would need the server to merge against what it has, and
 * for a built-in there is nothing on the server to merge with.
 */
function typeCard(guildId: string, type: TicketTypeDTO, reload: () => void): HTMLElement {
  const current: { -readonly [K in keyof TicketTypeDTO]: TicketTypeDTO[K] } = { ...type };

  const write = (patch: Partial<TicketTypeDTO>): Promise<WriteResult> => {
    Object.assign(current, patch);
    return postAction(guildId, "ticket.type.upsert", {
      key: current.key,
      label: current.label,
      emoji: current.emoji,
      category: current.category,
      parentChannelId: current.parentChannelId,
      staffRoleIds: [...current.staffRoleIds],
      prompt: current.prompt,
      position: current.position,
      enabled: current.enabled,
    });
  };

  const status = statusSlot();
  // Only a stored row can be removed. A built-in has nothing to delete — the
  // way to stop offering one is the "Offered" toggle, which stores it off.
  const remove =
    type.source === "GUILD"
      ? actionButton({
          label: "Remove",
          tone: "danger",
          confirm: "Confirm remove",
          status,
          run: () => postAction(guildId, "ticket.type.remove", { key: type.key }),
          onDone: reload,
        })
      : null;

  return card(
    type.label,
    h(
      "div",
      {},
      h("p", { class: "field-hint" }, `Filed as ${type.category.toLowerCase()} • key ${type.key}`),
      fieldGroup(
        toggleField({
          label: "Offered",
          hint: "Off removes it from the menu. Tickets already open under it are untouched.",
          checked: type.enabled,
          save: (enabled) => write({ enabled }),
        }),
        textField({
          label: "Name",
          hint: "What a member sees in the menu, e.g. \"Report a member\".",
          value: type.label,
          validate: (raw) => (raw.trim().length === 0 || raw.length > 80 ? "Enter a name up to 80 characters." : null),
          save: (raw) => write({ label: raw.trim() }),
        }),
        textField({
          label: "Prompt",
          hint: "Shown when they open one — the question staff actually want answered first. Blank for none.",
          value: type.prompt ?? "",
          validate: (raw) => (raw.length > PROMPT_MAX ? `Keep it under ${PROMPT_MAX} characters.` : null),
          save: (raw) => write({ prompt: raw.trim() === "" ? null : raw.trim() }),
        }),
        textField({
          label: "Category channel",
          hint: "Channel id new tickets of this type open under. Blank uses the server default.",
          value: type.parentChannelId ?? "",
          validate: validateOptionalSnowflake,
          save: (raw) => write({ parentChannelId: raw.trim() === "" ? null : raw.trim() }),
        }),
        textField({
          label: "Staff roles",
          hint: "Role ids pulled in, comma separated. Blank means the server-wide staff role only.",
          value: type.staffRoleIds.join(", "),
          validate: validateRoleList,
          save: (raw) => write({ staffRoleIds: parseRoleList(raw) }),
        }),
        textField({
          label: "Menu position",
          hint: "Lower sorts first. Ties fall back to the name.",
          value: String(type.position),
          validate: validatePosition,
          save: (raw) => write({ position: Number(raw.trim()) }),
        }),
        selectField({
          label: "Filed as",
          hint: "Which of the fixed categories the ticket is recorded under, for reporting.",
          value: type.category,
          options: CATEGORY_OPTIONS.map(([v, l]) => [v, l] as const),
          save: (next) => write({ category: next as TicketTypeDTO["category"] }),
        }),
      ),
      remove === null ? null : h("div", { class: "field-row" }, remove),
      status.el,
    ),
    badge(type.source === "DEFAULT" ? "built-in" : "custom", type.source === "DEFAULT" ? "neutral" : "ok"),
  );
}

/**
 * The panel's own content.
 *
 * Where it was last posted is recorded server-side rather than edited here:
 * moving the panel to another channel is a re-post, and letting somebody type a
 * message id would let them point the editor at a message nobody owns.
 */
function panelForm(guildId: string, panel: NonNullable<TicketsVM["panel"]>): HTMLElement {
  const current = { ...panel };

  const write = (patch: Partial<typeof current>): Promise<WriteResult> => {
    Object.assign(current, patch);
    return postAction(guildId, "ticket.panel.save", {
      channelId: current.channelId,
      title: current.title,
      description: current.description,
    });
  };

  return h(
    "div",
    {},
    h(
      "p",
      { class: "field-hint" },
      panel.messageId === null
        ? "Not posted yet."
        : `Posted in ${panel.channelId ?? "a channel"}. Changing the channel posts a fresh panel there.`,
    ),
    fieldGroup(
      textField({
        label: "Channel",
        hint: "Channel id the panel is posted in. Blank leaves it unposted.",
        value: panel.channelId ?? "",
        validate: validateOptionalSnowflake,
        save: (raw) => write({ channelId: raw.trim() === "" ? null : raw.trim() }),
      }),
      textField({
        label: "Title",
        hint: "Heading on the panel embed.",
        value: panel.title,
        validate: (raw) => (raw.trim().length === 0 || raw.length > 120 ? "Enter a title up to 120 characters." : null),
        save: (raw) => write({ title: raw.trim() }),
      }),
      textField({
        label: "Description",
        hint: "The paragraph under the heading. Blank for none.",
        value: panel.description ?? "",
        validate: (raw) => (raw.length > 2000 ? "Keep it under 2000 characters." : null),
        save: (raw) => write({ description: raw.trim() === "" ? null : raw.trim() }),
      }),
    ),
  );
}

/**
 * The create form.
 *
 * The key is entered rather than derived from the name, because it is what a
 * member types into `/ticket type:` and what a guild's row joins on: a name is
 * display text somebody will want to reword, and a key that moved with it would
 * break every saved command and shadow nothing.
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

  const key = field("e.g. staff-app", "Ticket type key");
  const label = field("e.g. Staff application", "Ticket type name");
  const prompt = field("What should they tell you first?", "Prompt");
  const position = field("0", "Menu position");

  let category: string = "SUPPORT";

  const button = actionButton({
    label: "Add ticket type",
    tone: "primary",
    status,
    run: async () => {
      const keyText = key.value.trim();
      if (!KEY_SHAPE.test(keyText)) {
        return { kind: "error", message: "Keys are lowercase, e.g. staff-app." };
      }
      if (label.value.trim().length === 0) return { kind: "error", message: "Give it a name." };
      const positionText = position.value.trim() === "" ? "0" : position.value;
      const positionError = validatePosition(positionText);
      if (positionError !== null) return { kind: "error", message: positionError };

      return postAction(guildId, "ticket.type.upsert", {
        key: keyText,
        label: label.value.trim(),
        emoji: null,
        category,
        parentChannelId: null,
        staffRoleIds: [],
        prompt: prompt.value.trim() === "" ? null : prompt.value.trim(),
        position: Number(positionText.trim()),
        enabled: true,
      });
    },
    // A reload rather than clearing the inputs: the new type has to appear in
    // the list below, and an existing key is an edit, not a second row.
    onDone: reload,
  });

  return h(
    "div",
    { class: "field" },
    h("p", { class: "field-hint" }, "Reusing an existing key edits that type instead of adding another one."),
    h("div", { class: "field-row" }, key, label),
    h("div", { class: "field-row" }, prompt, position),
    selectField({
      label: "Filed as",
      value: category,
      options: CATEGORY_OPTIONS.map(([v, l]) => [v, l] as const),
      // Nothing is stored until "Add ticket type" — the dropdown only records
      // the choice, so the save reports success without a write.
      save: async (next) => {
        category = next;
        return { kind: "ok" };
      },
    }),
    h("div", { class: "field-row" }, button),
    status.el,
  );
}

function validateOptionalSnowflake(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  return SNOWFLAKE.test(text) ? null : "Enter a Discord id (17–20 digits), or leave it blank.";
}

function parseRoleList(raw: string): readonly string[] {
  return [...new Set(raw.split(",").map((part) => part.trim()).filter((part) => part !== ""))];
}

function validateRoleList(raw: string): string | null {
  const parts = parseRoleList(raw);
  if (parts.length > MAX_STAFF_ROLES) return `Up to ${MAX_STAFF_ROLES} roles.`;
  return parts.every((part) => SNOWFLAKE.test(part)) ? null : "Role ids are 17–20 digits, comma separated.";
}

function validatePosition(raw: string): string | null {
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isInteger(value) || value < 0 || value > 999) {
    return "Enter a whole number between 0 and 999.";
  }
  return null;
}
