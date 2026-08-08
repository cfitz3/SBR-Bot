import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplicationDTO, EventDTO, LFGPostDTO, MemberSummaryDTO, RSVPState, TicketDTO } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { CommunityServiceImpl } from "./service.js";
import type { CommunityRepository, EventRsvpInfo } from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function anEvent(over: Partial<EventDTO> = {}): EventDTO {
  return {
    id: "e1", guildId: "g1", title: "F7 carries", status: "SCHEDULED",
    startsAt: "2026-09-01T18:00:00.000Z", capacity: null, rsvpCount: 0,
    description: null, type: "DUNGEON", endsAt: null, hostDiscordId: "111",
    ...over,
  };
}

function aPost(over: Partial<LFGPostDTO> = {}): LFGPostDTO {
  return {
    id: "p1", guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", details: null,
    slotsTotal: 5, slotsFilled: 1, status: "OPEN", expiresAt: null,
    createdAt: "2026-08-01T00:00:00.000Z", members: ["111"],
    ...over,
  };
}

function aTicket(over: Partial<TicketDTO> = {}): TicketDTO {
  return {
    id: "t1", guildId: "g1", openerDiscordId: "111", assigneeDiscordId: null, category: "SUPPORT",
    status: "OPEN", subject: null, closeReason: null, createdAt: "2026-08-01T00:00:00.000Z", closedAt: null,
    ...over,
  };
}

function anApplication(over: Partial<ApplicationDTO> = {}): ApplicationDTO {
  return {
    id: "a1", guildId: "g1", applicantDiscordId: "222", status: "SUBMITTED",
    submittedAt: "2026-08-01T00:00:00.000Z", reviewerDiscordId: null, decisionReason: null, decidedAt: null,
    ...over,
  };
}

interface Fake {
  repo: CommunityRepository;
  rsvps: Array<{ eventId: string; discordId: string; state: RSVPState }>;
  /** Last roster written by setLfgMembers, so slot arithmetic can be asserted. */
  rosters: Array<{ postId: string; members: readonly string[]; status: string }>;
}

function repo(over: Partial<CommunityRepository> = {}): Fake {
  const rsvps: Fake["rsvps"] = [];
  const rosters: Fake["rosters"] = [];
  return {
    rsvps,
    rosters,
    repo: {
      async listUpcomingEvents() { return []; },
      async listMembers() { return []; },
      async listApplications() { return []; },
      async setMemberRole() { return null; },
      async getEventForRsvp() { return null; },
      async upsertRsvp(eventId, discordId, state) { rsvps.push({ eventId, discordId, state }); },
      async createEvent(input) { return anEvent({ ...input, id: "new", capacity: input.capacity ?? null }); },
      async getEvent() { return anEvent(); },
      async setEventStatus(_id, status) { return anEvent({ status }); },
      async getAttendance() { return null; },
      async createLfg(input) { return aPost({ ...input, details: input.details ?? null }); },
      async getLfg() { return null; },
      async listLfg() { return []; },
      async setLfgMembers(postId, members, status) {
        rosters.push({ postId, members, status });
        return aPost({ members: [...members], slotsFilled: members.length, status });
      },
      async createTicket(input) { return aTicket({ ...input, subject: input.subject ?? null }); },
      async getTicket() { return null; },
      async closeTicket() { return aTicket({ status: "CLOSED" }); },
      async listTickets() { return []; },
      async getApplication() { return null; },
      async decideApplication(_id, status, reviewer, reason) {
        return anApplication({ status, reviewerDiscordId: reviewer, decisionReason: reason });
      },
      ...over,
    },
  };
}

function eventInfo(over: Partial<EventRsvpInfo> = {}): EventRsvpInfo {
  return { status: "SCHEDULED", capacity: null, goingCount: 0, ...over };
}

/** Pinned well before the fixture event times so `createEvent` sees them as future. */
const NOW = (): Date => new Date("2026-08-01T00:00:00.000Z");

function svcOf(fake: Fake): CommunityServiceImpl {
  return new CommunityServiceImpl({ repo: fake.repo, logger: silent, now: NOW });
}

test("listUpcomingEvents passes through the repository", async () => {
  const events: EventDTO[] = [anEvent()];
  const svc = svcOf(repo({ async listUpcomingEvents() { return events; } }));
  const r = await svc.listUpcomingEvents("g1");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value[0]?.title, "F7 carries");
});

// ── RSVP ──

test("GOING under capacity records GOING", async () => {
  const r = repo({ async getEventForRsvp() { return eventInfo({ capacity: 5, goingCount: 2 }); } });
  const result = await svcOf(r).rsvp("e1", "111", "GOING");
  assert.equal(result.ok && result.value.state, "GOING");
  assert.equal(result.ok && result.value.waitlisted, false);
  assert.equal(r.rsvps[0]?.state, "GOING");
});

test("GOING at capacity is downgraded to WAITLIST and flagged as such", async () => {
  const r = repo({ async getEventForRsvp() { return eventInfo({ capacity: 4, goingCount: 4 }); } });
  const result = await svcOf(r).rsvp("e1", "111", "GOING");
  assert.equal(result.ok && result.value.state, "WAITLIST");
  assert.equal(result.ok && result.value.waitlisted, true);
  assert.equal(r.rsvps[0]?.state, "WAITLIST");
});

test("uncapped events never waitlist", async () => {
  const r = repo({ async getEventForRsvp() { return eventInfo({ capacity: null, goingCount: 100 }); } });
  const result = await svcOf(r).rsvp("e1", "111", "GOING");
  assert.equal(result.ok && result.value.state, "GOING");
});

test("NOT_GOING is never waitlisted even at capacity", async () => {
  const r = repo({ async getEventForRsvp() { return eventInfo({ capacity: 1, goingCount: 5 }); } });
  const result = await svcOf(r).rsvp("e1", "111", "NOT_GOING");
  assert.equal(result.ok && result.value.state, "NOT_GOING");
});

test("rsvp to a missing event fails", async () => {
  const result = await svcOf(repo()).rsvp("nope", "111", "GOING");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "NOT_FOUND");
});

test("rsvp to a cancelled event is closed", async () => {
  const r = repo({ async getEventForRsvp() { return eventInfo({ status: "CANCELLED" }); } });
  const result = await svcOf(r).rsvp("e1", "111", "GOING");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "CLOSED");
});

// ── Event creation and cancellation ──

test("createEvent rejects a start time in the past", async () => {
  const r = await svcOf(repo()).createEvent({
    guildId: "g1", title: "x", startsAt: "2026-07-01T00:00:00.000Z", type: "CUSTOM", hostDiscordId: "111",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "INVALID_TIME");
});

test("createEvent rejects an unparseable start time", async () => {
  const r = await svcOf(repo()).createEvent({
    guildId: "g1", title: "x", startsAt: "next tuesday-ish", type: "CUSTOM", hostDiscordId: "111",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "INVALID_TIME");
});

test("createEvent accepts a future start time", async () => {
  const r = await svcOf(repo()).createEvent({
    guildId: "g1", title: "Kuudra t5", startsAt: "2026-09-01T18:00:00.000Z", type: "CUSTOM", hostDiscordId: "111",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.title, "Kuudra t5");
});

test("only the host can cancel an event", async () => {
  const r = await svcOf(repo()).cancelEvent("e1", "999");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "NOT_HOST");
});

test("the host can cancel an event", async () => {
  const r = await svcOf(repo()).cancelEvent("e1", "111");
  assert.equal(r.ok && r.value.status, "CANCELLED");
});

test("an already-cancelled event cannot be cancelled again", async () => {
  const r = await svcOf(repo({ async getEvent() { return anEvent({ status: "CANCELLED" }); } })).cancelEvent("e1", "111");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "CLOSED");
});

// ── LFG ──

test("createLfg rejects out-of-range slot counts", async () => {
  const svc = svcOf(repo());
  for (const slotsTotal of [1, 0, 21, 2.5]) {
    const r = await svc.createLfg({ guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", slotsTotal });
    assert.equal(r.ok, false, `slotsTotal=${slotsTotal} should be rejected`);
    if (!r.ok) assert.equal(r.error.kind, "INVALID_SLOTS");
  }
});

test("a fresh post counts the author as filling a slot", async () => {
  const r = await svcOf(repo()).createLfg({ guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", slotsTotal: 5 });
  assert.equal(r.ok && r.value.slotsFilled, 1);
  assert.deepEqual(r.ok && r.value.members, ["111"]);
});

test("joining appends to the roster and stays OPEN below capacity", async () => {
  const f = repo({ async getLfg() { return aPost(); } });
  const r = await svcOf(f).joinLfg("p1", "222");
  assert.equal(r.ok && r.value.slotsFilled, 2);
  assert.deepEqual(f.rosters[0]?.members, ["111", "222"]);
  assert.equal(f.rosters[0]?.status, "OPEN");
});

test("the last join flips the post to FULL", async () => {
  const f = repo({ async getLfg() { return aPost({ slotsTotal: 2, slotsFilled: 1 }); } });
  const r = await svcOf(f).joinLfg("p1", "222");
  assert.equal(r.ok && r.value.status, "FULL");
  assert.equal(f.rosters[0]?.status, "FULL");
});

test("joining a full post fails", async () => {
  const f = repo({ async getLfg() { return aPost({ slotsTotal: 2, slotsFilled: 2, members: ["111", "222"], status: "FULL" }); } });
  const r = await svcOf(f).joinLfg("p1", "333");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "FULL");
  assert.equal(f.rosters.length, 0);
});

test("joining twice fails", async () => {
  const f = repo({ async getLfg() { return aPost({ members: ["111", "222"], slotsFilled: 2 }); } });
  const r = await svcOf(f).joinLfg("p1", "222");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "ALREADY_JOINED");
});

test("leaving frees the slot and reopens a full post", async () => {
  const f = repo({ async getLfg() { return aPost({ slotsTotal: 2, slotsFilled: 2, members: ["111", "222"], status: "FULL" }); } });
  const r = await svcOf(f).leaveLfg("p1", "222");
  assert.equal(r.ok && r.value.status, "OPEN");
  assert.deepEqual(f.rosters[0]?.members, ["111"]);
});

test("the author cannot leave their own post", async () => {
  const f = repo({ async getLfg() { return aPost(); } });
  const r = await svcOf(f).leaveLfg("p1", "111");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "AUTHOR_CANNOT_LEAVE");
});

test("leaving a post you never joined fails", async () => {
  const f = repo({ async getLfg() { return aPost(); } });
  const r = await svcOf(f).leaveLfg("p1", "999");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "NOT_A_MEMBER");
});

test("joining a closed post fails", async () => {
  const f = repo({ async getLfg() { return aPost({ status: "EXPIRED" }); } });
  const r = await svcOf(f).joinLfg("p1", "222");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "CLOSED");
});

// ── Tickets ──

test("closing an open ticket succeeds", async () => {
  const f = repo({ async getTicket() { return aTicket(); } });
  const r = await svcOf(f).closeTicket("t1", "111", "sorted");
  assert.equal(r.ok && r.value.status, "CLOSED");
});

test("closing an already-closed ticket fails", async () => {
  const f = repo({ async getTicket() { return aTicket({ status: "CLOSED" }); } });
  const r = await svcOf(f).closeTicket("t1", "111", null);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "ALREADY_CLOSED");
});

test("closing a missing ticket fails", async () => {
  const r = await svcOf(repo()).closeTicket("nope", "111", null);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "NOT_FOUND");
});

// ── Applications ──

test("accepting a submitted application records the reviewer", async () => {
  const f = repo({ async getApplication() { return anApplication(); } });
  const r = await svcOf(f).decideApplication({ applicationId: "a1", reviewerDiscordId: "111", accept: true });
  assert.equal(r.ok && r.value.status, "ACCEPTED");
  assert.equal(r.ok && r.value.reviewerDiscordId, "111");
});

test("denying carries the reason through", async () => {
  const f = repo({ async getApplication() { return anApplication(); } });
  const r = await svcOf(f).decideApplication({
    applicationId: "a1", reviewerDiscordId: "111", accept: false, reason: "too low catacombs",
  });
  assert.equal(r.ok && r.value.status, "REJECTED");
  assert.equal(r.ok && r.value.decisionReason, "too low catacombs");
});

test("an already-decided application cannot be re-decided", async () => {
  const f = repo({ async getApplication() { return anApplication({ status: "ACCEPTED" }); } });
  const r = await svcOf(f).decideApplication({ applicationId: "a1", reviewerDiscordId: "111", accept: false });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "ALREADY_DECIDED");
    if (r.error.kind === "ALREADY_DECIDED") assert.equal(r.error.status, "ACCEPTED");
  }
});

// ── Roster ──

test("setMemberRole returns the updated member", async () => {
  const member: MemberSummaryDTO = {
    guildId: "g1", discordId: "111", ign: "Notch", role: "MODERATOR",
    status: "ACTIVE", guildRank: null, joinedAt: null,
  };
  const r = await svcOf(repo({ async setMemberRole() { return member; } })).setMemberRole("g1", "111", "MODERATOR");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.role, "MODERATOR");
});

test("setMemberRole fails for someone not on the roster", async () => {
  const r = await svcOf(repo()).setMemberRole("g1", "999", "MODERATOR");
  assert.equal(r.ok, false);
});
