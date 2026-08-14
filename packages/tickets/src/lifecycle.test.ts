import assert from "node:assert/strict";
import test from "node:test";
import {
  RESUME_MESSAGE_COUNT,
  averageRating,
  averageResolutionTimeMs,
  averageResponseTimeMs,
  canAct,
  claim,
  close,
  isPendingClosure,
  release,
  requestClose,
  sweep,
  transfer,
  type Actor,
  type SweepInput,
} from "./lifecycle.js";
import { settings, ticket } from "./fixtures.test.js";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const OPENER: Actor = { discordId: "opener", isStaff: false };
const STAFF: Actor = { discordId: "staff", isStaff: true };
const STRANGER: Actor = { discordId: "stranger", isStaff: false };

test("only the opener and staff may act — the hole the old command left open", () => {
  const t = ticket();
  assert.equal(canAct(t, OPENER), true);
  assert.equal(canAct(t, STAFF), true);
  assert.equal(canAct(t, STRANGER), false);
});

test("a stranger cannot close someone else's ticket by id", () => {
  const result = close(ticket(), STRANGER);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : null, "FORBIDDEN");
});

test("the opener may close and request closure of their own ticket", () => {
  assert.equal(close(ticket(), OPENER).ok, true);
  const req = requestClose(ticket(), OPENER, NOW);
  assert.equal(req.ok, true);
  assert.deepEqual(req.ok ? req.value : null, {
    closeRequestedByDiscordId: "opener",
    closeRequestedAt: NOW,
  });
});

test("nothing may be done to a closed ticket", () => {
  const t = ticket({ status: "CLOSED", closedAt: NOW.toISOString() });
  for (const result of [
    claim(t, STAFF, true, NOW),
    release(t, STAFF),
    transfer(t, STAFF, "other", NOW),
    requestClose(t, OPENER, NOW),
    close(t, STAFF),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : null, "ALREADY_CLOSED");
  }
});

test("claiming is staff-only, needs a claimable category, and happens once", () => {
  const byMember = claim(ticket(), OPENER, true, NOW);
  assert.equal(byMember.ok === false ? byMember.reason : null, "FORBIDDEN");
  const notClaimable = claim(ticket(), STAFF, false, NOW);
  assert.equal(notClaimable.ok === false ? notClaimable.reason : null, "NOT_CLAIMABLE");

  const first = claim(ticket(), STAFF, true, NOW);
  assert.deepEqual(first.ok ? first.value : null, { claimedByDiscordId: "staff", claimedAt: NOW });

  const again = claim(ticket({ claimedByDiscordId: "someone" }), STAFF, true, NOW);
  assert.equal(again.ok === false ? again.reason : null, "ALREADY_CLAIMED");
});

test("any staff member may release a claim, but there must be one", () => {
  assert.equal(release(ticket({ claimedByDiscordId: "other" }), STAFF).ok, true);
  const none = release(ticket(), STAFF);
  assert.equal(none.ok === false ? none.reason : null, "NOT_CLAIMED");
  const member = release(ticket({ claimedByDiscordId: "other" }), OPENER);
  assert.equal(member.ok === false ? member.reason : null, "FORBIDDEN");
});

test("transfer is a re-claim and names the new claimant", () => {
  const result = transfer(ticket({ claimedByDiscordId: "old" }), STAFF, "new", NOW);
  assert.deepEqual(result.ok ? result.value : null, { claimedByDiscordId: "new", claimedAt: NOW });
  assert.equal(transfer(ticket(), OPENER, "new", NOW).ok, false);
});

// ── the clocks ──────────────────────────────────────────────────────────────

function sweepInput(over: Partial<SweepInput> = {}): SweepInput {
  return {
    ticket: ticket(),
    settings: settings(),
    messagesSinceCloseRequest: 0,
    staleWarned: false,
    now: NOW,
    ...over,
  };
}

test("a healthy ticket is not pending closure and is not swept", () => {
  const at = new Date(NOW.getTime() - 60_000).toISOString();
  const i = sweepInput({ ticket: ticket({ lastMessageAt: at }) });
  assert.equal(isPendingClosure(i), false);
  assert.equal(sweep(i), "NONE");
});

test("a standing close request makes a ticket pending", () => {
  const i = sweepInput({
    ticket: ticket({ closeRequestedAt: new Date(NOW.getTime() - 60_000).toISOString() }),
  });
  assert.equal(isPendingClosure(i), true);
  assert.equal(sweep(i), "WARN_STALE");
});

test("five further messages withdraw the close request", () => {
  const t = ticket({ closeRequestedAt: new Date(NOW.getTime() - 60_000).toISOString() });
  assert.equal(isPendingClosure(sweepInput({ ticket: t, messagesSinceCloseRequest: RESUME_MESSAGE_COUNT - 1 })), true);
  assert.equal(isPendingClosure(sweepInput({ ticket: t, messagesSinceCloseRequest: RESUME_MESSAGE_COUNT })), false);
  assert.equal(sweep(sweepInput({ ticket: t, messagesSinceCloseRequest: RESUME_MESSAGE_COUNT })), "NONE");
});

test("silence past the stale threshold makes a ticket pending — but only when the guild set one", () => {
  const quiet = ticket({ lastMessageAt: new Date(NOW.getTime() - 120 * 60_000).toISOString() });
  assert.equal(isPendingClosure(sweepInput({ ticket: quiet, settings: settings({ staleAfterMinutes: null }) })), false);
  assert.equal(isPendingClosure(sweepInput({ ticket: quiet, settings: settings({ staleAfterMinutes: 60 }) })), true);
});

test("a ticket with no messages yet is measured from when it was opened", () => {
  const old = ticket({ lastMessageAt: null, createdAt: new Date(NOW.getTime() - 120 * 60_000).toISOString() });
  assert.equal(isPendingClosure(sweepInput({ ticket: old, settings: settings({ staleAfterMinutes: 60 }) })), true);
});

test("the stale warning is posted once, then the auto-close clock runs out", () => {
  const t = ticket({ closeRequestedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString() });
  const s = settings({ autoCloseAfterMinutes: 720 });
  assert.equal(sweep(sweepInput({ ticket: t, settings: s })), "WARN_STALE");
  assert.equal(sweep(sweepInput({ ticket: t, settings: s, staleWarned: true })), "NONE");

  const expired = ticket({ closeRequestedAt: new Date(NOW.getTime() - 721 * 60_000).toISOString() });
  assert.equal(sweep(sweepInput({ ticket: expired, settings: s, staleWarned: true })), "AUTO_CLOSE");
});

test("a closed ticket is never swept", () => {
  const t = ticket({ status: "CLOSED", closeRequestedAt: new Date(0).toISOString() });
  assert.equal(sweep(sweepInput({ ticket: t })), "NONE");
  assert.equal(isPendingClosure(sweepInput({ ticket: t })), false);
});

// ── statistics ──────────────────────────────────────────────────────────────

test("response time excludes unanswered tickets rather than counting them as zero", () => {
  const answered = ticket({
    createdAt: "2026-08-01T00:00:00.000Z",
    firstStaffReplyAt: "2026-08-01T00:10:00.000Z",
  });
  const ignored = ticket({ createdAt: "2026-08-01T00:00:00.000Z", firstStaffReplyAt: null });
  // Counting the ignored ticket as zero would halve the mean and make an
  // unanswered queue look twice as fast as it is.
  assert.equal(averageResponseTimeMs([answered, ignored]), 600_000);
  assert.equal(averageResponseTimeMs([ignored]), null);
  assert.equal(averageResponseTimeMs([]), null);
});

test("resolution time and rating are null when there is no data, never zero", () => {
  assert.equal(averageResolutionTimeMs([ticket()]), null);
  assert.equal(averageRating([ticket()]), null);
  assert.equal(
    averageResolutionTimeMs([ticket({ createdAt: "2026-08-01T00:00:00.000Z", closedAt: "2026-08-01T01:00:00.000Z" })]),
    3_600_000,
  );
  assert.equal(averageRating([ticket({ feedbackRating: 5 }), ticket({ feedbackRating: 4 })]), 4.5);
});
