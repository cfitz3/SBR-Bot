import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaytimeTracker } from "./tracker.js";
import { describePlaytime } from "./format.js";

const T0 = new Date("2026-08-27T20:00:00.000Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

test("a login starts a session and a long absence ends it", () => {
  const t = new PlaytimeTracker();
  assert.deepEqual(t.observe("Notch", "ONLINE", T0), {
    kind: "STARTED",
    ign: "Notch",
    startedAt: T0.toISOString(),
  });
  assert.equal(t.observe("Notch", "OFFLINE", at(30)), null, "a leave does not end anything on its own");
  const [effect] = t.sweep(at(35));
  assert.equal(effect?.kind, "ENDED");
  assert.equal(effect?.kind === "ENDED" ? effect.session.seconds : 0, 30 * 60);
});

test("a session ends when the member left, not when the sweep noticed", () => {
  // Crediting the grace window to everybody would add the same constant to
  // every session on the server — a silent, uniform overcount.
  const t = new PlaytimeTracker();
  t.observe("Notch", "ONLINE", T0);
  t.observe("Notch", "OFFLINE", at(10));
  const [effect] = t.sweep(at(90));
  assert.equal(effect?.kind === "ENDED" ? effect.session.endedAt : "", at(10).toISOString());
});

test("a reconnect inside the grace period is one session, not two", () => {
  // The bug this whole module exists for: a member crossing a server boundary
  // produces leave-then-join, and one evening becomes forty one-minute rows.
  const t = new PlaytimeTracker();
  t.observe("Steve", "ONLINE", T0);
  t.observe("Steve", "OFFLINE", at(20));
  assert.equal(t.observe("Steve", "ONLINE", at(20.5)), null, "the rejoin starts nothing new");
  assert.deepEqual(t.sweep(at(25)), [], "and nothing closed behind it");
  assert.deepEqual(
    t.live().map((s) => s.startedAt),
    [T0.toISOString()],
    "the original start time survives the flap",
  );
});

test("a member inside the grace period still reads as playing", () => {
  const t = new PlaytimeTracker();
  t.observe("Steve", "ONLINE", T0);
  t.observe("Steve", "OFFLINE", at(20));
  assert.equal(t.live().length, 1, "a two-second reconnect is not an absence to the reader");
});

test("a session too short to mean anything is dropped rather than recorded", () => {
  const t = new PlaytimeTracker();
  t.observe("Alex", "ONLINE", T0);
  t.observe("Alex", "OFFLINE", new Date(T0.getTime() + 20_000));
  assert.deepEqual(t.sweep(at(5)), []);
  assert.deepEqual(t.live(), [], "and it is still cleared out");
});

test("notices for members the bridge never saw arrive are ignored", () => {
  // The bridge starts mid-evening; half the guild is already on. A logout for
  // somebody with no session is not an error and not a zero-length session.
  const t = new PlaytimeTracker();
  assert.equal(t.observe("Aria", "OFFLINE", T0), null);
  assert.deepEqual(t.sweep(at(10)), []);
});

test("a duplicate login does not restart the clock", () => {
  const t = new PlaytimeTracker();
  t.observe("Bex", "ONLINE", T0);
  assert.equal(t.observe("Bex", "ONLINE", at(10)), null);
  assert.deepEqual(t.live().map((s) => s.startedAt), [T0.toISOString()]);
});

test("names are matched without regard to case", () => {
  const t = new PlaytimeTracker();
  t.observe("Cyd", "ONLINE", T0);
  t.observe("cyd", "OFFLINE", at(10));
  const [effect] = t.sweep(at(20));
  assert.equal(effect?.kind === "ENDED" ? effect.session.ign : "", "Cyd", "the cased name is what we render");
});

test("a roster read adopts members the bridge never saw log in", () => {
  // After a restart every session is gone but the guild is still playing.
  const t = new PlaytimeTracker();
  const started = t.reconcile(["Notch", "Steve"], T0);
  assert.deepEqual(started.map((e) => e.kind), ["STARTED", "STARTED"]);
  assert.equal(t.isEstimated("Notch"), true, "the start time is a lower bound, and says so");
});

test("a roster read closes sessions whose leave notice never arrived", () => {
  const t = new PlaytimeTracker();
  t.observe("Notch", "ONLINE", T0);
  t.observe("Steve", "ONLINE", T0);
  const effects = t.reconcile(["Notch"], at(45));
  assert.deepEqual(
    effects.filter((e) => e.kind === "ENDED").map((e) => (e.kind === "ENDED" ? e.session.ign : "")),
    ["Steve"],
  );
  assert.deepEqual(t.live().map((s) => s.ign), ["Notch"]);
});

test("a roster read does not restart a session it already knows about", () => {
  const t = new PlaytimeTracker();
  t.observe("Notch", "ONLINE", T0);
  assert.deepEqual(t.reconcile(["Notch"], at(20)), []);
  assert.deepEqual(t.live().map((s) => s.startedAt), [T0.toISOString()]);
  assert.equal(t.isEstimated("Notch"), false);
});

test("a roster read clears a pending close for somebody who is plainly still there", () => {
  const t = new PlaytimeTracker();
  t.observe("Notch", "ONLINE", T0);
  t.observe("Notch", "OFFLINE", at(10));
  t.reconcile(["Notch"], at(11));
  assert.deepEqual(t.sweep(at(30)), [], "the roster is better evidence than a missed notice");
});

test("playtime reads as a duration, not as a time of arrival", () => {
  assert.equal(describePlaytime(T0.toISOString(), at(42)), "42m");
  assert.equal(describePlaytime(T0.toISOString(), at(0.5)), "just now");
  assert.equal(describePlaytime(T0.toISOString(), at(60)), "1h");
  assert.equal(describePlaytime(T0.toISOString(), at(185)), "3h 5m");
});

test("an estimated start is marked, because we know a floor and not a start", () => {
  assert.equal(describePlaytime(T0.toISOString(), at(42), true), "42m+");
  assert.equal(describePlaytime(T0.toISOString(), at(0.5), true), "just now", "no floor to mark yet");
});

test("durations round down, so an hour is never claimed at fifty-nine minutes", () => {
  assert.equal(describePlaytime(T0.toISOString(), at(59.9)), "59m");
});
