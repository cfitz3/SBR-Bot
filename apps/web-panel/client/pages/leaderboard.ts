/**
 * Leaderboard — the guild's standings, as a table.
 *
 * This page used to be `/leaderboard` in a browser: one category at a time,
 * ten rows a page, a request per click. That is the right shape for a chat
 * command answering "who is top on Catacombs" and the wrong one for the
 * question staff actually open the panel with — *how is the guild doing* —
 * which is comparative, and comparison needs the columns side by side.
 *
 * So: two tabs, every column on each, and the whole roster on one screen.
 *
 * Three rules the rendering keeps:
 *
 * - **A click is not a request.** Sorting, reversing and filtering happen here,
 *   against the payload already loaded. Only switching tab or window costs a
 *   round trip, and even then the table is left on screen with the controls
 *   disabled rather than blanked to a spinner — a page that flashes empty on
 *   every interaction reads as broken even when it is fast.
 * - **A rank is shown in proportion.** "3rd of 42" is a fact; a bare "3rd" on a
 *   board of four reads like an achievement and is not one.
 * - **Unranked is not zero.** A member with no networth reading has no wealth
 *   cell and sorts to the bottom whichever way the column is read. Printing a
 *   zero there would be a claim about their coins rather than about our data.
 */
import type { LeaderboardBoardVM } from "@sbr/panel-core";
import type {
  LeaderboardBoardColumnDTO,
  LeaderboardBoardRowDTO,
  LeaderboardValueFormat,
} from "@sbr/shared-types";
import { loadPage } from "../api.js";
import { badge, card, deniedState, emptyState, errorState, pageTitle, spinner } from "../components.js";
import { scope } from "../copy.js";
import { compactNumber, count, relativeTime } from "../format.js";
import { h, replace } from "../dom.js";

const t = scope("leaderboard");
const c = scope("common");

/**
 * The windows offered, in days. Fixed rather than free-entry: the service
 * clamps anything between 1 and 365 anyway, and a text box inviting "37" would
 * produce boards nobody can compare with anybody else's.
 */
const WINDOWS: readonly (readonly [number, () => string])[] = [
  [7, () => t("window7")],
  [30, () => t("window30")],
  [90, () => t("window90")],
  [365, () => t("window365")],
];

/** What the reader is looking at. Query state, not data — never persisted. */
interface View {
  readonly tab: string;
  readonly windowDays: number;
}

/** How the reader has arranged it. Never leaves the browser. */
interface Arrangement {
  /** A category id, or `name` for the member column. */
  readonly sort: string;
  readonly descending: boolean;
  readonly filter: string;
}

const FIRST: View = { tab: "stats", windowDays: 30 };
const UNSORTED: Arrangement = { sort: "", descending: false, filter: "" };

export async function renderLeaderboard(host: HTMLElement, guildId: string): Promise<void> {
  await show(host, guildId, FIRST, UNSORTED);
}

async function show(
  host: HTMLElement,
  guildId: string,
  view: View,
  arrangement: Arrangement,
): Promise<void> {
  replace(host, spinner("leaderboard"));

  const query = new URLSearchParams({ tab: view.tab, window: String(view.windowDays) });
  const result = await loadPage<LeaderboardBoardVM>(
    `/api/guilds/${encodeURIComponent(guildId)}/leaderboard-board?${query.toString()}`,
  );
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void show(host, guildId, view, arrangement)));
  }

  const { installed, tabs, board } = result.data;
  if (!installed || board === null) {
    return replace(
      host,
      h("div", {}, pageTitle(t("title"), t("notEnabled")), emptyState("leaderboardUninstalled")),
    );
  }

  // Everything below re-renders from this one payload. `state` is what a click
  // changes; `paint` is the only thing that touches the DOM.
  let state = arrangement;
  const body = h("div", {});

  const paint = (): void => {
    replace(body, boardBody(board, state, (next) => {
      state = { ...state, ...next };
      paint();
    }));
  };
  paint();

  const windowed = board.columns.some((column) => column.windowed);
  replace(
    host,
    h(
      "div",
      {},
      pageTitle(t("title"), t("subtitleRoster").replace("{n}", count(board.rows.length))),
      h(
        "div",
        { class: "tabs tab-strip", role: "tablist" },
        ...tabs.map((tab) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              class: "tab",
              "aria-selected": tab.id === board.tab ? "true" : "false",
              // The filter survives a tab switch and the sort does not: a
              // staffer looking up one member wants to keep looking at them,
              // and a sort by Catacombs means nothing on the Activity tab.
              onclick: () =>
                void show(host, guildId, { ...view, tab: tab.id }, { ...UNSORTED, filter: state.filter }),
            },
            tab.label,
          ),
        ),
      ),
      card(
        t("title"),
        body,
        windowed
          ? windowPicker(view, (days) => void show(host, guildId, { ...view, windowDays: days }, state))
          : null,
      ),
    ),
  );
}

function windowPicker(view: View, go: (days: number) => void): HTMLElement {
  const select = h(
    "select",
    {
      class: "control control-select",
      "aria-label": t("windowLabel"),
      onchange: (event: Event) => {
        const value = Number((event.target as HTMLSelectElement).value);
        if (Number.isFinite(value)) go(value);
      },
    },
    ...WINDOWS.map(([days, label]) =>
      h("option", { value: String(days), selected: days === view.windowDays }, label()),
    ),
  );
  return h("div", { class: "card-action" }, select);
}

function boardBody(
  board: NonNullable<LeaderboardBoardVM["board"]>,
  state: Arrangement,
  set: (next: Partial<Arrangement>) => void,
): HTMLElement {
  const rows = arrange(board.rows, board.columns, state);

  return h(
    "div",
    {},
    filterBox(state, set),
    board.columns.some((column) => column.windowed)
      ? h("p", { class: "muted" }, t("windowHint"))
      : null,
    rows.length === 0
      ? emptyState("leaderboardBoard")
      : boardTable(board.columns, rows, state, set),
    h(
      "p",
      { class: "muted" },
      board.oldestReadingAt === null
        ? t("stalenessLive")
        : t("staleness").replace("{when}", relativeTime(board.oldestReadingAt)),
    ),
  );
}

function filterBox(state: Arrangement, set: (next: Partial<Arrangement>) => void): HTMLElement {
  return h(
    "div",
    { class: "toolbar" },
    h("input", {
      type: "search",
      class: "control",
      placeholder: t("filterPlaceholder"),
      "aria-label": t("filterPlaceholder"),
      value: state.filter,
      // On input rather than on submit: the whole roster is already here, so
      // filtering is a redraw and waiting for Enter would be a delay we chose.
      oninput: (event: Event) => set({ filter: (event.target as HTMLInputElement).value }),
    }),
    state.filter === ""
      ? null
      : h("button", { type: "button", class: "button", onclick: () => set({ filter: "" }) }, t("clearFilter")),
  );
}

/**
 * The table, with every column head a sort control.
 *
 * A first click sorts a metric column highest-first, because that is what a
 * leaderboard means; the member column goes A–Z first for the same reason. A
 * second click reverses it, which is how "who is bottom" gets asked.
 */
function boardTable(
  columns: readonly LeaderboardBoardColumnDTO[],
  rows: readonly LeaderboardBoardRowDTO[],
  state: Arrangement,
  set: (next: Partial<Arrangement>) => void,
): HTMLElement {
  const head = (key: string, label: string, numeric: boolean): HTMLElement =>
    h(
      "th",
      {
        scope: "col",
        ...(numeric ? { class: "num" } : {}),
        "aria-sort": state.sort !== key ? "none" : state.descending ? "descending" : "ascending",
      },
      h(
        "button",
        {
          type: "button",
          class: "table-sort",
          onclick: () =>
            set(
              state.sort === key
                ? { descending: !state.descending }
                : { sort: key, descending: numeric },
            ),
        },
        state.sort === key ? `${label} ${state.descending ? t("sortDescending") : t("sortAscending")}` : label,
      ),
    );

  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          head("name", t("colMember"), false),
          h("th", { scope: "col" }, t("colGuildRank")),
          ...columns.map((column) => head(column.category, column.label, true)),
        ),
      ),
      h(
        "tbody",
        {},
        ...rows.map((row) =>
          h(
            "tr",
            {},
            h(
              "td",
              {},
              row.isViewer
                ? h("span", { class: "person" }, h("span", {}, row.name), badge(t("you"), "ok"))
                : row.name,
            ),
            h("td", {}, row.guildRank ?? c("dash")),
            ...columns.map((column) => cell(row, column)),
          ),
        ),
      ),
    ),
  );
}

/** One member's number in one column, with its rank in proportion under it. */
function cell(row: LeaderboardBoardRowDTO, column: LeaderboardBoardColumnDTO): HTMLElement {
  const found = row.cells[column.category];
  if (found === undefined) return h("td", { class: "num" }, c("dash"));
  return h(
    "td",
    { class: "num" },
    h("span", {}, formatValue(found.value, column.format)),
    h("span", { class: "muted cell-rank" }, `#${String(found.rank)} / ${count(column.ranked)}`),
  );
}

/**
 * Filter, then sort. Both in the browser, against rows already in hand.
 *
 * The filter matches the name and the guild rank, which is what somebody types
 * — a member's IGN, or "Guild Master" to see the officers together.
 */
function arrange(
  rows: readonly LeaderboardBoardRowDTO[],
  columns: readonly LeaderboardBoardColumnDTO[],
  state: Arrangement,
): readonly LeaderboardBoardRowDTO[] {
  const needle = state.filter.trim().toLowerCase();
  const kept =
    needle === ""
      ? [...rows]
      : rows.filter((row) =>
          [row.name, row.guildRank].some((field) => (field ?? "").toLowerCase().includes(needle)),
        );

  if (state.sort === "") return kept;

  if (state.sort === "name") {
    kept.sort((a, b) => a.name.localeCompare(b.name));
    if (state.descending) kept.reverse();
    return kept;
  }

  const known = columns.some((column) => column.category === state.sort);
  if (!known) return kept;

  kept.sort((a, b) => {
    const left = a.cells[state.sort]?.value;
    const right = b.cells[state.sort]?.value;
    // Unranked sinks either way: it is missing data, not a low score, and a
    // reverse sort that floated it to the top would say the opposite.
    if (left === undefined && right === undefined) return a.name.localeCompare(b.name);
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return state.descending ? right - left : left - right;
  });
  return kept;
}

/**
 * A ranked value in its own units.
 *
 * Coins are compacted because a networth column is otherwise twelve digits
 * nobody reads; everything else is exact, because a level or a message count is
 * already short and rounding it would lose the comparison.
 */
function formatValue(value: number, format: LeaderboardValueFormat): string {
  switch (format) {
    case "coins":
      return compactNumber(value);
    case "level":
      return value.toFixed(value % 1 === 0 ? 0 : 1);
    case "days":
      return `${count(value)}d`;
    case "count":
      return count(value);
  }
}
