/**
 * Guild overview.
 *
 * Ordered by what a staffer does with it: what's waiting on a human first, then
 * three tabs over the things that are worth reading but not worth reading every
 * time — membership, the activity log, and who has been asking to join. A
 * dashboard that stacks all four as cards buries the queue that needed clearing
 * this morning under a screen of history.
 *
 * Job freshness used to sit at the bottom. It moved out entirely — it answers a
 * question about the platform, not about the guild, and the Health page already
 * answers it in more detail than a three-row strip could.
 *
 * Two rules this page holds to, because both are easy to break by accident:
 * membership is reported as **two rosters**, never blended, since the Discord
 * server and the in-game guild are different populations; and the scam check
 * keeps its **three** states, since collapsing "we could not find out" into
 * "clear" is how an outage reads as an all-clear.
 */
import type { ActivityEntry, JoinAttempt, MembershipStats, OverviewVM } from "@sbr/panel-core";
import { loadPage } from "../api.js";
import {
  badge,
  card,
  deniedState,
  emptyState,
  errorState,
  pageTitle,
  person,
  spinner,
  statTile,
  table,
  type BadgeTone,
} from "../components.js";
import { h, replace } from "../dom.js";
import { compactNumber, count, dateTime, ratio, relativeTime } from "../format.js";

type Tab = "membership" | "activity" | "joins";

const TABS: readonly (readonly [Tab, string])[] = [
  ["membership", "Membership"],
  ["activity", "Activity log"],
  ["joins", "Join attempts"],
];

/**
 * Module-level so switching tabs does not re-fetch. The whole view model arrives
 * in one response, so a tab is a change of what is shown, not of what is known.
 */
let tab: Tab = "membership";

export async function renderOverview(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading overview…"));

  const result = await loadPage<OverviewVM>(`/api/guilds/${encodeURIComponent(guildId)}/overview`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderOverview(host, guildId)));
  }

  const vm = result.data;
  const draw = (): void => {
    replace(
      host,
      h(
        "div",
        {},
        pageTitle("Overview", `Signed in as ${result.access.role.toLowerCase()}`),
        vm.bridgeSuspended ? bridgeBanner() : null,
        card("Waiting on a human", queueTiles(vm)),
        tabStrip(draw),
        ...tabBody(vm),
      ),
    );
  };
  draw();
}

/**
 * The kill switch is the one piece of state that silently changes what the rest
 * of the platform is doing, so it gets a banner rather than a tile.
 */
function bridgeBanner(): HTMLElement {
  return h(
    "div",
    { class: "banner banner-warn", role: "status" },
    h("strong", {}, "Bridge suspended. "),
    "Guild chat is not being relayed in either direction.",
  );
}

function queueTiles(vm: OverviewVM): HTMLElement {
  return h(
    "div",
    { class: "tiles" },
    statTile("Open tickets", count(vm.openTicketCount)),
    statTile("Open infractions", count(vm.openInfractionCount)),
    statTile("Active punishments", count(vm.activeActionCount)),
    statTile("Upcoming events", count(vm.upcomingEventCount)),
  );
}

/** The same tab markup the Members and Moderation pages use, for the same reason. */
function tabStrip(rerender: () => void): HTMLElement {
  return h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "Overview sections" },
    ...TABS.map(([id, label]) =>
      h(
        "button",
        {
          type: "button",
          class: "tab",
          role: "tab",
          "aria-selected": tab === id ? "true" : "false",
          onclick: () => {
            tab = id;
            rerender();
          },
        },
        label,
      ),
    ),
  );
}

function tabBody(vm: OverviewVM): readonly HTMLElement[] {
  if (tab === "activity") return [card("Activity log", activityBody(vm.activity))];
  if (tab === "joins") return [card("Recent join attempts", joinsBody(vm.joinAttempts))];
  return [
    card("Discord server", discordTiles(vm)),
    card("In-game guild", gameTiles(vm.membership)),
    card("Linked accounts", linkTiles(vm)),
  ];
}

// ─────────────────────────── membership ───────────────────────────

/**
 * Joins and leaves are two rows on two cards rather than one net figure. A guild
 * that gained six and lost five is not the same guild as one that gained one,
 * and the net number is the one that hides a retention problem.
 */
function discordTiles(vm: OverviewVM): HTMLElement {
  const m = vm.membership;
  return h(
    "div",
    {},
    h(
      "div",
      { class: "tiles" },
      statTile("Members", count(m.discordMemberCount), `${count(vm.memberCount)} rows including those who left`),
      statTile(`Joined (${m.windowDays}d)`, count(m.discordJoins)),
      statTile(`Left (${m.windowDays}d)`, count(m.discordLeaves)),
      statTile("Last profile snapshot", relativeTime(vm.lastSnapshotAt)),
    ),
    scanNote("Discord roster", m.scannedAt.discord, "every 2 hours"),
  );
}

function gameTiles(m: MembershipStats): HTMLElement {
  return h(
    "div",
    {},
    h(
      "div",
      { class: "tiles" },
      statTile("In guild", count(m.guildMemberCount)),
      statTile(`Joined (${m.windowDays}d)`, count(m.gameJoins)),
      statTile(`Left (${m.windowDays}d)`, count(m.gameLeaves)),
    ),
    h(
      "p",
      { class: "page-note" },
      "Movement here is counted from the guild scans themselves, so somebody who joined and left inside the window shows in both figures rather than cancelling out.",
    ),
    scanNote("Guild roster", m.scannedAt.hypixel, "every 6 hours"),
  );
}

function linkTiles(vm: OverviewVM): HTMLElement {
  const m = vm.membership;
  return h(
    "div",
    {},
    h(
      "div",
      { class: "tiles" },
      statTile("Linked to Discord", ratio(m.linkedCount, m.discordMemberCount)),
      statTile("Linked of the guild", ratio(m.linkedCount, m.guildMemberCount)),
    ),
    h(
      "p",
      { class: "page-note" },
      "A link is verified or it does not exist — there is no waiting state. Members shows exactly who is on each side.",
    ),
  );
}

/**
 * A roster is only as true as its last scan, so the clock is shown rather than
 * implied. "never" is a real answer here: it means the job has not run yet, and
 * the counts above it are whatever the last write happened to leave.
 */
function scanNote(what: string, at: string | null, cadence: string): HTMLElement {
  return h(
    "p",
    { class: "page-note" },
    `${what} last updated ${relativeTime(at)}`,
    at === null ? " — this scan has not run yet, so the counts above may be from an older write." : ` · runs ${cadence}.`,
  );
}

// ─────────────────────────── activity ───────────────────────────

const KIND_LABEL: Readonly<Record<ActivityEntry["kind"], string>> = {
  MODERATION: "Moderation",
  SCREENING: "Join",
  MILESTONE: "Milestone",
  EVENT: "Event",
  ROSTER: "Roster",
};

const TONE: Readonly<Record<ActivityEntry["tone"], BadgeTone>> = {
  info: "neutral",
  good: "ok",
  warn: "warn",
  bad: "bad",
};

function activityBody(entries: readonly ActivityEntry[]): HTMLElement {
  if (entries.length === 0) {
    return emptyState("Nothing has happened in this guild yet — no moderation, joins, milestones or events on record.");
  }
  return h(
    "div",
    {},
    table(
      ["When", "What", "Detail"],
      entries.map((e) => [
        h("span", { title: dateTime(e.at) }, relativeTime(e.at)),
        h("div", { class: "job-cell" }, badge(KIND_LABEL[e.kind], TONE[e.tone]), h("span", {}, e.title)),
        e.detail ?? "—",
      ]),
    ),
    h(
      "p",
      { class: "page-note" },
      "The newest of each kind, interleaved. Configuration changes are not here — they are in the audit trail, which records who changed what rather than what the platform did on its own.",
    ),
  );
}

// ─────────────────────────── join attempts ───────────────────────────

function joinsBody(rows: readonly JoinAttempt[]): HTMLElement {
  if (rows.length === 0) {
    return emptyState("No join attempts have been screened yet.");
  }
  return h(
    "div",
    {},
    table(
      ["Player", "Scam check", "Verdict", "Stats", "When"],
      rows.map((r) => [
        person(r.ign, r.discordId === null ? r.uuid : `${r.uuid} · ${r.discordId}`),
        scamBadge(r),
        h(
          "div",
          { class: "job-cell" },
          badge(r.verdict.toLowerCase(), r.verdict === "ACCEPT" ? "ok" : r.verdict === "DENY" ? "bad" : "warn"),
          badge(r.outcome.toLowerCase()),
          h("span", { class: "muted" }, `risk ${r.riskScore}`),
        ),
        statLine(r),
        h("span", { title: dateTime(r.requestedAt) }, relativeTime(r.requestedAt)),
      ]),
    ),
    h(
      "p",
      { class: "page-note" },
      "Stats are what the player's profile said at the moment they asked, not what it says now — and a dash means their API was unreadable, not that the number is zero. Nothing here is a membership gate any more: the scam check is the only bar.",
    ),
  );
}

/**
 * Three states, deliberately. `null` is not "clear" — it is the check having
 * failed to reach an answer, which is precisely when somebody should look
 * themselves rather than trust the row.
 */
function scamBadge(r: JoinAttempt): HTMLElement {
  if (r.scammer === true) return badge(r.scammerReason ?? "listed", "bad");
  if (r.scammer === false) return badge("clear", "ok");
  return badge("not checked", "warn");
}

function statLine(r: JoinAttempt): HTMLElement {
  const parts: string[] = [];
  if (r.skyblockLevel !== null) parts.push(`sb ${Math.floor(r.skyblockLevel)}`);
  if (r.skillAverage !== null) parts.push(`sa ${r.skillAverage.toFixed(1)}`);
  if (r.catacombsLevel !== null) parts.push(`cata ${r.catacombsLevel.toFixed(1)}`);
  if (r.senitherWeight !== null) parts.push(`weight ${compactNumber(r.senitherWeight)}`);
  if (r.networth !== null) parts.push(`nw ${compactNumber(r.networth)}`);
  if (parts.length === 0) return h("span", { class: "muted" }, "profile unreadable");
  return h("span", {}, parts.join(" · "));
}
