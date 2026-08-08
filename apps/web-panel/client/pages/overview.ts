/**
 * Guild overview (WEB_PANEL.md §3.3).
 *
 * Ordered by what a staffer does with it: what's waiting on a human first, then
 * membership, then whether the data underneath is fresh enough to trust. A
 * dashboard that leads with headline counts buries the queue that needed
 * clearing this morning.
 */
import type { FreshnessVM, OverviewVM } from "@sbr/panel-core";
import { loadPage } from "../api.js";
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
} from "../components.js";
import { h, replace } from "../dom.js";
import { count, describeSpan, humanizeJob, ratio, relativeTime } from "../format.js";

export async function renderOverview(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("Loading overview…"));

  const result = await loadPage<OverviewVM>(`/api/guilds/${encodeURIComponent(guildId)}/overview`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderOverview(host, guildId)));
  }

  const vm = result.data;
  replace(
    host,
    h(
      "div",
      {},
      pageTitle("Overview", `Signed in as ${result.access.role.toLowerCase()}`),
      vm.bridgeSuspended ? bridgeBanner() : null,
      card("Waiting on a human", queueTiles(vm)),
      card("Membership", membershipTiles(vm)),
      card("Data freshness", freshnessBody(vm)),
    ),
  );
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
    statTile("Pending applications", count(vm.pendingApplicationCount)),
    statTile("Open infractions", count(vm.openInfractionCount)),
    statTile("Active punishments", count(vm.activeActionCount)),
    statTile("Upcoming events", count(vm.upcomingEventCount)),
  );
}

function membershipTiles(vm: OverviewVM): HTMLElement {
  return h(
    "div",
    { class: "tiles" },
    statTile("Members", count(vm.memberCount), `${count(vm.activeMemberCount)} active`),
    statTile("Linked accounts", ratio(vm.linkedMemberCount, vm.memberCount)),
    statTile("Verified", ratio(vm.verifiedMemberCount, vm.memberCount)),
    statTile("Recent joins", count(vm.recentJoinCount)),
    statTile("Recent leaves", count(vm.recentLeaveCount)),
    statTile("Last profile snapshot", relativeTime(vm.lastSnapshotAt)),
  );
}

function freshnessBody(vm: OverviewVM): HTMLElement {
  if (vm.freshness.length === 0) return emptyState("No job history recorded yet.");
  return table(
    ["Job", "Last success", "Status"],
    vm.freshness.map((row) => [humanizeJob(row.job), freshnessAge(row), freshnessBadge(row)]),
  );
}

function freshnessAge(row: FreshnessVM): string {
  if (row.ageMs === null) return "never";
  return `${describeSpan(row.ageMs)} ago`;
}

/**
 * `stale` is graded server-side against per-job thresholds (PanelService's
 * STALE_AFTER_MS), so the badge only reports the decision rather than making it
 * — the browser's clock never gets a vote.
 */
function freshnessBadge(row: FreshnessVM): HTMLElement {
  if (row.lastSuccessAt === null) return badge("never run", "bad");
  return row.stale ? badge("stale", "warn") : badge("fresh", "ok");
}
