/**
 * Join-line parsing. The failure that matters here is the quiet one: a parser
 * that stops matching admits nobody to screening and reports nothing, so the
 * cases below cover the decoration Hypixel has actually shipped over time, and
 * the near-miss lines that must *not* be read as a join.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptCommand, parseJoinEvent } from "./join.js";

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
