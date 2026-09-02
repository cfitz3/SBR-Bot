/**
 * Join-line parsing. The failure that matters here is the quiet one: a parser
 * that stops matching admits nobody to screening and reports nothing, so the
 * cases below cover the decoration Hypixel has actually shipped over time, and
 * the near-miss lines that must *not* be read as a join.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptCommand, denyCommand, inviteCommand, parseJoinEvent, parsePresenceEvent } from "./join.js";

test("a plain request is read", () => {
  assert.deepEqual(parseJoinEvent("Steve has requested to join the Guild!"), { kind: "REQUEST", ign: "Steve" });
});

test("rank tags and colour codes are stripped off the name", () => {
  assert.deepEqual(parseJoinEvent("§b[MVP§c+§b] §aSteve_123 has requested to join the Guild!"), {
    kind: "REQUEST",
    ign: "Steve_123",
  });
  assert.deepEqual(parseJoinEvent("[YOUTUBE] Notch has requested to join the guild"), {
    kind: "REQUEST",
    ign: "Notch",
  });
});

test("a completed join is its own event", () => {
  assert.deepEqual(parseJoinEvent("[MVP+] Alex joined the guild!"), { kind: "JOINED", ign: "Alex" });
});

test("the follow-up instruction line is not a second request", () => {
  // Both lines arrive for one request; screening twice would double the
  // Hypixel calls and post two staff reports for one person.
  assert.equal(parseJoinEvent("Click here to accept or type /guild accept Steve!"), null);
});

test("ordinary guild chat is never mistaken for a join", () => {
  for (const line of [
    "Guild > Steve: has requested to join the Guild!",
    "Steve left the guild!",
    "Steve was kicked from the guild by Alex!",
    "Steve has requested to join the party!",
    "-----------------------------------------------------",
    "",
  ]) {
    assert.equal(parseJoinEvent(line), null, line);
  }
});

test("the accept command names the applicant", () => {
  assert.equal(acceptCommand("Steve"), "/guild accept Steve");
});

test("the framed block Hypixel actually sends parses even unsplit", () => {
  // The bug this file exists to pin. Hypixel sends the divider, the request and
  // the "click here" line as ONE chat packet; the transport splits it, but the
  // parser must survive the unsplit form too, because when it does not the
  // failure is complete silence rather than an error.
  const block = [
    "§b-----------------------------------------------------",
    "§b[MVP§c+§b] §bSteve_123 §ehas requested to join the Guild!",
    "§eClick here to accept or type §b/guild accept Steve_123§e!",
    "§b-----------------------------------------------------",
  ].join("\n");
  assert.deepEqual(parseJoinEvent(block), { kind: "REQUEST", ign: "Steve_123" });
});

test("each line of the split block reads correctly on its own", () => {
  assert.deepEqual(parseJoinEvent("§b[MVP§c+§b] §bSteve_123 §ehas requested to join the Guild!"), {
    kind: "REQUEST",
    ign: "Steve_123",
  });
  assert.equal(parseJoinEvent("§b-----------------------------------------------------"), null);
  assert.equal(parseJoinEvent("§eClick here to accept or type §b/guild accept Steve_123§e!"), null);
});

test("Hypixel's own join announcement is read as a join", () => {
  assert.deepEqual(parseJoinEvent("§b[MVP§c+§b] §aSteve §ejoined the guild!"), { kind: "JOINED", ign: "Steve" });
  assert.deepEqual(parseJoinEvent("Alex joined the guild!"), { kind: "JOINED", ign: "Alex" });
});

test("a member logging in is not a member joining the guild", () => {
  // The shipped bug this pattern exists to close. `Guild > Steve joined.` is
  // the presence notice every member emits on every connect; reading it as a
  // guild join screened, logged and announced an existing member as a new one,
  // several times a day, for as long as they kept playing.
  for (const line of [
    "Guild > Steve joined.",
    "§2Guild > §b[MVP§c+§b] §aSteve§2 joined.",
    "Guild > Steve left.",
    "§2Guild > §aSteve_123§2 left.",
  ]) {
    assert.equal(parseJoinEvent(line), null, line);
  }
});

test("a real join is still read when the guild prefix is present", () => {
  // The refusal is on the *presence* shape — "joined." and nothing after — not
  // on the prefix, so a broadcast that happens to carry one still counts.
  assert.deepEqual(parseJoinEvent("Guild > Steve joined the guild!"), { kind: "JOINED", ign: "Steve" });
});

test("a member typing the notice into guild chat is not a request", () => {
  // Every pattern is unanchored, so speech has to be refused explicitly —
  // otherwise anyone could name anyone and have them screened, or accepted.
  for (const line of [
    "Guild > Bob: Steve has requested to join the Guild!",
    "§2Guild > §aBob§f: §rSteve has requested to join the Guild!",
    "Officer > Bob: Alex joined the guild!",
    "Guild > Bob: Alex joined the guild!",
  ]) {
    assert.equal(parseJoinEvent(line), null, line);
  }
});

test("an underscore name is captured whole", () => {
  // `\b` would start the capture after the underscore and screen "123".
  assert.deepEqual(parseJoinEvent("Steve_123 has requested to join the guild"), {
    kind: "REQUEST",
    ign: "Steve_123",
  });
});

test("the deny and invite commands name the player", () => {
  assert.equal(denyCommand("Steve"), "/guild deny Steve");
  assert.equal(inviteCommand("Steve"), "/guild invite Steve");
});

test("a login and a logout are read as presence, from the same line join ignores", () => {
  assert.deepEqual(parsePresenceEvent("§2Guild > §aSteve §ejoined."), { ign: "Steve", kind: "ONLINE" });
  assert.deepEqual(parsePresenceEvent("§2Guild > §aSteve §eleft."), { ign: "Steve", kind: "OFFLINE" });
});

test("presence and membership stay separate readings of the same chat", () => {
  // The pair that motivated the shared pattern: one of these is a member
  // joining the guild, the other is a member logging in, and reading either as
  // the other is a visible, wrong announcement.
  assert.equal(parsePresenceEvent("[MVP+] Steve joined the guild!"), null);
  assert.equal(parseJoinEvent("Guild > Steve joined."), null);
});

test("somebody talking is never a presence notice", () => {
  assert.equal(parsePresenceEvent("Guild > Steve: joined."), null);
  assert.equal(parsePresenceEvent("Guild > Steve: left."), null);
});
