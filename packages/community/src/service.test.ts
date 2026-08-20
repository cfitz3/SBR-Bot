import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplicationDTO, EventDTO, LFGPostDTO, MemberSummaryDTO, RSVPState, TicketActor, TicketDTO } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { CommunityServiceImpl } from "./service.js";
import type {
  CommunityRepository,
  EventPatch,
  EventRsvpInfo,
  LfgInsert,
  LfgPatch,
  PermRosterLookup,
} from "./ports.js";

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
    id: "p1", guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", title: null, details: null,
    slotsTotal: 5, slotsFilled: 1, status: "OPEN", expiresAt: null,
    createdAt: "2026-08-01T00:00:00.000Z", members: ["111"],
    channelId: null, messageId: null, permGroupId: null, closedAt: null, closedByDiscordId: null,
    ...over,
  };
}

function aTicket(over: Partial<TicketDTO> = {}): TicketDTO {
  return {
    id: "t1", guildId: "g1", number: 1, openerDiscordId: "111", assigneeDiscordId: null,
    categoryId: "cat1", categoryKey: "support", categoryName: "Support",
    status: "OPEN", channelId: null, subject: null, topic: null,
    claimedByDiscordId: null, claimedAt: null,
    closeRequestedByDiscordId: null, closeRequestedAt: null,
    lastMessageAt: null, firstStaffReplyAt: null, feedbackRating: null, transcriptReady: false,
    closeReason: null, createdAt: "2026-08-01T00:00:00.000Z", closedAt: null,
    ...over,
  };
}

/** Staff, unless a test says otherwise — the close/claim paths are staff paths. */
const staff = (discordId = "111"): TicketActor => ({ discordId, isStaff: true });

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
  /** What createLfg was actually asked to write, after perm resolution. */
  created: LfgInsert[];
  /** What updateLfg was asked to change, so "left alone" can be asserted. */
  patches: Array<{ postId: string; patch: LfgPatch }>;
  /** The same, for events: an edit must write only the fields it was given. */
  eventPatches: Array<{ eventId: string; patch: EventPatch }>;
}

function repo(over: Partial<CommunityRepository> = {}): Fake {
  const rsvps: Fake["rsvps"] = [];
  const rosters: Fake["rosters"] = [];
  const created: Fake["created"] = [];
  const patches: Fake["patches"] = [];
  const eventPatches: Fake["eventPatches"] = [];
  return {
    rsvps,
    rosters,
    created,
    patches,
    eventPatches,
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
      async updateEvent(eventId, patch) {
        eventPatches.push({ eventId, patch });
        return anEvent({
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.endsAt === undefined ? {} : { endsAt: patch.endsAt?.toISOString() ?? null }),
        });
      },
      async getAttendance() { return null; },
      async createLfg(input) {
        created.push(input);
        return aPost({
          ...input,
          members: [...input.members],
          slotsFilled: input.members.length,
          status: input.members.length >= input.slotsTotal ? "FULL" : "OPEN",
        });
      },
      async getLfg() { return null; },
      async listLfg() { return []; },
      async setLfgMembers(postId, members, status) {
        rosters.push({ postId, members, status });
        return aPost({ members: [...members], slotsFilled: members.length, status });
      },
      async updateLfg(postId, patch) {
        patches.push({ postId, patch });
        return aPost(patch as Partial<LFGPostDTO>);
      },
      async closeLfg(_postId, closedByDiscordId, closedAt) {
        return aPost({ status: "CLOSED", closedByDiscordId, closedAt: closedAt.toISOString() });
      },
      async bindLfgMessage(_postId, channelId, messageId) { return aPost({ channelId, messageId }); },
      async createTicket(input) { return aTicket({ ...input, topic: input.topic ?? null }); },
      async getTicket() { return null; },
      async getTicketByChannel() { return null; },
      async patchTicket(_id, patch) {
        // The patch carries `Date`s where the DTO carries ISO strings — the same
        // conversion the real repository does, so the stub answers in the shape
        // callers actually see.
        const iso = (d: Date | null | undefined): string | null => (d == null ? null : d.toISOString());
        return aTicket({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.assigneeDiscordId !== undefined ? { assigneeDiscordId: patch.assigneeDiscordId } : {}),
          ...(patch.claimedByDiscordId !== undefined ? { claimedByDiscordId: patch.claimedByDiscordId } : {}),
          ...(patch.claimedAt !== undefined ? { claimedAt: iso(patch.claimedAt) } : {}),
          ...(patch.closeRequestedByDiscordId !== undefined
            ? { closeRequestedByDiscordId: patch.closeRequestedByDiscordId }
            : {}),
          ...(patch.closeRequestedAt !== undefined ? { closeRequestedAt: iso(patch.closeRequestedAt) } : {}),
          ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
          ...(patch.closeReason !== undefined ? { closeReason: patch.closeReason } : {}),
          ...(patch.closedAt !== undefined ? { closedAt: iso(patch.closedAt) } : {}),
          ...(patch.lastMessageAt !== undefined ? { lastMessageAt: iso(patch.lastMessageAt) } : {}),
          ...(patch.firstStaffReplyAt !== undefined ? { firstStaffReplyAt: iso(patch.firstStaffReplyAt) } : {}),
          ...(patch.transcriptReady !== undefined ? { transcriptReady: patch.transcriptReady } : {}),
        });
      },
      async listTickets() { return []; },
      async listTicketCategories() { return []; },
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

// ── Event edits and completion ──

test("an edit writes only the fields it was given", async () => {
  const r = repo();
  const result = await svcOf(r).updateEvent({ eventId: "e1", actorDiscordId: "111", title: "  F7 carries v2  " });
  assert.equal(result.ok, true);
  assert.deepEqual(r.eventPatches, [{ eventId: "e1", patch: { title: "F7 carries v2" } }]);
});

test("an edit by someone who is not the host is refused", async () => {
  const r = await svcOf(repo()).updateEvent({ eventId: "e1", actorDiscordId: "999", title: "mine now" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "NOT_HOST");
});

test("staff may edit somebody else's event", async () => {
  const r = await svcOf(repo()).updateEvent({ eventId: "e1", actorDiscordId: "999", isStaff: true, title: "moved" });
  assert.equal(r.ok, true);
});

test("a finished event cannot be edited", async () => {
  const r = await svcOf(repo({ async getEvent() { return anEvent({ status: "COMPLETED" }); } }))
    .updateEvent({ eventId: "e1", actorDiscordId: "111", title: "x" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "CLOSED");
});

test("a scheduled event cannot be moved into the past", async () => {
  const r = await svcOf(repo()).updateEvent({
    eventId: "e1", actorDiscordId: "111", startsAt: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "INVALID_TIME");
});

test("a live event's start time may be in the past, because it already is", async () => {
  const r = await svcOf(repo({ async getEvent() { return anEvent({ status: "LIVE" }); } })).updateEvent({
    eventId: "e1", actorDiscordId: "111", startsAt: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(r.ok, true);
});

test("a repeated metric is written once, in the order it was first given", async () => {
  const r = repo();
  await svcOf(r).updateEvent({
    eventId: "e1", actorDiscordId: "111", trackedMetrics: ["networth", "catacombsLevel", "networth", " "],
  });
  assert.deepEqual(r.eventPatches[0]?.patch.trackedMetrics, ["networth", "catacombsLevel"]);
});

test("an unreasonable poll interval is refused", async () => {
  const r = await svcOf(repo()).updateEvent({ eventId: "e1", actorDiscordId: "111", pollIntervalMinutes: 1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "INVALID_TIME");
});

test("clearing the metric list is an edit like any other", async () => {
  const r = repo();
  await svcOf(r).updateEvent({ eventId: "e1", actorDiscordId: "111", trackedMetrics: [] });
  assert.deepEqual(r.eventPatches[0]?.patch.trackedMetrics, []);
});

test("completing an event stamps the end time", async () => {
  const r = repo();
  const result = await svcOf(r).completeEvent("e1", "111");
  assert.equal(result.ok && result.value.status, "COMPLETED");
  assert.deepEqual(r.eventPatches, [{ eventId: "e1", patch: { status: "COMPLETED", endsAt: NOW() } }]);
});

test("a cancelled event cannot then be completed", async () => {
  const r = await svcOf(repo({ async getEvent() { return anEvent({ status: "CANCELLED" }); } }))
    .completeEvent("e1", "111");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "CLOSED");
});

test("only the host, or staff, can complete an event", async () => {
  const denied = await svcOf(repo()).completeEvent("e1", "999");
  assert.equal(denied.ok === false && denied.error.kind, "NOT_HOST");
  const allowed = await svcOf(repo()).completeEvent("e1", "999", true);
  assert.equal(allowed.ok, true);
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

// ── LFG: perm autofill ──

/** A lookup with one default perm and one named perm, and nothing else. */
function permLookup(over: Partial<PermRosterLookup> = {}): PermRosterLookup {
  return {
    async defaultRoster() { return { id: "perm1", name: "Main", discordIds: ["222", "333"] }; },
    async namedRoster(_g, _o, name) {
      return name === "Alts" ? { id: "perm2", name: "Alts", discordIds: ["444"] } : null;
    },
    ...over,
  };
}

function svcWithPerms(fake: Fake, perms: PermRosterLookup): CommunityServiceImpl {
  return new CommunityServiceImpl({ repo: fake.repo, logger: silent, now: NOW, perms });
}

test("perm:true fills the roster from the author's default perm", async () => {
  const f = repo();
  const r = await svcWithPerms(f, permLookup()).createLfg({
    guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", slotsTotal: 5, perm: true,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(f.created[0]?.members, ["111", "222", "333"]);
  assert.equal(f.created[0]?.permGroupId, "perm1", "which perm it came from is worth recording");
});

test("the author holds the first seat even when the perm lists them too", async () => {
  const f = repo();
  const perms = permLookup({
    async defaultRoster() { return { id: "perm1", name: "Main", discordIds: ["111", "222"] }; },
  });
  await svcWithPerms(f, perms).createLfg({
    guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", slotsTotal: 5, perm: true,
  });
  assert.deepEqual(f.created[0]?.members, ["111", "222"], "nobody takes two seats");
});

test("autofill stops at the slot count rather than overfilling the post", async () => {
  const f = repo();
  const perms = permLookup({
    async defaultRoster() { return { id: "perm1", name: "Main", discordIds: ["222", "333", "444"] }; },
  });
  const r = await svcWithPerms(f, perms).createLfg({
    guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", slotsTotal: 2, perm: true,
  });
  assert.deepEqual(f.created[0]?.members, ["111", "222"]);
  assert.equal(r.ok && r.value.status, "FULL", "a post that starts full says so");
});

test("perm:true with no default perm is an ordinary solo post, not an error", async () => {
  const f = repo();
  const perms = permLookup({ async defaultRoster() { return null; } });
  const r = await svcWithPerms(f, perms).createLfg({
    guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", slotsTotal: 5, perm: true,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(f.created[0]?.members, ["111"]);
  assert.equal(f.created[0]?.permGroupId, null);
});

test("naming a perm that does not exist is an error", async () => {
  const r = await svcWithPerms(repo(), permLookup()).createLfg({
    guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", slotsTotal: 5, perm: "Ghost",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "NO_SUCH_PERM");
});

test("a named perm fills from that perm, not the default", async () => {
  const f = repo();
  await svcWithPerms(f, permLookup()).createLfg({
    guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", slotsTotal: 5, perm: "Alts",
  });
  assert.deepEqual(f.created[0]?.members, ["111", "444"]);
  assert.equal(f.created[0]?.permGroupId, "perm2");
});

test("without perms wired in, perm:true still posts and a named perm complains", async () => {
  const f = repo();
  const bare = svcOf(f);
  assert.equal(
    (await bare.createLfg({ guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", slotsTotal: 5, perm: true })).ok,
    true,
  );
  const named = await bare.createLfg({
    guildId: "g1", authorDiscordId: "111", activity: "DUNGEONS", slotsTotal: 5, perm: "Alts",
  });
  assert.equal(named.ok, false);
  if (!named.ok) assert.equal(named.error.kind, "NO_SUCH_PERM");
});

// ── LFG: edit and close ──

test("someone else's post cannot be edited", async () => {
  const f = repo({ async getLfg() { return aPost(); } });
  const r = await svcOf(f).editLfg({ postId: "p1", actorDiscordId: "999", title: "mine now" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "NOT_YOURS");
});

test("staff can edit a post they did not write", async () => {
  const f = repo({ async getLfg() { return aPost(); } });
  const r = await svcOf(f).editLfg({ postId: "p1", actorDiscordId: "999", isStaff: true, title: "tidied" });
  assert.equal(r.ok, true);
  assert.deepEqual(f.patches[0]?.patch, { title: "tidied" });
});

test("an edit only writes the fields it was given", async () => {
  const f = repo({ async getLfg() { return aPost({ details: "cata 30+" }); } });
  await svcOf(f).editLfg({ postId: "p1", actorDiscordId: "111", title: "F7 carries" });
  assert.deepEqual(Object.keys(f.patches[0]?.patch ?? {}), ["title"], "details must not be blanked by omission");
});

test("shrinking a post below the people already in it is refused", async () => {
  const f = repo({ async getLfg() { return aPost({ members: ["111", "222", "333"], slotsFilled: 3 }); } });
  const r = await svcOf(f).editLfg({ postId: "p1", actorDiscordId: "111", slotsTotal: 2 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "SLOTS_BELOW_ROSTER");
});

test("raising the slot count on a full post reopens it", async () => {
  const f = repo({
    async getLfg() { return aPost({ slotsTotal: 2, slotsFilled: 2, members: ["111", "222"], status: "FULL" }); },
  });
  await svcOf(f).editLfg({ postId: "p1", actorDiscordId: "111", slotsTotal: 4 });
  assert.equal(f.patches[0]?.patch.status, "OPEN");
});

test("a closed post cannot be edited", async () => {
  const f = repo({ async getLfg() { return aPost({ status: "CLOSED" }); } });
  const r = await svcOf(f).editLfg({ postId: "p1", actorDiscordId: "111", title: "reopen pls" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "CLOSED");
});

test("closing records who closed it and when", async () => {
  const f = repo({ async getLfg() { return aPost(); } });
  const r = await svcOf(f).closeLfg("p1", "111");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.closedByDiscordId, "111");
    assert.equal(r.value.closedAt, NOW().toISOString());
  }
});

test("only the author or staff can close a post", async () => {
  const f = repo({ async getLfg() { return aPost(); } });
  assert.equal((await svcOf(f).closeLfg("p1", "999")).ok, false);
  assert.equal((await svcOf(f).closeLfg("p1", "999", true)).ok, true);
});

test("closing an already closed post fails rather than restamping it", async () => {
  const f = repo({ async getLfg() { return aPost({ status: "CLOSED" }); } });
  const r = await svcOf(f).closeLfg("p1", "111");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "CLOSED");
});

test("binding a message records where the post was published", async () => {
  const r = await svcOf(repo()).bindLfgMessage("p1", "c9", "m9");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.messageId, "m9");
});

test("binding a post that no longer exists is not found", async () => {
  const f = repo({ async bindLfgMessage() { return null; } });
  const r = await svcOf(f).bindLfgMessage("gone", "c9", "m9");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "NOT_FOUND");
});

// ── Tickets ──

test("closing an open ticket succeeds", async () => {
  const f = repo({ async getTicket() { return aTicket(); } });
  const r = await svcOf(f).closeTicket("t1", staff(), "sorted");
  assert.equal(r.ok && r.value.status, "CLOSED");
});

test("closing an already-closed ticket fails", async () => {
  const f = repo({ async getTicket() { return aTicket({ status: "CLOSED" }); } });
  const r = await svcOf(f).closeTicket("t1", staff(), null);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "ALREADY_CLOSED");
});

test("closing a missing ticket fails", async () => {
  const r = await svcOf(repo()).closeTicket("nope", staff(), null);
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
