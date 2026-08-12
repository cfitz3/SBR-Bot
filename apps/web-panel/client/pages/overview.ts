/**
 * Guild overview.
 *
 * Ordered by what a staffer does with it: what's waiting on a human first, then
 * membership, then what the platform has been doing. A dashboard that leads with
 * headline counts buries the queue that needed clearing this morning.
 *
 * Job freshness used to sit at the bottom. It moved out entirely — it answers a
 * question about the platform, not about the guild, and the Health page already
 * answers it in more detail than a three-row strip could.
 */
import type { OverviewVM } from "@sbr/panel-core";
import { loadPage } from "../api.js";
import { card, deniedState, emptyState, errorState, pageTitle, spinner, statTile } from "../components.js";
import { h, replace } from "../dom.js";
import { count, ratio, relativeTime } from "../format.js";

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
      card("Activity log", logBody()),
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

/**
 * Placeholder for the activity log.
 *
 * Deliberately a stub: the feed is meant to be a merged, guild-scoped stream of
 * what the platform did — joins and leaves, moderation actions, config changes,
 * ticket movement — and no read exists for that yet. Those events are recorded
 * across several tables with no common shape or cursor, so the feed needs a
 * server-side read designed for it rather than a client that fans out and
 * interleaves by hand. The card is here so the layout it lands in is settled,
 * and so the gap is visible rather than merely absent.
 */
function logBody(): HTMLElement {
  return emptyState("The activity feed isn't wired up yet. It will show recent platform events for this guild.");
}
