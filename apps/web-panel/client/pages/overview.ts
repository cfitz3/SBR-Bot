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
import { scope } from "../copy.js";
import { h, replace } from "../dom.js";
import { compactNumber, count, dateTime, ratio, relativeTime } from "../format.js";

const t = scope("overview");
const c = scope("common");

type Tab = "membership" | "activity" | "joins";

const TABS = ["membership", "activity", "joins"] as const satisfies readonly Tab[];

/**
 * Module-level so switching tabs does not re-fetch. The whole view model arrives
 * in one response, so a tab is a change of what is shown, not of what is known.
 */
let tab: Tab = "membership";

export async function renderOverview(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("overview"));

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
        pageTitle(t("title"), t("subtitle").replace("{role}", result.access.role.toLowerCase())),
        vm.bridgeSuspended ? bridgeBanner() : null,
        card(t("cardQueue"), queueTiles(vm)),
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
    h("strong", {}, t("bannerSuspendedLead")),
    t("bannerSuspendedBody"),
  );
}

function queueTiles(vm: OverviewVM): HTMLElement {
  return h(
    "div",
    { class: "tiles" },
    statTile(t("tileOpenTickets"), count(vm.openTicketCount)),
    statTile(t("tileOpenInfractions"), count(vm.openInfractionCount)),
    statTile(t("tileActivePunishments"), count(vm.activeActionCount)),
    statTile(t("tileUpcomingEvents"), count(vm.upcomingEventCount)),
  );
}

/** The same tab markup the Members and Moderation pages use, for the same reason. */
function tabStrip(rerender: () => void): HTMLElement {
  return h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": t("tabsLabel") },
    ...TABS.map((id) =>
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
        t("tab")[id],
      ),
    ),
  );
}

function tabBody(vm: OverviewVM): readonly HTMLElement[] {
  if (tab === "activity") return [card(t("cardActivity"), activityBody(vm.activity))];
  if (tab === "joins") return [card(t("cardJoins"), joinsBody(vm.joinAttempts))];
  return [
    card(t("cardDiscord"), discordTiles(vm)),
    card(t("cardGame"), gameTiles(vm.membership)),
    card(t("cardLinks"), linkTiles(vm)),
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
      statTile(
        t("tileDiscordMembers"),
        count(m.discordMemberCount),
        t("discordMembersNote").replace("{count}", count(vm.memberCount)),
      ),
      statTile(joinedLabel(m.windowDays), count(m.discordJoins)),
      statTile(leftLabel(m.windowDays), count(m.discordLeaves)),
      statTile(t("tileLastSnapshot"), relativeTime(vm.lastSnapshotAt)),
    ),
    scanNote(t("scanDiscord"), m.scannedAt.discord, t("cadenceDiscord")),
  );
}

function gameTiles(m: MembershipStats): HTMLElement {
  return h(
    "div",
    {},
    h(
      "div",
      { class: "tiles" },
      statTile(t("tileInGuild"), count(m.guildMemberCount)),
      statTile(joinedLabel(m.windowDays), count(m.gameJoins)),
      statTile(leftLabel(m.windowDays), count(m.gameLeaves)),
    ),
    h(
      "p",
      { class: "page-note" },
      t("gameNote"),
    ),
    scanNote(t("scanGame"), m.scannedAt.hypixel, t("cadenceGame")),
  );
}

/** `Joined (7d)` / `Left (7d)` — both cards use the same two labels. */
const joinedLabel = (days: number): string => t("tileJoined").replace("{days}", String(days));
const leftLabel = (days: number): string => t("tileLeft").replace("{days}", String(days));

function linkTiles(vm: OverviewVM): HTMLElement {
  const m = vm.membership;
  return h(
    "div",
    {},
    h(
      "div",
      { class: "tiles" },
      statTile(t("tileLinkedToDiscord"), ratio(m.linkedCount, m.discordMemberCount)),
      statTile(t("tileLinkedOfGuild"), ratio(m.linkedCount, m.guildMemberCount)),
    ),
    h(
      "p",
      { class: "page-note" },
      t("linkNote"),
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
    t("scanNote").replace("{what}", what).replace("{when}", relativeTime(at)),
    at === null ? t("scanNeverRun") : t("scanCadence").replace("{cadence}", cadence),
  );
}

// ─────────────────────────── activity ───────────────────────────

const TONE: Readonly<Record<ActivityEntry["tone"], BadgeTone>> = {
  info: "neutral",
  good: "ok",
  warn: "warn",
  bad: "bad",
};

function activityBody(entries: readonly ActivityEntry[]): HTMLElement {
  if (entries.length === 0) {
    return emptyState("overviewActivity");
  }
  return h(
    "div",
    {},
    table(
      [t("colWhen"), t("colWhat"), t("colDetail")],
      entries.map((e) => [
        h("span", { title: dateTime(e.at) }, relativeTime(e.at)),
        h("div", { class: "job-cell" }, badge(t("activityKind")[e.kind], TONE[e.tone]), h("span", {}, e.title)),
        e.detail ?? c("dash"),
      ]),
    ),
    h(
      "p",
      { class: "page-note" },
      t("activityNote"),
    ),
  );
}

// ─────────────────────────── join attempts ───────────────────────────

function joinsBody(rows: readonly JoinAttempt[]): HTMLElement {
  if (rows.length === 0) {
    return emptyState("overviewJoinAttempts");
  }
  return h(
    "div",
    {},
    table(
      [t("colPlayer"), t("colScamCheck"), t("colVerdict"), t("colStats"), t("colWhen")],
      rows.map((r) => [
        person(r.ign, r.discordId === null ? r.uuid : `${r.uuid} · ${r.discordId}`),
        scamBadge(r),
        h(
          "div",
          { class: "job-cell" },
          badge(r.verdict.toLowerCase(), r.verdict === "ACCEPT" ? "ok" : r.verdict === "DENY" ? "bad" : "warn"),
          badge(r.outcome.toLowerCase()),
          h("span", { class: "muted" }, t("riskScore").replace("{score}", String(r.riskScore))),
        ),
        statLine(r),
        h("span", { title: dateTime(r.requestedAt) }, relativeTime(r.requestedAt)),
      ]),
    ),
    h(
      "p",
      { class: "page-note" },
      t("joinsNote"),
    ),
  );
}

/**
 * Three states, deliberately. `null` is not "clear" — it is the check having
 * failed to reach an answer, which is precisely when somebody should look
 * themselves rather than trust the row.
 */
function scamBadge(r: JoinAttempt): HTMLElement {
  if (r.scammer === true) return badge(r.scammerReason ?? t("scamListed"), "bad");
  if (r.scammer === false) return badge(t("scamClear"), "ok");
  return badge(t("scamUnchecked"), "warn");
}

function statLine(r: JoinAttempt): HTMLElement {
  const parts: string[] = [];
  const stat = (
    key: "statSkyblock" | "statSkillAverage" | "statCatacombs" | "statWeight" | "statNetworth",
    value: string,
  ): void => {
    parts.push(t(key).replace("{value}", value));
  };
  if (r.skyblockLevel !== null) stat("statSkyblock", String(Math.floor(r.skyblockLevel)));
  if (r.skillAverage !== null) stat("statSkillAverage", r.skillAverage.toFixed(1));
  if (r.catacombsLevel !== null) stat("statCatacombs", r.catacombsLevel.toFixed(1));
  if (r.senitherWeight !== null) stat("statWeight", compactNumber(r.senitherWeight));
  if (r.networth !== null) stat("statNetworth", compactNumber(r.networth));
  if (parts.length === 0) return h("span", { class: "muted" }, t("profileUnreadable"));
  return h("span", {}, parts.join(" · "));
}
