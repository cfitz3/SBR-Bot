/**
 * Leaderboard — the guild's standings, as a page.
 *
 * The same service `/leaderboard` reads, ranked by the same code, so a member
 * cannot be 3rd in Discord and 4th here. What the page adds is what an embed
 * cannot do: switch category without re-running a command, walk the pages, and
 * change the window on the boards that have one.
 *
 * Read-only. There is no action anywhere on this page, which is why it is the
 * one page that sits at MEMBER in `PAGE_TIERS` — see the note there about what
 * that tier does and does not currently buy.
 *
 * Two rules the rendering keeps:
 *
 * - A rank is always shown in proportion. "3rd of 42" is a fact; a bare "3rd"
 *   on a board of four reads like an achievement and is not one.
 * - The reader's own row is pinned when it falls off the shown page, rather
 *   than being paged to. Somebody who is 137th should not have to find that
 *   out by clicking through fourteen pages.
 */
import type { LeaderboardVM } from "@sbr/panel-core";
import type { LeaderboardEntryDTO, LeaderboardValueFormat } from "@sbr/shared-types";
import { loadPage } from "../api.js";
import { badge, card, deniedState, emptyState, errorState, pageTitle, spinner, table } from "../components.js";
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
  readonly category: string;
  readonly page: number;
  readonly windowDays: number;
}

const FIRST: View = { category: "", page: 1, windowDays: 30 };

export async function renderLeaderboard(host: HTMLElement, guildId: string): Promise<void> {
  await show(host, guildId, FIRST);
}

async function show(host: HTMLElement, guildId: string, view: View): Promise<void> {
  replace(host, spinner("leaderboard"));

  const query = new URLSearchParams({ page: String(view.page), window: String(view.windowDays) });
  if (view.category !== "") query.set("category", view.category);

  const result = await loadPage<LeaderboardVM>(
    `/api/guilds/${encodeURIComponent(guildId)}/leaderboard?${query.toString()}`,
  );
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void show(host, guildId, view)));
  }

  const go = (next: Partial<View>): void => void show(host, guildId, { ...view, ...next });
  const { installed, tabs, page } = result.data;

  if (!installed || page === null) {
    return replace(
      host,
      h("div", {}, pageTitle(t("title"), t("notEnabled")), emptyState("leaderboardUninstalled")),
    );
  }

  // The board's own idea of which category it is, not the one asked for: an
  // unknown category falls back server-side, and the tab strip must show what
  // is actually on screen.
  const active = page.category;

  replace(
    host,
    h(
      "div",
      {},
      pageTitle(t("title"), t("subtitleRanked").replace("{n}", count(page.totalRanked))),
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
              "aria-selected": tab.id === active ? "true" : "false",
              // Back to page one: page four of Catacombs has nothing to do with
              // page four of Wealth, and keeping the number would land the
              // reader somewhere arbitrary in a board they just opened.
              onclick: () => go({ category: tab.id, page: 1 }),
            },
            tab.label,
          ),
        ),
      ),
      card(page.spec.label, boardBody(page, go), page.spec.windowed ? windowPicker(view, go) : null),
    ),
  );
}

function windowPicker(view: View, go: (next: Partial<View>) => void): HTMLElement {
  const select = h(
    "select",
    {
      class: "control control-select",
      "aria-label": t("windowLabel"),
      onchange: (event: Event) => {
        const value = Number((event.target as HTMLSelectElement).value);
        if (Number.isFinite(value)) go({ windowDays: value, page: 1 });
      },
    },
    ...WINDOWS.map(([days, label]) =>
      h("option", { value: String(days), selected: days === view.windowDays }, label()),
    ),
  );
  return h("div", { class: "card-action" }, select);
}

function boardBody(page: NonNullable<LeaderboardVM["page"]>, go: (next: Partial<View>) => void): HTMLElement {
  if (page.entries.length === 0) return emptyState("leaderboardBoard");

  const format = page.spec.format;
  const rows = page.entries.map((entry) => row(entry, format, page.totalRanked));

  return h(
    "div",
    {},
    page.spec.windowed ? h("p", { class: "muted" }, t("windowHint")) : null,
    // Pinned above the table rather than inside it: it is a different fact from
    // "here are rows 1–10", and splicing it in would put a 137 between a 9 and
    // a 10 with no explanation.
    page.viewer === null
      ? null
      : h(
          "div",
          { class: "pinned-row" },
          h("span", { class: "muted" }, t("yourRow")),
          h("span", {}, `#${String(page.viewer.rank)} ${c("dot")} ${page.viewer.label}`),
          h("span", {}, formatValue(page.viewer.value, format)),
        ),
    table([t("colRank"), t("colMember"), { label: t("colValue"), align: "num" }, t("colReading")], rows),
    pager(page, go),
    h(
      "p",
      { class: "muted" },
      page.oldestReadingAt === null
        ? t("stalenessLive")
        : t("staleness").replace("{when}", relativeTime(page.oldestReadingAt)),
    ),
  );
}

function row(
  entry: LeaderboardEntryDTO,
  format: LeaderboardValueFormat,
  totalRanked: number,
): readonly (string | HTMLElement)[] {
  return [
    // In proportion, always: see the header note.
    `${String(entry.rank)} / ${count(totalRanked)}`,
    entry.isViewer
      ? h("span", { class: "person" }, h("span", {}, entry.label), badge(t("you"), "ok"))
      : entry.label,
    formatValue(entry.value, format),
    // Null for the categories derived at read time — tenure, activity, XP —
    // where there is no "reading" to be stale.
    entry.at === null ? c("dash") : relativeTime(entry.at),
  ];
}

function pager(page: NonNullable<LeaderboardVM["page"]>, go: (next: Partial<View>) => void): HTMLElement | null {
  if (page.pageCount <= 1) return null;
  const button = (label: string, target: number, disabled: boolean): HTMLElement =>
    h(
      "button",
      {
        type: "button",
        class: "button",
        ...(disabled ? { disabled: true } : {}),
        onclick: () => go({ page: target }),
      },
      label,
    );

  return h(
    "div",
    { class: "pager" },
    button(t("prev"), page.page - 1, page.page <= 1),
    h(
      "span",
      { class: "muted" },
      t("pageStatus").replace("{page}", String(page.page)).replace("{total}", String(page.pageCount)),
    ),
    button(t("next"), page.page + 1, page.page >= page.pageCount),
  );
}

/**
 * A ranked value in its own units.
 *
 * Coins are compacted because a networth board is otherwise a column of twelve
 * digits nobody reads; everything else is exact, because a level or a message
 * count is already short and rounding it would lose the comparison.
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
