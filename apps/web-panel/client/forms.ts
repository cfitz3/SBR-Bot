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
import type { DirectoryChannel, DirectoryMember, DirectoryRole, DirectoryVM } from "@sbr/panel-core";
import { denialMessage, loadPage, type WriteResult } from "./api.js";
import { scope } from "./copy.js";
import { h } from "./dom.js";

const t = scope("forms");

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
        state === "saving" ? t("saving")
        : state === "saved" ? (message ?? t("saved"))
        : state === "error" ? (message ?? t("saveError"))
        : "";
      // A plain "Saved" is safe to clear — the control itself now shows the new
      // value. A note says something the control does not ("linked, but
      // unconfirmed"), so it stays until the next write replaces it.
      if (state === "saved" && message === undefined) {
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
    slot.set("saved", result.note);
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
  }, t("save")) as HTMLButtonElement;

  const clearButton =
    opts.clear === undefined || opts.readOnly === true
      ? null
      : (h("button", {
          class: "button",
          type: "button",
          disabled: opts.value.length === 0,
          onclick: () => void clear(),
        }, t("clear")) as HTMLButtonElement);

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

// ─────────────────────────── pickers ───────────────────────────

/**
 * The three things a config field ever points at. Each maps to one panel route
 * (`directory-{kind}s`) and one row renderer; nothing else differs between them.
 */
export type PickerKind = "channel" | "role" | "member";

/** What the listbox actually draws — every directory row collapses to this. */
interface PickerRow {
  readonly id: string;
  readonly label: string;
  readonly sub: string | null;
}

interface DirectoryAnswer {
  readonly available: boolean;
  readonly rows: readonly PickerRow[];
}

const UNAVAILABLE: DirectoryAnswer = { available: false, rows: [] };

/**
 * A page-lifetime cache in front of the directory routes.
 *
 * A settings page mounts a dozen pickers, and each one wants the same
 * unfiltered list to turn its stored snowflake into a name. Without this that is
 * a dozen identical requests on every render. The in-flight map matters as much
 * as the value map: the pickers mount in the same tick, so the first request has
 * not returned by the time the twelfth asks.
 */
const DIRECTORY_TTL_MS = 30_000;
const directoryCache = new Map<string, { at: number; value: DirectoryAnswer }>();
const directoryInflight = new Map<string, Promise<DirectoryAnswer>>();

/**
 * Drop what has already lapsed, on the way to storing something new.
 *
 * The cache is keyed by search text, so a staffer typing into a member picker
 * mints an entry per keystroke. Checking the TTL on read alone would leave every
 * one of those entries in the map for the life of the page — never returned
 * again, never collected. Pruning on write keeps the map the size of what is
 * actually still warm, and the work is proportional to a map that stays small
 * precisely because of it.
 */
function pruneDirectoryCache(now: number): void {
  for (const [key, entry] of directoryCache) {
    if (now - entry.at >= DIRECTORY_TTL_MS) directoryCache.delete(key);
  }
}

function channelRow(c: DirectoryChannel): PickerRow {
  // `#` only for the kinds Discord itself prefixes; a voice channel rendered as
  // `#General` is a small lie that makes the list harder to scan, not easier.
  const prefix = c.type === "text" || c.type === "announcement" || c.type === "forum" ? "#" : "";
  return { id: c.id, label: `${prefix}${c.name}`, sub: c.parentName };
}

function roleRow(r: DirectoryRole): PickerRow {
  return { id: r.id, label: `@${r.name}`, sub: r.managed ? t("roleManaged") : null };
}

function memberRow(m: DirectoryMember): PickerRow {
  return {
    id: m.id,
    // Server nickname first, because that is the name the rest of the guild sees
    // this person by, and it is what staff will type when searching.
    label: m.nick ?? m.globalName ?? m.username,
    sub: (m.bot ? t("memberBotHandle") : t("memberHandle")).replace("{username}", m.username),
  };
}

async function fetchDirectory(guildId: string, kind: PickerKind, q: string): Promise<DirectoryAnswer> {
  const key = JSON.stringify([guildId, kind, q]);
  const hit = directoryCache.get(key);
  if (hit && Date.now() - hit.at < DIRECTORY_TTL_MS) return hit.value;
  const pending = directoryInflight.get(key);
  if (pending) return pending;

  const request = (async (): Promise<DirectoryAnswer> => {
    const path =
      `/api/guilds/${encodeURIComponent(guildId)}/directory-${kind}s` +
      (q.length > 0 ? `?q=${encodeURIComponent(q)}` : "");
    const result = await loadPage<DirectoryVM>(path);
    if (result.kind !== "ok") return UNAVAILABLE;

    const vm = result.data;
    const rows =
      vm.kind === "channels" ? vm.rows.map(channelRow)
      : vm.kind === "roles" ? vm.rows.map(roleRow)
      : vm.rows.map(memberRow);
    const answer: DirectoryAnswer = { available: vm.available, rows };
    // Only a real answer is worth keeping: caching "the bot is down" would keep
    // the picker dead for half a minute after it came back.
    if (answer.available) {
      const at = Date.now();
      pruneDirectoryCache(at);
      directoryCache.set(key, { at, value: answer });
    }
    return answer;
  })().finally(() => directoryInflight.delete(key));

  directoryInflight.set(key, request);
  return request;
}

export interface PickerFieldOptions {
  readonly label: string;
  readonly guildId: string;
  readonly kind: PickerKind;
  /** The stored snowflake, or "" when the slot is unset. */
  readonly value: string;
  readonly hint?: string;
  readonly placeholder?: string;
  readonly readOnly?: boolean;
  readonly save: (id: string) => Promise<WriteResult>;
  /** When present, renders a Clear button that writes the "unset" value. */
  readonly clear?: () => Promise<WriteResult>;
}

/**
 * A searchable combobox over the Discord directory — the control that replaced
 * "open Discord, enable developer mode, right-click, Copy ID, come back here".
 *
 * Two things about it are load-bearing:
 *
 * **It writes on selection**, like `toggleField` and `selectField` and unlike
 * `textField`. Choosing a channel from a list *is* the intent; a Save button
 * after it would only add a step where the control shows a value the server has
 * never heard of. A refused write puts the previous name back.
 *
 * **It degrades to a text field.** If the bot isn't serving the directory the
 * list stays empty, the input accepts a raw snowflake, and a Save button
 * appears — exactly the control this replaced. The panel is configurable
 * whether or not the bot is up, which is what makes the picker safe to depend
 * on everywhere.
 *
 * Positioning is done in the stylesheet, never with a `style=` attribute: the
 * panel's CSP grants no 'unsafe-inline', so an inline style would silently not
 * apply and the dropdown would render in the page flow.
 */
export function pickerField(opts: PickerFieldOptions): HTMLElement {
  const slot = statusSlot();
  let baselineId = opts.value;
  let baselineLabel = opts.value;

  const box = combobox({
    guildId: opts.guildId,
    kind: opts.kind,
    value: opts.value,
    ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
    ...(opts.readOnly === true ? { readOnly: true } : {}),
    onChoose: (row) => void choose(row),
    onCommit: () => void commitRaw(),
    onResolved: (label) => {
      baselineLabel = label;
    },
    onRevert: () => baselineLabel,
    onRawMode: syncButtons,
  });

  const saveButton = h("button", {
    class: "button button-primary",
    type: "button",
    hidden: true,
    disabled: true,
    onclick: () => void commitRaw(),
  }, t("save")) as HTMLButtonElement;

  const clearButton =
    opts.clear === undefined || opts.readOnly === true
      ? null
      : (h("button", {
          class: "button",
          type: "button",
          disabled: opts.value.length === 0,
          onclick: () => void clear(),
        }, t("clear")) as HTMLButtonElement);

  function syncButtons(): void {
    if (clearButton) clearButton.disabled = baselineId.length === 0;
    // The Save button exists only on the fallback path: with the directory up,
    // choosing a row is the write, and a Save button beside it would imply the
    // selection had not taken effect.
    saveButton.hidden = !box.isRaw();
    if (box.isRaw()) saveButton.disabled = box.input.value.trim() === baselineId;
  }
  box.input.addEventListener("input", syncButtons);

  async function choose(row: PickerRow): Promise<void> {
    box.input.value = row.label;
    box.input.disabled = true;
    const ok = await attempt(slot, () => opts.save(row.id));
    box.input.disabled = opts.readOnly === true;
    if (ok) {
      baselineId = row.id;
      baselineLabel = row.label;
    } else {
      box.input.value = baselineLabel;
    }
    syncButtons();
  }

  /** The fallback path: whatever was typed is treated as a raw snowflake. */
  async function commitRaw(): Promise<void> {
    if (!box.isRaw()) return;
    const raw = box.input.value.trim();
    const invalid = validateSnowflake(opts.kind)(raw);
    if (invalid !== null) {
      slot.set("error", invalid);
      return;
    }
    saveButton.disabled = true;
    if (await attempt(slot, () => opts.save(raw))) {
      baselineId = raw;
      baselineLabel = raw;
    }
    syncButtons();
  }

  async function clear(): Promise<void> {
    if (!opts.clear) return;
    if (await attempt(slot, opts.clear)) {
      baselineId = "";
      baselineLabel = "";
      box.input.value = "";
    }
    syncButtons();
  }

  return h(
    "div",
    { class: "field" },
    h("label", { class: "field-label", for: box.id }, opts.label),
    h("div", { class: "field-row" }, box.el, saveButton, clearButton),
    opts.hint ? h("p", { class: "field-hint" }, opts.hint) : null,
    slot.el,
  );
}

// ─────────────────────────── the combobox itself ───────────────────────────

interface ComboboxOptions {
  readonly guildId: string;
  readonly kind: PickerKind;
  /** Initial contents — a stored snowflake, resolved to a name if it can be. */
  readonly value: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly readOnly?: boolean;
  readonly onChoose: (row: PickerRow) => void;
  /** Enter pressed with no row highlighted, on the raw-id fallback path. */
  readonly onCommit?: () => void;
  /** The stored id resolved to a display name. */
  readonly onResolved?: (label: string) => void;
  /** What Escape should restore the input to. */
  readonly onRevert?: () => string;
  /** Fired the first time a fetch comes back unavailable. */
  readonly onRawMode?: () => void;
}

interface Combobox {
  /** The `.picker` wrapper — input plus its listbox. */
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  readonly id: string;
  /** True once the directory has answered unavailable: paste an id instead. */
  isRaw(): boolean;
}

/**
 * The searchable input and its listbox, with no opinion about what a selection
 * means. `pickerField` makes a selection a write; `idChooser` makes it a value
 * some other control submits later. Both need identical keyboard handling and
 * identical degradation, which is why that lives here once.
 */
function combobox(opts: ComboboxOptions): Combobox {
  const id = nextId("picker");
  const listId = `${id}-list`;

  let rawMode = false;
  let rows: readonly PickerRow[] = [];
  let active = -1;
  let queryToken = 0;

  const input = h("input", {
    id,
    class: "control control-text",
    type: "text",
    role: "combobox",
    value: opts.value,
    autocomplete: "off",
    spellcheck: "false",
    "aria-expanded": "false",
    "aria-controls": listId,
    "aria-autocomplete": "list",
    ...(opts.ariaLabel === undefined ? {} : { "aria-label": opts.ariaLabel }),
    ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
    ...(opts.readOnly === true ? { disabled: true } : {}),
  }) as HTMLInputElement;

  const list = h("ul", { id: listId, class: "picker-list", role: "listbox", hidden: true });

  function close(): void {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function highlight(next: number): void {
    active = next;
    for (const [index, node] of [...list.children].entries()) {
      const on = index === active;
      node.setAttribute("aria-selected", on ? "true" : "false");
      node.className = on ? "picker-option picker-option-active" : "picker-option";
    }
    const node = list.children[active];
    if (node) {
      input.setAttribute("aria-activedescendant", node.id);
      node.scrollIntoView({ block: "nearest" });
    }
  }

  function draw(): void {
    list.replaceChildren();
    if (rows.length === 0) {
      // A dead directory and a search with no matches are different problems,
      // and only one of them is the operator's to fix by typing something else.
      list.append(
        h("li", { class: "picker-empty", role: "presentation" },
          rawMode ? t("pickerUnavailable") : t("pickerNoMatches")),
      );
    } else {
      list.append(
        ...rows.map((row, index) =>
          h("li", {
            id: `${listId}-${String(index)}`,
            class: "picker-option",
            role: "option",
            "aria-selected": "false",
            // mousedown, not click: the input's blur would close the list before
            // a click ever landed, so the row would look unselectable.
            onmousedown: (event: Event) => {
              event.preventDefault();
              close();
              opts.onChoose(row);
            },
          },
            h("span", { class: "picker-option-label" }, row.label),
            row.sub === null ? null : h("span", { class: "picker-option-sub" }, row.sub),
          ),
        ),
      );
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight(rows.length > 0 ? 0 : -1);
  }

  function enterRawMode(): void {
    if (rawMode) return;
    rawMode = true;
    opts.onRawMode?.();
  }

  async function query(q: string): Promise<void> {
    queryToken += 1;
    const mine = queryToken;
    const answer = await fetchDirectory(opts.guildId, opts.kind, q);
    // A slower earlier keystroke must not overwrite a faster later one.
    if (mine !== queryToken) return;
    if (!answer.available) enterRawMode();
    rows = answer.rows;
    draw();
  }

  input.addEventListener("input", () => void query(input.value.trim()));
  input.addEventListener("focus", () => {
    if (opts.readOnly !== true) void query("");
  });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      if (list.hidden || rows.length === 0) return;
      event.preventDefault();
      highlight((active + (key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
      return;
    }
    if (key === "Escape") {
      close();
      const revert = opts.onRevert?.();
      if (revert !== undefined) input.value = revert;
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      const row = active >= 0 ? rows[active] : undefined;
      if (row && !list.hidden) {
        close();
        opts.onChoose(row);
      } else {
        opts.onCommit?.();
      }
    }
  });

  /**
   * Resolve the stored id to a name up front, so a saved field reads "#general"
   * rather than a snowflake the operator has to go and look up — which is the
   * entire problem this control exists to solve.
   */
  if (opts.value.length > 0) {
    void fetchDirectory(opts.guildId, opts.kind, "").then((answer) => {
      if (!answer.available) return enterRawMode();
      const match = answer.rows.find((row) => row.id === opts.value);
      if (!match) return; // deleted channel, or a member outside the cached page
      opts.onResolved?.(match.label);
      if (document.activeElement !== input) input.value = match.label;
    });
  }

  return {
    el: h("div", { class: "picker" }, input, list),
    input,
    id,
    isRaw: () => rawMode,
  };
}

export interface MultiPickerOptions {
  readonly label: string;
  readonly hint?: string;
  readonly guildId: string;
  readonly kind: PickerKind;
  readonly values: readonly string[];
  readonly placeholder?: string;
  readonly save: (ids: readonly string[]) => Promise<WriteResult>;
}

/**
 * A set of ids, shown as removable chips over one combobox.
 *
 * It keeps the save-on-change contract of the single picker: choosing appends
 * and writes, removing a chip writes the shorter list. The alternative — a
 * comma-separated box with a Save button — is what this replaces, and it made
 * "add one role" a text-editing exercise on a line of snowflakes.
 */
export function multiPickerField(opts: MultiPickerOptions): HTMLElement {
  const slot = statusSlot();
  /** Labels start as the raw ids and are replaced once the directory answers. */
  let selected: { id: string; label: string }[] = opts.values.map((id) => ({ id, label: id }));

  const chips = h("div", { class: "picker-chips" });

  const box = combobox({
    guildId: opts.guildId,
    kind: opts.kind,
    value: "",
    ariaLabel: opts.label,
    ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
    onChoose: (row) => void add(row.id, row.label),
    onCommit: () => {
      const raw = box.input.value.trim();
      const invalid = validateSnowflake(opts.kind)(raw);
      if (invalid !== null) {
        slot.set("error", invalid);
        return;
      }
      void add(raw, raw);
    },
  });

  function drawChips(): void {
    chips.replaceChildren(
      ...selected.map(({ id, label }) =>
        h("span", { class: "picker-chip" },
          h("span", { class: "picker-chip-label" }, label),
          h("button", {
            class: "picker-chip-remove",
            type: "button",
            "aria-label": t("chipRemove").replace("{label}", label),
            onclick: () => void commit(selected.filter((entry) => entry.id !== id)),
          }, "×"),
        ),
      ),
    );
    chips.hidden = selected.length === 0;
  }

  async function commit(next: { id: string; label: string }[]): Promise<void> {
    const previous = selected;
    selected = next;
    drawChips();
    if (!(await attempt(slot, () => opts.save(next.map((entry) => entry.id))))) {
      selected = previous;
      drawChips();
    }
  }

  async function add(id: string, label: string): Promise<void> {
    box.input.value = "";
    if (selected.some((entry) => entry.id === id)) return;
    await commit([...selected, { id, label }]);
  }

  drawChips();

  // One fetch resolves every chip at once, rather than one per stored id.
  if (selected.length > 0) {
    void fetchDirectory(opts.guildId, opts.kind, "").then((answer) => {
      if (!answer.available) return;
      const names = new Map(answer.rows.map((row) => [row.id, row.label]));
      selected = selected.map((entry) => ({ id: entry.id, label: names.get(entry.id) ?? entry.label }));
      drawChips();
    });
  }

  return h(
    "div",
    { class: "field" },
    h("label", { class: "field-label", for: box.id }, opts.label),
    chips,
    h("div", { class: "field-row" }, box.el),
    opts.hint ? h("p", { class: "field-hint" }, opts.hint) : null,
    slot.el,
  );
}

export interface IdChooserOptions {
  readonly guildId: string;
  readonly kind: PickerKind;
  readonly value?: string;
  readonly placeholder?: string;
  readonly ariaLabel: string;
  /** Called when a row is chosen, for pages that act on selection. */
  readonly onPick?: (id: string) => void;
  /** Enter pressed on typed text with no row highlighted. */
  readonly onCommit?: () => void;
}

export interface IdChooser {
  readonly el: HTMLElement;
  /** The chosen snowflake, or whatever was typed when nothing was chosen. */
  value(): string;
  /** Empty it — for forms that must not carry a target into the next write. */
  clear(): void;
}

/**
 * The same combobox as a *value*, for the two places a selection is not itself
 * a write: the moderation lookup box, and the composite action form where a
 * target only means something alongside a type and a reason.
 *
 * `value()` falls back to the typed text so pasting an id still works — with
 * the directory down that is the only way through, and with it up it is still
 * the fastest route for someone who already has the id on their clipboard.
 */
export function idChooser(opts: IdChooserOptions): IdChooser {
  let chosen = opts.value ?? "";

  const box = combobox({
    guildId: opts.guildId,
    kind: opts.kind,
    value: chosen,
    ariaLabel: opts.ariaLabel,
    ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
    ...(opts.onCommit === undefined ? {} : { onCommit: opts.onCommit }),
    onChoose: (row) => {
      chosen = row.id;
      box.input.value = row.label;
      opts.onPick?.(row.id);
    },
  });

  // Typing after a selection means the selection no longer describes what is in
  // the box, so the id is dropped and `value()` falls back to the text.
  box.input.addEventListener("input", () => {
    chosen = "";
  });

  return {
    el: box.el,
    value: () => (chosen !== "" ? chosen : box.input.value.trim()),
    clear: () => {
      chosen = "";
      box.input.value = "";
    },
  };
}

/** The three call shapes, so a page names what it wants rather than a `kind`. */
export function channelPicker(opts: Omit<PickerFieldOptions, "kind">): HTMLElement {
  return pickerField({ ...opts, kind: "channel" });
}

export function rolePicker(opts: Omit<PickerFieldOptions, "kind">): HTMLElement {
  return pickerField({ ...opts, kind: "role" });
}

export function memberPicker(opts: Omit<PickerFieldOptions, "kind">): HTMLElement {
  return pickerField({ ...opts, kind: "member" });
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
    if (raw.length === 0) return t("errIdEmpty").replace("{kind}", kind);
    return SNOWFLAKE.test(raw) ? null : t("errId").replace("{kind}", kind);
  };
}

// `validateThreshold`, `parseThreshold` and `validateCoins` lived here, for the
// screening and recruitment stat bars. Those bars are gone — the scam check is
// the only entry requirement — and no other field in the panel is a nullable
// threshold or a coin figure, so the validators went with them.

/** A required whole number inside a range, for the bounded screening counters. */
export function validateWhole(raw: string, min: number, max: number): string | null {
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isInteger(value) || value < min || value > max) {
    return t("errWhole").replace("{min}", String(min)).replace("{max}", String(max));
  }
  return null;
}
