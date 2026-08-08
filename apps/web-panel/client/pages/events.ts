/**
 * Events & attendance (WEB_PANEL.md §3.8) — what is scheduled, who said they're
 * coming, and the two things staff can do about it: schedule one, call one off.
 *
 * Scheduling is the panel's one other composite form (moderation actions being
 * the first). Everywhere else a field saves itself, but half an event — a title
 * with no start time — is not a thing the domain can store, so this one submits
 * as a unit and reports as a unit.
 *
 * The roster arrives on the same read as the list, keyed by `?event=`, so
 * opening an event never shows counts from one fetch beside names from another.
 *
 * Three parts of §3.8 are not here because they are not in the domain yet:
 * editing a scheduled event, marking who actually turned up, and posting the
 * announcement or reminders to Discord. `CommunityService` has no method for
 * any of them, and a button that silently did nothing would be worse than none.
 */
import type { EventAttendance, EventRsvp, EventsVM, PanelEvent } from "@sbr/panel-core";
import { loadPage, postAction } from "../api.js";
import {
  badge,
  card,
  deniedState,
  emptyState,
  errorState,
  pageTitle,
  spinner,
  statTile,
  table,
  type BadgeTone,
} from "../components.js";
import { h, replace } from "../dom.js";
import { actionButton, statusSlot } from "../forms.js";
import { count, countdown, dateTime, localInputToIso } from "../format.js";

/** The event types the schema knows, mirroring `EVENT_TYPES` in the mutations. */
const TYPES: readonly (readonly [string, string])[] = [
  ["DUNGEON", "Dungeon"],
  ["SLAYER", "Slayer"],
  ["FISHING", "Fishing"],
  ["MINING", "Mining"],
  ["GIVEAWAY", "Giveaway"],
  ["MEETING", "Meeting"],
  ["CUSTOM", "Custom"],
];

/** Statuses that still have a future. */
const UPCOMING = new Set(["SCHEDULED", "LIVE"]);

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2_000;

/** Which event's roster is open. Survives a re-read, like the analytics window. */
const state: { selected: string } = { selected: "" };

export async function renderEvents(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading events…"));

  const query = state.selected ? `?event=${encodeURIComponent(state.selected)}` : "";
  const result = await loadPage<EventsVM>(`/api/guilds/${encodeURIComponent(guildId)}/events${query}`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderEvents(host, guildId)));
  }

  const data = result.data;
  // The server drops a selection it can't resolve, so a cancelled-and-purged
  // event doesn't leave the page asking for it on every refresh.
  state.selected = data.selected;
  const rerender = (): void => void renderEvents(host, guildId);

  const upcoming = data.events
    .filter((event) => UPCOMING.has(event.status))
    .slice()
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const past = data.events.filter((event) => !UPCOMING.has(event.status));
  const next = upcoming[0] ?? null;
  const open = data.events.find((event) => event.id === data.selected) ?? null;

  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Events", `${count(upcoming.length)} scheduled`),
      h(
        "div",
        { class: "tiles" },
        statTile("Upcoming", count(upcoming.length)),
        statTile("Next up", next ? countdown(next.startsAt) : "—", next?.title ?? "Nothing scheduled"),
        statTile("Going to next", next ? seats(next) : "—"),
      ),
      card("Schedule an event", createForm(guildId, rerender)),
      card("Upcoming", upcomingBody(guildId, upcoming, rerender)),
      open && data.attendance
        ? card(`Who's coming — ${open.title}`, rosterBody(data.attendance))
        : null,
      card("Finished and cancelled", pastBody(past)),
    ),
  );
}

// ─────────────────────────── scheduling ───────────────────────────

function createForm(guildId: string, rerender: () => void): HTMLElement {
  const status = statusSlot();

  const title = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: "Catacombs F7 carry night",
    "aria-label": "Event title",
    maxlength: TITLE_MAX,
    autocomplete: "off",
  }) as HTMLInputElement;

  const type = h(
    "select",
    { class: "control control-select", "aria-label": "Event type" },
    ...TYPES.map(([value, label]) => h("option", { value }, label)),
  ) as HTMLSelectElement;

  // `datetime-local` rather than a text box: it is the one input that gives a
  // calendar and a clock without shipping a date picker, and its value is local
  // wall time — which is what someone scheduling a run is thinking in.
  const startsAt = h("input", {
    class: "control control-short",
    type: "datetime-local",
    "aria-label": "Starts at",
  }) as HTMLInputElement;

  const capacity = h("input", {
    class: "control control-short",
    type: "number",
    min: 1,
    max: 1000,
    placeholder: "No limit",
    "aria-label": "Capacity",
  }) as HTMLInputElement;

  const description = h("textarea", {
    class: "control control-area",
    rows: 2,
    placeholder: "What is it, and what should people bring? (optional)",
    "aria-label": "Description",
    maxlength: DESCRIPTION_MAX,
  }) as unknown as HTMLTextAreaElement;

  const create = actionButton({
    label: "Schedule",
    tone: "primary",
    status,
    run: async () => {
      const name = title.value.trim();
      if (name.length === 0) return { kind: "error", message: "Give the event a title." };

      const iso = localInputToIso(startsAt.value);
      if (iso === null) return { kind: "error", message: "Pick a start date and time." };
      // Checked here as well as in CommunityService so the obvious mistake —
      // scheduling into a date that has already passed — answers immediately.
      if (Date.parse(iso) <= Date.now()) {
        return { kind: "error", message: "That start time has already passed." };
      }

      const seatsRaw = capacity.value.trim();
      const seats = seatsRaw.length === 0 ? null : Number(seatsRaw);
      if (seats !== null && (!Number.isInteger(seats) || seats < 1)) {
        return { kind: "error", message: "Capacity has to be a whole number of at least 1." };
      }

      return postAction(guildId, "event.create", {
        title: name,
        type: type.value,
        startsAt: iso,
        capacity: seats,
        description: description.value.trim(),
      });
    },
    onDone: rerender,
  });

  return h(
    "div",
    { class: "fields" },
    h("div", { class: "field-row" }, title, type),
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label field-label-inline" }, "Starts"),
      startsAt,
      h("label", { class: "field-label field-label-inline" }, "Capacity"),
      capacity,
    ),
    h("div", { class: "field-row" }, description),
    h("div", { class: "field-row" }, create, status.el),
    h(
      "p",
      { class: "field-hint" },
      "You are recorded as the host, and the host is the only person who can cancel it.",
    ),
  );
}

// ─────────────────────────── the list ───────────────────────────

function upcomingBody(guildId: string, events: readonly PanelEvent[], rerender: () => void): HTMLElement {
  if (events.length === 0) return emptyState("Nothing scheduled. Anything you create above lands here.");
  return h("div", { class: "queue" }, ...events.map((event) => eventRow(guildId, event, rerender)));
}

function eventRow(guildId: string, event: PanelEvent, rerender: () => void): HTMLElement {
  const status = statusSlot();
  const isOpen = state.selected === event.id;

  const toggle = h(
    "button",
    {
      class: "button",
      type: "button",
      "aria-expanded": isOpen ? "true" : "false",
      onclick: () => {
        // A second click closes it, so the roster card doesn't become permanent
        // furniture once someone has looked at one event.
        state.selected = isOpen ? "" : event.id;
        rerender();
      },
    },
    isOpen ? "Hide RSVPs" : "View RSVPs",
  );

  const cancel = actionButton({
    label: "Cancel event",
    tone: "danger",
    confirm: "Confirm cancel",
    status,
    run: () => postAction(guildId, "event.cancel", { eventId: event.id }),
    onDone: rerender,
  });

  return h(
    "article",
    { class: "queue-item" },
    h(
      "header",
      { class: "queue-head" },
      h("strong", {}, event.title),
      badge(event.type.toLowerCase(), "neutral"),
      badge(event.status.toLowerCase(), statusTone(event.status)),
      h("span", { class: "muted" }, `${dateTime(event.startsAt)} · ${countdown(event.startsAt)}`),
    ),
    h(
      "p",
      { class: "muted" },
      `${seats(event)} going · ${count(event.maybe)} maybe · ${count(event.declined)} declined`,
      event.hostDiscordId ? " · hosted by " : " · no host on record",
      event.hostDiscordId ? h("code", {}, event.hostDiscordId) : null,
    ),
    h("div", { class: "row-actions" }, toggle, cancel, status.el),
  );
}

/** "8 of 12" when the event is capped, a bare count when it isn't. */
function seats(event: PanelEvent): string {
  return event.capacity === null ? count(event.going) : `${count(event.going)} of ${count(event.capacity)}`;
}

function statusTone(status: string): BadgeTone {
  switch (status) {
    case "LIVE":
      return "ok";
    case "SCHEDULED":
      return "warn";
    case "CANCELLED":
      return "bad";
    default:
      return "neutral";
  }
}

// ─────────────────────────── the roster ───────────────────────────

/**
 * Four lists rather than one table with a state column: the question this card
 * answers is "how many are actually coming", and that is a count you should be
 * able to take from the top of a column without reading the rows.
 */
function rosterBody(attendance: EventAttendance): HTMLElement {
  const columns: readonly (readonly [string, readonly EventRsvp[]])[] = [
    ["Going", attendance.going],
    ["Waitlisted", attendance.waitlist],
    ["Maybe", attendance.maybe],
    ["Declined", attendance.declined],
  ];

  if (columns.every(([, entries]) => entries.length === 0)) {
    return emptyState("Nobody has responded yet.");
  }

  return h(
    "div",
    { class: "roster" },
    ...columns.map(([label, entries]) =>
      h(
        "section",
        { class: "roster-col" },
        h("h4", {}, `${label} (${count(entries.length)})`),
        entries.length === 0
          ? h("p", { class: "muted" }, "—")
          : h("ul", { class: "roster-list" }, ...entries.map(rosterEntry)),
      ),
    ),
  );
}

function rosterEntry(entry: EventRsvp): HTMLElement {
  // An unnamed id still gets a row: someone counting heads needs the total to be
  // right more than they need every name resolved.
  return h(
    "li",
    {},
    entry.username ? h("span", {}, entry.username) : h("code", {}, entry.discordId),
    h("span", { class: "muted" }, ` ${countdown(entry.respondedAt)}`),
  );
}

// ─────────────────────────── history ───────────────────────────

function pastBody(events: readonly PanelEvent[]): HTMLElement {
  if (events.length === 0) return emptyState("No finished or cancelled events on record.");
  return table(
    ["Event", "Type", "Outcome", "Started", "Went"],
    events.map((event) => [
      event.title,
      event.type.toLowerCase(),
      badge(event.status.toLowerCase(), statusTone(event.status)),
      dateTime(event.startsAt),
      seats(event),
    ]),
  );
}
