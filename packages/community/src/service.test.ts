import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventDTO, RSVPState } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { CommunityServiceImpl } from "./service.js";
import type { CommunityRepository, EventRsvpInfo } from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function repo(over: Partial<CommunityRepository> = {}): {
  repo: CommunityRepository;
  rsvps: Array<{ eventId: string; discordId: string; state: RSVPState }>;
} {
  const rsvps: Array<{ eventId: string; discordId: string; state: RSVPState }> = [];
  return {
    rsvps,
    repo: {
      async listUpcomingEvents() { return []; },
      async listMembers() { return []; },
      async listApplications() { return []; },
      async getEventForRsvp() { return null; },
      async upsertRsvp(eventId, discordId, state) { rsvps.push({ eventId, discordId, state }); },
      ...over,
    },
  };
}

function eventInfo(over: Partial<EventRsvpInfo> = {}): EventRsvpInfo {
  return { status: "SCHEDULED", capacity: null, goingCount: 0, ...over };
}

test("listUpcomingEvents passes through the repository", async () => {
  const events: EventDTO[] = [
    { id: "e1", guildId: "g1", title: "F7 carries", status: "SCHEDULED", startsAt: "t", capacity: 4, rsvpCount: 2 },
  ];
  const svc = new CommunityServiceImpl({ repo: repo({ async listUpcomingEvents() { return events; } }).repo, logger: silent });
  const r = await svc.listUpcomingEvents("g1");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value[0]?.title, "F7 carries");
});

test("GOING under capacity records GOING", async () => {
  const r = repo({ async getEventForRsvp() { return eventInfo({ capacity: 5, goingCount: 2 }); } });
  const svc = new CommunityServiceImpl({ repo: r.repo, logger: silent });
  const result = await svc.rsvp("e1", "111", "GOING");
  assert.equal(result.ok && result.value.state, "GOING");
  assert.equal(r.rsvps[0]?.state, "GOING");
});

test("GOING at capacity is downgraded to WAITLIST", async () => {
  const r = repo({ async getEventForRsvp() { return eventInfo({ capacity: 4, goingCount: 4 }); } });
  const svc = new CommunityServiceImpl({ repo: r.repo, logger: silent });
  const result = await svc.rsvp("e1", "111", "GOING");
  assert.equal(result.ok && result.value.state, "WAITLIST");
  assert.equal(r.rsvps[0]?.state, "WAITLIST");
});

test("uncapped events never waitlist", async () => {
  const r = repo({ async getEventForRsvp() { return eventInfo({ capacity: null, goingCount: 100 }); } });
  const svc = new CommunityServiceImpl({ repo: r.repo, logger: silent });
  const result = await svc.rsvp("e1", "111", "GOING");
  assert.equal(result.ok && result.value.state, "GOING");
});

test("NOT_GOING is never waitlisted even at capacity", async () => {
  const r = repo({ async getEventForRsvp() { return eventInfo({ capacity: 1, goingCount: 5 }); } });
  const svc = new CommunityServiceImpl({ repo: r.repo, logger: silent });
  const result = await svc.rsvp("e1", "111", "NOT_GOING");
  assert.equal(result.ok && result.value.state, "NOT_GOING");
});

test("rsvp to a missing event fails", async () => {
  const svc = new CommunityServiceImpl({ repo: repo().repo, logger: silent });
  const result = await svc.rsvp("nope", "111", "GOING");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "EVENT_NOT_FOUND");
});

test("rsvp to a cancelled event is closed", async () => {
  const r = repo({ async getEventForRsvp() { return eventInfo({ status: "CANCELLED" }); } });
  const svc = new CommunityServiceImpl({ repo: r.repo, logger: silent });
  const result = await svc.rsvp("e1", "111", "GOING");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "EVENT_CLOSED");
});
