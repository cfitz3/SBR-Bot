/**
 * Editable controls for the config pages.
 *
 * Every write in this panel is a single field against a single mutation, so the
 * unit here is a *field that saves itself* rather than a form that batches a
 * page of changes into one submit. That matches the domain services underneath
 * — `setChannel`, `setFeature`, `setBridgeSuspended` each take one value — and
 * it means a rejected field reports its own error instead of failing a save that
 * silently applied four of its five parts.
 *
 * Each control owns its own status line for the same reason: a shared banner at
 * the top of a page cannot say *which* row was refused.
 */
import { denialMessage, type WriteResult } from "./api.js";
import { h } from "./dom.js";

/** Unique ids so every `<label for>` points at its own control. */
let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export interface StatusSlot {
  readonly el: HTMLElement;
  set(state: SaveState, message?: string): void;
}

/**
 * The per-field status line.
 *
 * `aria-live="polite"` because a save result is exactly the kind of change a
 * screen reader user has no other way to notice — the control they just
 * operated looks identical whether the write landed or not.
 */
export function statusSlot(): StatusSlot {
  const el = h("span", { class: "field-status", role: "status", "aria-live": "polite" });
  // Bumped on every transition so a pending "clear the Saved note" timer from an
  // earlier save cannot wipe the error from a later one.
  let token = 0;

  const slot: StatusSlot = {
    el,
    set(state, message) {
      token += 1;
      const mine = token;
      el.className = `field-status field-status-${state}`;
      el.textContent =
        state === "saving" ? "Saving…"
        : state === "saved" ? "Saved"
        : state === "error" ? (message ?? "Couldn't save that.")
        : "";
      if (state === "saved") {
        window.setTimeout(() => {
          if (token === mine) slot.set("idle");
        }, 4_000);
      }
    },
  };
  return slot;
}

/** Run one write and report it in the slot. Returns whether it landed. */
export async function attempt(slot: StatusSlot, save: () => Promise<WriteResult>): Promise<boolean> {
  slot.set("saving");
  const result = await save();
  if (result.kind === "ok") {
    slot.set("saved");
    return true;
  }
  // A denial here is not a bug in the field — it's the server restating the tier
  // this control requires, so it reads the same as it would on a denied page.
  slot.set("error", result.kind === "denied" ? denialMessage(result.reason) : result.message);
  return false;
}

export interface TextFieldOptions {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly placeholder?: string;
  /** Rendered but inert; use for a field the viewer may read but not change. */
  readonly readOnly?: boolean;
  /**
   * Client-side check, run before the round trip. Not the authority — the
   * mutation layer validates everything again — just the difference between a
   * typo answering instantly and a typo answering after a POST.
   */
  readonly validate?: (raw: string) => string | null;
  readonly save: (raw: string) => Promise<WriteResult>;
  /** When present, renders a Clear button that writes the "unset" value. */
  readonly clear?: () => Promise<WriteResult>;
}

export function textField(opts: TextFieldOptions): HTMLElement {
  const id = nextId("field");
  const slot = statusSlot();
  let baseline = opts.value;

  const input = h("input", {
    id,
    class: "control control-text",
    type: "text",
    value: opts.value,
    autocomplete: "off",
    spellcheck: "false",
    ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
    ...(opts.readOnly === true ? { disabled: true } : {}),
  }) as HTMLInputElement;

  const saveButton = h("button", {
    class: "button button-primary",
    type: "button",
    disabled: true,
    onclick: () => void commit(),
  }, "Save") as HTMLButtonElement;

  const clearButton =
    opts.clear === undefined || opts.readOnly === true
      ? null
      : (h("button", {
          class: "button",
          type: "button",
          disabled: opts.value.length === 0,
          onclick: () => void clear(),
        }, "Clear") as HTMLButtonElement);

  function syncButtons(): void {
    if (opts.readOnly === true) return;
    saveButton.disabled = input.value.trim() === baseline;
    if (clearButton) clearButton.disabled = baseline.length === 0;
  }

  input.addEventListener("input", syncButtons);
  input.addEventListener("keydown", (event) => {
    // Enter saves, because a one-field row with a visible Save button that
    // ignores Enter is the single most reliable way to lose an edit.
    if ((event as KeyboardEvent).key === "Enter" && !saveButton.disabled) void commit();
  });

  async function commit(): Promise<void> {
    const raw = input.value.trim();
    const invalid = opts.validate?.(raw) ?? null;
    if (invalid !== null) {
      slot.set("error", invalid);
      return;
    }
    saveButton.disabled = true;
    if (await attempt(slot, () => opts.save(raw))) {
      baseline = raw;
      input.value = raw;
    }
    syncButtons();
  }

  async function clear(): Promise<void> {
    if (!opts.clear) return;
    if (await attempt(slot, opts.clear)) {
      baseline = "";
      input.value = "";
    }
    syncButtons();
  }

  return h(
    "div",
    { class: "field" },
    h("label", { class: "field-label", for: id }, opts.label),
    h("div", { class: "field-row" }, input, saveButton, clearButton),
    opts.hint ? h("p", { class: "field-hint" }, opts.hint) : null,
    slot.el,
  );
}

export interface ToggleFieldOptions {
  readonly label: string;
  readonly checked: boolean;
  readonly hint?: string;
  readonly readOnly?: boolean;
  readonly save: (next: boolean) => Promise<WriteResult>;
}

/**
 * A switch that writes on flip.
 *
 * No Save button: a toggle's new state *is* the intent, and a two-step toggle
 * leaves the control showing a value the server has never heard of. A refused
 * write snaps the switch back, so the widget never lies about what is stored.
 */
export function toggleField(opts: ToggleFieldOptions): HTMLElement {
  const id = nextId("toggle");
  const slot = statusSlot();

  const input = h("input", {
    id,
    class: "switch-input",
    type: "checkbox",
    ...(opts.checked ? { checked: true } : {}),
    ...(opts.readOnly === true ? { disabled: true } : {}),
  }) as HTMLInputElement;

  input.addEventListener("change", () => {
    const next = input.checked;
    input.disabled = true;
    void attempt(slot, () => opts.save(next)).then((ok) => {
      if (!ok) input.checked = !next;
      input.disabled = opts.readOnly === true;
    });
  });

  return h(
    "div",
    { class: "field field-toggle" },
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "switch", for: id }, input, h("span", { class: "switch-track" }, h("span", { class: "switch-thumb" }))),
      h("label", { class: "field-label field-label-inline", for: id }, opts.label),
    ),
    opts.hint ? h("p", { class: "field-hint" }, opts.hint) : null,
    slot.el,
  );
}

export interface SelectFieldOptions {
  /** Omit inside a table cell, where the column header is the label. */
  readonly label?: string;
  readonly ariaLabel?: string;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly hint?: string;
  readonly readOnly?: boolean;
  readonly save: (next: string) => Promise<WriteResult>;
}

/**
 * A dropdown that writes on change, with the same snap-back contract as
 * `toggleField`: a refused change puts the previous option back, so a row can
 * never sit there showing a role nobody granted.
 */
export function selectField(opts: SelectFieldOptions): HTMLElement {
  const id = nextId("select");
  const slot = statusSlot();
  let baseline = opts.value;

  const select = h("select", {
    id,
    class: "control control-select",
    ...(opts.label === undefined ? { "aria-label": opts.ariaLabel ?? "" } : {}),
    ...(opts.readOnly === true ? { disabled: true } : {}),
  }, ...opts.options.map(([value, label]) =>
    h("option", { value, selected: value === opts.value }, label),
  )) as HTMLSelectElement;

  select.addEventListener("change", () => {
    const next = select.value;
    select.disabled = true;
    void attempt(slot, () => opts.save(next)).then((ok) => {
      if (ok) baseline = next;
      else select.value = baseline;
      select.disabled = opts.readOnly === true;
    });
  });

  return h(
    "div",
    { class: opts.label === undefined ? "field field-inline" : "field" },
    opts.label === undefined ? null : h("label", { class: "field-label", for: id }, opts.label),
    h("div", { class: "field-row" }, select),
    opts.hint ? h("p", { class: "field-hint" }, opts.hint) : null,
    slot.el,
  );
}

export interface ActionButtonOptions {
  readonly label: string;
  readonly tone?: "primary" | "danger" | "plain";
  /**
   * When set, the first click only arms the button and shows this label; the
   * second performs the write. Used for the irreversible ones (unlink, ban) in
   * place of `confirm()`, which blocks the tab and cannot be styled or read by
   * the same status line as everything else on the row.
   */
  readonly confirm?: string;
  readonly disabled?: boolean;
  readonly status: StatusSlot;
  readonly run: () => Promise<WriteResult>;
  /** Called after a write lands — normally a re-read of the page it changed. */
  readonly onDone?: () => void;
}

export function actionButton(opts: ActionButtonOptions): HTMLButtonElement {
  const tone = opts.tone ?? "plain";
  const classes = `button${tone === "primary" ? " button-primary" : tone === "danger" ? " button-danger" : ""}`;
  let armed = false;

  const button = h("button", {
    class: classes,
    type: "button",
    ...(opts.disabled === true ? { disabled: true } : {}),
  }, opts.label) as HTMLButtonElement;

  button.addEventListener("click", () => {
    if (opts.confirm !== undefined && !armed) {
      armed = true;
      button.textContent = opts.confirm;
      button.className = `${classes} button-armed`;
      // Disarms itself: an armed destructive button left on screen invites the
      // next click, which may be minutes later and about something else.
      window.setTimeout(() => {
        if (!armed) return;
        armed = false;
        button.textContent = opts.label;
        button.className = classes;
      }, 5_000);
      return;
    }
    armed = false;
    button.textContent = opts.label;
    button.className = classes;
    button.disabled = true;
    void attempt(opts.status, opts.run).then((ok) => {
      button.disabled = opts.disabled === true;
      if (ok) opts.onDone?.();
    });
  });

  return button;
}

/** A multi-line reason box. Reasons are audit rows, so they get real space. */
export function reasonBox(placeholder: string, rows = 2): HTMLTextAreaElement {
  return h("textarea", {
    class: "control control-area",
    rows,
    placeholder,
    "aria-label": placeholder,
    maxlength: REASON_MAX,
  }) as unknown as HTMLTextAreaElement;
}

/** Group fields under one heading inside a card. */
export function fieldGroup(...fields: readonly (HTMLElement | null)[]): HTMLElement {
  return h("div", { class: "fields" }, ...fields);
}

// ─────────────────────────── shared validators ───────────────────────────

/**
 * Same shape check the mutation layer applies. Duplicated deliberately: the
 * server's copy is the one that protects the database, this one exists so a
 * mistyped snowflake is caught before it costs a round trip.
 */
const SNOWFLAKE = /^\d{17,20}$/;

/** Same ceiling `PanelMutations` enforces; mirrored so the box can cap typing. */
export const REASON_MAX = 500;

export function isSnowflake(raw: string): boolean {
  return SNOWFLAKE.test(raw);
}

export function validateSnowflake(kind: string): (raw: string) => string | null {
  return (raw) => {
    if (raw.length === 0) return `Enter a ${kind} id, or use Clear to unset it.`;
    return SNOWFLAKE.test(raw) ? null : `That doesn't look like a Discord ${kind} id (17–20 digits).`;
  };
}

/** Empty means "no requirement", which the recruitment settings encode as null. */
export function validateThreshold(raw: string): string | null {
  if (raw.length === 0) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return "Enter a non-negative number, or leave it blank for no requirement.";
  return null;
}

export function parseThreshold(raw: string): number | null {
  return raw.length === 0 ? null : Number(raw);
}

/**
 * Coins, kept as text all the way to the server.
 *
 * Never parsed to a number here: ten billion coins is past the point where a
 * double is exact, and a threshold that silently shifts by a few coins is the
 * kind of bug that only shows up in an argument about who should have got in.
 */
export function validateCoins(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  return /^\d{1,30}$/.test(text) ? null : "Enter a whole number of coins in digits, or leave it blank.";
}

/** A required whole number inside a range, for the bounded screening counters. */
export function validateWhole(raw: string, min: number, max: number): string | null {
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isInteger(value) || value < min || value > max) {
    return `Enter a whole number between ${min} and ${max}.`;
  }
  return null;
}
