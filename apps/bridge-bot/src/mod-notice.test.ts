import assert from "node:assert/strict";
import { test } from "node:test";
import { isPunitiveNotice, parseModNotice, parseNoticeDuration } from "./mod-notice.js";

test("a kick naming the staff member records both sides", () => {
  const notice = parseModNotice("[MVP+] Steve was kicked from the guild by [ADMIN] Alex!");
  assert.deepEqual(notice, { kind: "KICK", target: "Steve", actor: "Alex", durationSeconds: null });
});

test("a kick that names nobody records the target with a null actor rather than guessing", () => {
  const notice = parseModNotice("Steve was kicked from the guild!");
  assert.equal(notice?.kind, "KICK");
  assert.equal(notice?.target, "Steve");
  assert.equal(notice?.actor, null);
});

test("a mute carries its duration in seconds", () => {
  const notice = parseModNotice("[ADMIN] Alex has muted [MVP+] Steve for 30d");
  assert.deepEqual(notice, { kind: "MUTE", target: "Steve", actor: "Alex", durationSeconds: 30 * 86_400 });
});

test("an unmute parses with no duration", () => {
  const notice = parseModNotice("Alex has unmuted Steve");
  assert.deepEqual(notice, { kind: "UNMUTE", target: "Steve", actor: "Alex", durationSeconds: null });
});

test("rank changes are recognised but are not punishments", () => {
  const promote = parseModNotice("Alex has promoted Steve from Member to Officer");
  assert.equal(promote?.kind, "PROMOTE");
  assert.equal(isPunitiveNotice(promote!), false);
  const demote = parseModNotice("Alex has demoted Steve from Officer to Member");
  assert.equal(demote?.kind, "DEMOTE");
  assert.equal(isPunitiveNotice(demote!), false);
});

test("a member quoting a notice in guild chat manufactures nothing", () => {
  assert.equal(parseModNotice("Guild > Steve: Bob was kicked from the guild by Alex!"), null);
  assert.equal(parseModNotice("Officer > Steve: Alex has muted Bob for 10m"), null);
});

test("ordinary chatter and blank lines are not notices", () => {
  assert.equal(parseModNotice(""), null);
  assert.equal(parseModNotice("Guild > Steve: anyone for f7?"), null);
  assert.equal(parseModNotice("You are now in the party!"), null);
});

test("durations parse per unit and reject anything compound or zero", () => {
  assert.equal(parseNoticeDuration("60s"), 60);
  assert.equal(parseNoticeDuration("10m"), 600);
  assert.equal(parseNoticeDuration("12h"), 43_200);
  assert.equal(parseNoticeDuration("1d"), 86_400);
  assert.equal(parseNoticeDuration("1h30m"), null);
  assert.equal(parseNoticeDuration("0m"), null);
  assert.equal(parseNoticeDuration("soon"), null);
});

test("a target that is not a Minecraft name is rejected rather than recorded", () => {
  // 17 characters — longer than any account, so the line is something else.
  assert.equal(parseModNotice("Alex has unmuted Steveeeeeeeeeeeeeeeee"), null);
});
