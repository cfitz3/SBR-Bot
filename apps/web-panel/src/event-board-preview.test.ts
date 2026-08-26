/**
 * The preview's contract is narrow: it must render the *same* embed the bridge
 * will post, from rows the viewer is already allowed to see. So the tests worth
 * having are the ones that catch it drifting into something else — a denied
 * read leaking standings, a missing event throwing, and the mapping quietly
 * dropping the prize or the unlinked list that the board is supposed to carry.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { EventsVM, PageResult, PanelEvent } from "@sbr/panel-core";

import { boardPreview } from "./event-board-preview.js";

const START = "2026-08-26T18:00:00.000Z";
const END = "2026-08-27T18:00:00.000Z";
const NOW = new Date("2026-08-26T20:00:00.000Z");

function event(patch: Partial<PanelEvent> = {}): PanelEvent {
  return {
    id: "evt-1",
    title: "Catacombs push",
    description: null,
    type: "DUNGEON",
    status: "LIVE",
    startsAt: START,
    endsAt: END,
    capacity: null,
    hostDiscordId: null,
    going: 4,
    maybe: 0,
    declined: 0,
    trackedMetrics: ["catacombsLevel"],
    pollIntervalMinutes: 60,
    tracksProgression: true,
    prize: "500k coins",
    channelId: "chan-1",
    messageId: null,
    boardUpdatedAt: null,
    ...patch,
  };
}

function allowed(vm: EventsVM): PageResult<EventsVM> {
  return { access: { allowed: true, level: "OFFICER" } as never, data: vm };
}

function vm(patch: Partial<EventsVM> = {}): EventsVM {
  return {
    events: [event()],
    selected: "evt-1",
    attendance: null,
    standings: [
      {
        metric: "catacombsLevel",
        entries: [
          { discordId: "1", username: "Ash", delta: 2.5 },
          { discordId: "2", username: null, delta: 1 },
        ],
      },
    ],
    unlinked: [{ discordId: "9", username: "Robin", state: "GOING", respondedAt: START }],
    ...patch,
  };
}

test("a denied read yields no preview at all", () => {
  const denied: PageResult<EventsVM> = {
    access: { allowed: false, reason: "NOT_STAFF" } as never,
    data: null,
  };
  const result = boardPreview(denied, NOW);
  assert.equal(result.data, null);
});

test("nothing open is an empty preview, not a failure", () => {
  const result = boardPreview(allowed(vm({ selected: "" })), NOW);
  assert.deepEqual(result.data, { embed: null });
});

test("an event that vanished between reads is an empty preview", () => {
  const result = boardPreview(allowed(vm({ selected: "gone" })), NOW);
  assert.deepEqual(result.data, { embed: null });
});

test("the preview carries the prize, the standings and the unlinked", () => {
  const embed = boardPreview(allowed(vm()), NOW).data?.embed;
  assert.ok(embed);
  const text = JSON.stringify(embed);
  assert.match(text, /500k coins/);
  // The board names people by mention; the preview shows exactly that, because
  // a preview that prettified them would not be a preview of the post.
  assert.match(text, /<@1>/);
  assert.match(text, /9/);
  assert.match(text, /catacombs/i);
});

test("the stamp is the moment of the preview, not the last redraw", () => {
  const embed = boardPreview(allowed(vm({ events: [event({ boardUpdatedAt: START })] })), NOW).data?.embed;
  assert.ok(embed);
  // Discord timestamp tags are seconds since the epoch, so this is the one
  // number that says which clock the footer was drawn from.
  assert.match(JSON.stringify(embed), new RegExp(String(Math.floor(NOW.getTime() / 1000))));
});

test("an unknown status is previewed as scheduled rather than throwing", () => {
  const embed = boardPreview(allowed(vm({ events: [event({ status: "DRAFT" })] })), NOW).data?.embed;
  assert.ok(embed);
  assert.match(JSON.stringify(embed), /Starts/);
});
