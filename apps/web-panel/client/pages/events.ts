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
 * An open event also shows what the tracker has made of it: the scoreboard the
 * Discord board is drawn from, and the people going who have no linked account
 * for it to poll. The second is the more useful half — a missing name on a
 * leaderboard is otherwise indistinguishable from a member who did nothing.
 *
 * Once an event has started the roster gains a turnout card: the tracker's own
 * observations, which the page shows as fact, plus a tick box for everybody it
 * could not see. That is the half a poller cannot do — a member with no linked
 * account was still in the lobby.
 *
 * One part of §3.8 is still not here because it is not in the domain: posting
 * the announcement or the reminders on demand. The reminders belong to the
 * scheduler, and a button racing it would post twice.
 */
import type {
  EventAttendance,
  EventAttendee,
  EventMetricStandings,
  EventRsvp,
  EventsVM,
  PanelEvent,
} from "@sbr/panel-core";
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
import { scope, type PanelCopy } from "../copy.js";
import { h, replace } from "../dom.js";
import { actionButton, statusSlot } from "../forms.js";
import {
  compactNumber,
  count,
  countdown,
  dateTime,
  isoToLocalInput,
  localInputToIso,
  relativeTime,
} from "../format.js";

const t = scope("events");
const c = scope("common");

/**
 * The event types the schema knows, mirroring `EVENT_TYPES` in the mutations.
 *
 * The list is structure; the words are copy, so a guild that runs "Kuudra" where
 * we say "Dungeon" changes one key rather than the value the form writes.
 */
const TYPES = [
  "DUNGEON",
  "SLAYER",
  "FISHING",
  "MINING",
  "GIVEAWAY",
  "MEETING",
  "CUSTOM",
] as const satisfies readonly (keyof PanelCopy["events"]["type"])[];

const typeOptions = (): readonly (readonly [string, string])[] =>
  TYPES.map((value) => [value, t("type")[value]] as const);

/**
 * What the tracker can score, mirroring `EVENT_METRICS` in `@sbr/jobs` and the
 * copy of it the mutations validate against.
 *
 * Offering a metric no capture writes would leave a leaderboard permanently
 * empty with nothing on the page to explain why, so this list is deliberately
 * the snapshot's own fields and not a wish list.
 */
const METRICS = [
  "skyblockLevel",
  "networth",
  "skillAverage",
  "catacombsLevel",
  "slayerXp",
  "senitherWeight",
] as const satisfies readonly (keyof PanelCopy["events"]["metric"])[];

/** Statuses that still have a future. */
const UPCOMING = new Set(["SCHEDULED", "LIVE"]);

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2_000;

/** The tracker's polling bounds, mirroring `CommunityServiceImpl`. */
const POLL_MIN = 5;
const POLL_MAX = 1_440;

/** Which event is open. Survives a re-read, like the analytics window. */
const state: { selected: string } = { selected: "" };

export async function renderEvents(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("events"));

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
      pageTitle(t("title"), t("subtitle").replace("{count}", count(upcoming.length))),
      h(
        "div",
        { class: "tiles" },
        statTile(t("tileUpcoming"), count(upcoming.length)),
        statTile(
          t("tileNext"),
          next ? countdown(next.startsAt) : c("dash"),
          next?.title ?? t("tileNextNone"),
        ),
        statTile(t("tileGoing"), next ? seats(next) : c("dash")),
      ),
      card(t("cardCreate"), createForm(guildId, rerender)),
      card(t("cardUpcoming"), upcomingBody(guildId, upcoming, rerender)),
      open ? card(t("cardManage").replace("{title}", open.title), manageBody(guildId, open, rerender)) : null,
      open ? card(t("cardScores").replace("{title}", open.title), scoresBody(open, data.standings, data.unlinked)) : null,
      open && data.attendance
        ? card(t("cardRoster").replace("{title}", open.title), rosterBody(data.attendance))
        : null,
      open && data.attendance && showTurnout(open, data.attendance)
        ? card(
            t("cardTurnout").replace("{title}", open.title),
            turnoutBody(guildId, data.attendance, rerender),
          )
        : null,
      card(t("cardPast"), pastBody(past, rerender)),
    ),
  );
}

// ─────────────────────────── scheduling ───────────────────────────

function createForm(guildId: string, rerender: () => void): HTMLElement {
  const status = statusSlot();

  const title = h("input", {
    class: "control control-text",
    type: "text",
    placeholder: t("titlePlaceholder"),
    "aria-label": t("titleLabel"),
    maxlength: TITLE_MAX,
    autocomplete: "off",
  }) as HTMLInputElement;

  const type = h(
    "select",
    { class: "control control-select", "aria-label": t("typeLabel") },
    ...typeOptions().map(([value, label]) => h("option", { value }, label)),
  ) as HTMLSelectElement;

  // `datetime-local` rather than a text box: it is the one input that gives a
  // calendar and a clock without shipping a date picker, and its value is local
  // wall time — which is what someone scheduling a run is thinking in.
  const startsAt = h("input", {
    class: "control control-short",
    type: "datetime-local",
    "aria-label": t("startsLabel"),
  }) as HTMLInputElement;

  const capacity = h("input", {
    class: "control control-short",
    type: "number",
    min: 1,
    max: 1000,
    placeholder: t("capacityPlaceholder"),
    "aria-label": t("capacityLabel"),
  }) as HTMLInputElement;

  const description = h("textarea", {
    class: "control control-area",
    rows: 2,
    placeholder: t("descriptionPlaceholder"),
    "aria-label": t("descriptionLabel"),
    maxlength: DESCRIPTION_MAX,
  }) as unknown as HTMLTextAreaElement;

  const create = actionButton({
    label: t("create"),
    tone: "primary",
    status,
    run: async () => {
      const name = title.value.trim();
      if (name.length === 0) return { kind: "error", message: t("errNoTitle") };

      const iso = localInputToIso(startsAt.value);
      if (iso === null) return { kind: "error", message: t("errNoStart") };
      // Checked here as well as in CommunityService so the obvious mistake —
      // scheduling into a date that has already passed — answers immediately.
      if (Date.parse(iso) <= Date.now()) {
        return { kind: "error", message: t("errPastStart") };
      }

      const seatsRaw = capacity.value.trim();
      const seats = seatsRaw.length === 0 ? null : Number(seatsRaw);
      if (seats !== null && (!Number.isInteger(seats) || seats < 1)) {
        return { kind: "error", message: t("errCapacity") };
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
      h("label", { class: "field-label field-label-inline" }, t("startsInline")),
      startsAt,
      h("label", { class: "field-label field-label-inline" }, t("capacityInline")),
      capacity,
    ),
    h("div", { class: "field-row" }, description),
    h("div", { class: "field-row" }, create, status.el),
    h(
      "p",
      { class: "field-hint" },
      t("createNote"),
    ),
  );
}

// ─────────────────────────── the list ───────────────────────────

function upcomingBody(guildId: string, events: readonly PanelEvent[], rerender: () => void): HTMLElement {
  if (events.length === 0) return emptyState("eventsUpcoming");
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
    isOpen ? t("hideRsvps") : t("showRsvps"),
  );

  const cancel = actionButton({
    label: t("cancel"),
    tone: "danger",
    confirm: t("cancelConfirm"),
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
      h("span", { class: "muted" }, `${dateTime(event.startsAt)} ${c("dot")} ${countdown(event.startsAt)}`),
    ),
    h(
      "p",
      { class: "muted" },
      t("rowCounts")
        .replace("{going}", seats(event))
        .replace("{maybe}", count(event.maybe))
        .replace("{declined}", count(event.declined)),
      event.hostDiscordId ? t("hostedBy") : t("noHost"),
      event.hostDiscordId ? h("code", {}, event.hostDiscordId) : null,
    ),
    h("div", { class: "row-actions" }, toggle, cancel, status.el),
  );
}

/** "8 of 12" when the event is capped, a bare count when it isn't. */
function seats(event: PanelEvent): string {
  if (event.capacity === null) return count(event.going);
  return t("seatsCapped").replace("{going}", count(event.going)).replace("{capacity}", count(event.capacity));
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

// ─────────────────────── managing one event ───────────────────────

/**
 * The edit form, the tracker's settings, and the two irreversible-ish buttons.
 *
 * Like `createForm` this submits as a unit, and for the same reason: a start
 * time and a capacity that disagree are not two independent edits. Nothing here
 * saves on blur the way the settings pages do — an event is read by other
 * people the moment it changes, so a half-typed title should not become the
 * title.
 *
 * Every field is sent on Save, including the ones nobody touched, so the values
 * on screen are the values stored — a field left alone has no way to quietly
 * keep an older one.
 */
function manageBody(guildId: string, event: PanelEvent, rerender: () => void): HTMLElement {
  const status = statusSlot();
  const editable = UPCOMING.has(event.status);

  const title = h("input", {
    class: "control control-text",
    type: "text",
    value: event.title,
    "aria-label": t("titleLabel"),
    maxlength: TITLE_MAX,
    autocomplete: "off",
  }) as HTMLInputElement;

  const startsAt = h("input", {
    class: "control control-short",
    type: "datetime-local",
    value: isoToLocalInput(event.startsAt),
    "aria-label": t("startsLabel"),
  }) as HTMLInputElement;

  const capacity = h("input", {
    class: "control control-short",
    type: "number",
    min: 1,
    max: 1000,
    value: event.capacity === null ? "" : String(event.capacity),
    placeholder: t("capacityPlaceholder"),
    "aria-label": t("capacityLabel"),
  }) as HTMLInputElement;

  const description = h("textarea", {
    class: "control control-area",
    rows: 2,
    placeholder: t("descriptionPlaceholder"),
    "aria-label": t("descriptionLabel"),
    maxlength: DESCRIPTION_MAX,
  }) as unknown as HTMLTextAreaElement;
  description.value = event.description ?? "";

  // Checkboxes rather than a multi-select: six options are few enough to show at
  // once, and the order they were chosen in matters — the first tracked metric is
  // the one the Discord board sorts by, which a select box gives no way to show.
  const tracked = new Set<string>(event.trackedMetrics);
  const metricBoxes = METRICS.map((metric) => {
    const box = h("input", {
      class: "switch-input",
      type: "checkbox",
      ...(tracked.has(metric) ? { checked: true } : {}),
      "aria-label": metricLabel(metric),
    }) as HTMLInputElement;
    return { metric, box };
  });

  const pollInterval = h("input", {
    class: "control control-short",
    type: "number",
    min: POLL_MIN,
    max: POLL_MAX,
    value: String(event.pollIntervalMinutes),
    "aria-label": t("pollLabel"),
  }) as HTMLInputElement;

  const progression = h("input", {
    class: "switch-input",
    type: "checkbox",
    ...(event.tracksProgression ? { checked: true } : {}),
    "aria-label": t("progressionLabel"),
  }) as HTMLInputElement;

  const save = actionButton({
    label: t("save"),
    tone: "primary",
    status,
    run: async () => {
      const name = title.value.trim();
      if (name.length === 0) return { kind: "error", message: t("errNoTitle") };

      const iso = localInputToIso(startsAt.value);
      if (iso === null) return { kind: "error", message: t("errNoStart") };
      // Only a scheduled event is held to a future start: once it is live the
      // start is in the past by definition, and the domain agrees.
      if (event.status === "SCHEDULED" && Date.parse(iso) <= Date.now()) {
        return { kind: "error", message: t("errPastStart") };
      }

      const seatsRaw = capacity.value.trim();
      const seats = seatsRaw.length === 0 ? null : Number(seatsRaw);
      if (seats !== null && (!Number.isInteger(seats) || seats < 1)) {
        return { kind: "error", message: t("errCapacity") };
      }

      const minutes = Number(pollInterval.value.trim());
      if (!Number.isInteger(minutes) || minutes < POLL_MIN || minutes > POLL_MAX) {
        return {
          kind: "error",
          message: t("errPoll").replace("{min}", count(POLL_MIN)).replace("{max}", count(POLL_MAX)),
        };
      }

      return postAction(guildId, "event.update", {
        eventId: event.id,
        title: name,
        startsAt: iso,
        capacity: seats,
        description: description.value.trim(),
        trackedMetrics: metricBoxes.filter(({ box }) => box.checked).map(({ metric }) => metric),
        pollIntervalMinutes: minutes,
        tracksProgression: progression.checked,
      });
    },
    onDone: rerender,
  });

  const publish = actionButton({
    label: t("publishBoard"),
    tone: "plain",
    status,
    run: () => postAction(guildId, "event.board.publish", { eventId: event.id }),
    onDone: rerender,
  });

  // Finishing is a person's call, not the clock's: an event whose start time has
  // passed may still be running, and the result card is written once.
  const complete = editable
    ? actionButton({
        label: t("complete"),
        tone: "primary",
        confirm: t("completeConfirm"),
        status,
        run: () => postAction(guildId, "event.complete", { eventId: event.id }),
        onDone: rerender,
      })
    : null;

  return h(
    "div",
    { class: "fields" },
    h("div", { class: "field-row" }, title),
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label field-label-inline" }, t("startsInline")),
      startsAt,
      h("label", { class: "field-label field-label-inline" }, t("capacityInline")),
      capacity,
    ),
    h("div", { class: "field-row" }, description),
    h("p", { class: "field-label" }, t("metricsLabel")),
    h(
      "div",
      { class: "field-row metric-grid" },
      ...metricBoxes.map(({ metric, box }) =>
        h("label", { class: "switch-check" }, box, h("span", {}, metricLabel(metric))),
      ),
    ),
    h("p", { class: "field-hint" }, t("metricsHint")),
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label field-label-inline" }, t("pollInline")),
      pollInterval,
      h("label", { class: "switch-check" }, progression, h("span", {}, t("progressionLabel"))),
    ),
    h("div", { class: "field-row" }, save, complete, status.el),
    h("p", { class: "field-hint" }, boardLine(event)),
    h("div", { class: "row-actions" }, publish),
  );
}

/** When the Discord board was last written, or that there is not one yet. */
function boardLine(event: PanelEvent): string {
  if (event.messageId === null || event.boardUpdatedAt === null) return t("boardNone");
  return t("boardUpdated").replace("{when}", relativeTime(event.boardUpdatedAt));
}

/** A metric's words, falling back to the stored key for one we have retired. */
function metricLabel(metric: string): string {
  const labels = t("metric") as unknown as Readonly<Record<string, string>>;
  return labels[metric] ?? metric;
}

// ─────────────────────────── the scoreboard ───────────────────────────

/**
 * One column per tracked metric, in the event's own order, so the leftmost
 * column is the one the Discord board sorts by.
 *
 * The scores are gains since the event opened rather than readings, so the `+`
 * is part of what the number means and not decoration.
 */
function scoresBody(
  event: PanelEvent,
  standings: readonly EventMetricStandings[],
  unlinked: readonly EventRsvp[],
): HTMLElement {
  // The more useful half of this card: a member missing from a leaderboard
  // because nothing can poll them looks exactly like one who did nothing.
  const warning =
    unlinked.length === 0
      ? null
      : h(
          "p",
          { class: "field-hint" },
          t("unlinkedWarning").replace("{count}", count(unlinked.length)),
          h("span", { class: "muted" }, unlinked.map((e) => e.username ?? e.discordId).join(", ")),
        );

  if (event.trackedMetrics.length === 0) {
    return h("div", {}, h("p", { class: "muted" }, t("noMetrics")), warning);
  }

  return h(
    "div",
    {},
    h(
      "div",
      { class: "roster" },
      ...standings.map((block) =>
        h(
          "section",
          { class: "roster-col" },
          h("h4", {}, metricLabel(block.metric)),
          block.entries.length === 0
            ? h("p", { class: "muted" }, c("dash"))
            : h(
                "ul",
                { class: "roster-list" },
                ...block.entries.map((entry) =>
                  h(
                    "li",
                    {},
                    entry.username ? h("span", {}, entry.username) : h("code", {}, entry.discordId),
                    h("span", { class: "muted" }, ` +${compactNumber(entry.delta)}`),
                  ),
                ),
              ),
        ),
      ),
    ),
    warning,
  );
}

// ─────────────────────────── the roster ───────────────────────────

/**
 * Four lists rather than one table with a state column: the question this card
 * answers is "how many are actually coming", and that is a count you should be
 * able to take from the top of a column without reading the rows.
 */
function rosterBody(attendance: EventAttendance): HTMLElement {
  const columns: readonly (readonly [string, readonly EventRsvp[]])[] = [
    [t("rsvpGoing"), attendance.going],
    [t("rsvpWaitlist"), attendance.waitlist],
    [t("rsvpMaybe"), attendance.maybe],
    [t("rsvpDeclined"), attendance.declined],
  ];

  if (columns.every(([, entries]) => entries.length === 0)) {
    return emptyState("eventsRsvp");
  }

  return h(
    "div",
    { class: "roster" },
    ...columns.map(([label, entries]) =>
      h(
        "section",
        { class: "roster-col" },
        h("h4", {}, t("rosterHeading").replace("{label}", label).replace("{count}", count(entries.length))),
        entries.length === 0
          ? h("p", { class: "muted" }, c("dash"))
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

// ─────────────────────────── turnout ───────────────────────────

/**
 * Turnout is a question you can only answer after the fact, so the card stays
 * away until the event has started — or until something has already been
 * recorded, which can happen on an event whose start was later corrected.
 */
function showTurnout(event: PanelEvent, attendance: EventAttendance): boolean {
  if (event.status === "CANCELLED") return false;
  return attendance.attended.length > 0 || Date.parse(event.startsAt) <= Date.now();
}

/**
 * Everyone who might have been there, each with a box.
 *
 * The candidate list is the union of the RSVPs and whoever is already recorded,
 * because attendance is not a subset of the roster: the tracker scores members
 * who never touched the buttons, and hosts mark walk-ins.
 *
 * Rows the tracker wrote are shown as fact rather than as a box. The poller
 * watched the event and the person reading this page is remembering it, so
 * offering to untick an observation would be offering a lie.
 */
function turnoutBody(guildId: string, attendance: EventAttendance, rerender: () => void): HTMLElement {
  const status = statusSlot();

  const names = new Map<string, string | null>();
  const order: string[] = [];
  const consider = (discordId: string, username: string | null): void => {
    if (names.has(discordId)) {
      if (names.get(discordId) === null) names.set(discordId, username);
      return;
    }
    names.set(discordId, username);
    order.push(discordId);
  };
  for (const entry of attendance.attended) consider(entry.discordId, entry.username);
  for (const entry of attendance.going) consider(entry.discordId, entry.username);
  for (const entry of attendance.waitlist) consider(entry.discordId, entry.username);
  for (const entry of attendance.maybe) consider(entry.discordId, entry.username);
  for (const entry of attendance.declined) consider(entry.discordId, entry.username);

  if (order.length === 0) return emptyState("eventsRsvp");

  const recorded = new Map<string, EventAttendee>(
    attendance.attended.map((entry) => [entry.discordId, entry]),
  );

  const rows = order.map((discordId) => {
    const found = recorded.get(discordId) ?? null;
    const label = names.get(discordId) ?? null;
    const who = label === null ? h("code", {}, discordId) : h("span", {}, label);

    if (found?.source === "TRACKED") {
      return {
        discordId,
        box: null,
        el: h("span", { class: "switch-check" }, badge(t("turnoutTracked"), "ok"), who),
      };
    }

    const box = h("input", {
      class: "switch-input",
      type: "checkbox",
      ...(found === null ? {} : { checked: true }),
      "aria-label": label ?? discordId,
    }) as HTMLInputElement;
    return { discordId, box, el: h("label", { class: "switch-check" }, box, who) };
  });

  const save = actionButton({
    label: t("turnoutSave"),
    tone: "primary",
    status,
    run: () =>
      postAction(guildId, "event.attendance", {
        eventId: attendance.eventId,
        // Tracked rows are not submitted: they are not this list's to keep or
        // drop, and the write leaves them alone either way.
        discordIds: rows.filter((row) => row.box?.checked === true).map((row) => row.discordId),
      }),
    onDone: rerender,
  });

  return h(
    "div",
    { class: "fields" },
    h("p", { class: "field-hint" }, t("turnoutHint")),
    h("div", { class: "field-row metric-grid" }, ...rows.map((row) => row.el)),
    h("div", { class: "field-row" }, save, status.el),
  );
}

// ─────────────────────────── history ───────────────────────────

function pastBody(events: readonly PanelEvent[], rerender: () => void): HTMLElement {
  if (events.length === 0) return emptyState("eventsHistory");
  return table(
    [t("colEvent"), t("colType"), t("colOutcome"), t("colStarted"), t("colWent"), t("colResult")],
    events.map((event) => [
      event.title,
      event.type.toLowerCase(),
      badge(event.status.toLowerCase(), statusTone(event.status)),
      dateTime(event.startsAt),
      seats(event),
      // A finished event still has a scoreboard worth reading, so its row opens
      // the same cards an upcoming one does, minus the buttons it has outgrown.
      h(
        "button",
        {
          class: "button",
          type: "button",
          "aria-expanded": state.selected === event.id ? "true" : "false",
          onclick: () => {
            state.selected = state.selected === event.id ? "" : event.id;
            rerender();
          },
        },
        state.selected === event.id ? t("hideResult") : t("showResult"),
      ),
    ]),
  );
}
