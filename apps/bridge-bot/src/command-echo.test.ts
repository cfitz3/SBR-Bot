/**
 * The guild's own answer, read back out of chat.
 *
 * The case worth pinning here is the one that made this file necessary: a
 * `/g kick` Hypixel refused looked, from every signal the bridge had, exactly
 * like one it honoured. So each refusal string is asserted individually — they
 * are a hand-collected table against a format nobody versions, and the only
 * safe way to change it is to have the old cases held down.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CommandEcho,
  HYPIXEL_REFUSALS,
  parseCommandIntent,
  type EchoVerdict,
} from "./command-echo.js";

function harness(windowMs = 10_000) {
  const settled: EchoVerdict[] = [];
  let t = 0;
  const echo = new CommandEcho({
    onSettle: (v) => settled.push(v),
    now: () => t,
    windowMs,
    memoryMs: 120_000,
  });
  return { echo, settled, advance: (ms: number) => { t += ms; } };
}

test("a kick notice confirms the kick that asked for it", async () => {
  const h = harness();
  h.echo.watch("g1", "corr-1", "/g kick Notch Ban evasion");
  assert.equal(h.echo.observe("Notch was kicked from the guild by Bridge!"), true);
  assert.deepEqual(h.settled, [{
    guildId: "g1",
    correlationId: "corr-1",
    outcome: "CONFIRMED_INGAME",
    detail: "Notch was kicked from the guild by Bridge!",
  }]);
});

test("colour codes do not hide the answer", async () => {
  // `mod-notice` anchors with `^…$` and does not strip `§`, so a coloured line
  // missed every pattern — which is to say, every real line from Hypixel.
  const h = harness();
  h.echo.watch("g1", "corr-1", "/g kick Notch spam");
  assert.equal(h.echo.observe("§cNotch§r was kicked from the guild by §aBridge§r!"), true);
  assert.equal(h.settled[0]?.outcome, "CONFIRMED_INGAME");
});

test("every known refusal settles the command as refused", async () => {
  const lines: readonly string[] = [
    "You must be the Guild Master to do that!",
    "You do not have permission to do that!",
    "Can't find a player by the name of 'Notchh'",
    "This player is not in your guild!",
    "You cannot kick yourself from the guild!",
    "You cannot mute yourself!",
    "You cannot mute a player with a higher rank!",
    "Invalid usage! '/guild kick <player> <reason>'",
    "Unknown command. Type /help for help.",
    "Notch is already muted!",
    "You are not in a guild!",
  ];
  // One assertion per table row, so a reworded entry cannot silently stop
  // matching while the suite stays green.
  assert.equal(lines.length, HYPIXEL_REFUSALS.length);
  for (const line of lines) {
    const h = harness();
    h.echo.watch("g1", "corr-1", "/g kick Notch spam");
    assert.equal(h.echo.observe(line), true, line);
    assert.equal(h.settled[0]?.outcome, "REFUSED_INGAME", line);
    assert.match(h.settled[0]?.detail ?? "", /Hypixel refused/);
  }
});

test("a line nobody recognises settles nothing", async () => {
  // The important half of best-effort. An unrecognised line must not turn a
  // kick that landed into a red case.
  const h = harness();
  h.echo.watch("g1", "corr-1", "/g kick Notch spam");
  assert.equal(h.echo.observe("Guild > Steve: anyone on?"), false);
  assert.equal(h.echo.observe("You are now AFK!"), false);
  assert.deepEqual(h.settled, []);
});

test("a window that ends quietly says nothing at all", async () => {
  // Not a refusal. The waiting publisher reports it as unconfirmed, which is a
  // PENDING case for the sweep, not a punishment declared failed.
  const h = harness(10_000);
  h.echo.watch("g1", "corr-1", "/g kick Notch spam");
  h.advance(11_000);
  assert.equal(h.echo.observe("Notch was kicked from the guild by Bridge!"), false);
  assert.deepEqual(h.settled, []);
});

test("a notice for somebody else does not settle our command", async () => {
  const h = harness();
  h.echo.watch("g1", "corr-1", "/g kick Notch spam");
  assert.equal(h.echo.observe("Steve was kicked from the guild by Alex!"), false);
  assert.deepEqual(h.settled, []);
});

test("a mute notice does not settle a pending kick", async () => {
  const h = harness();
  h.echo.watch("g1", "corr-1", "/g kick Notch spam");
  assert.equal(h.echo.observe("Alex has muted Notch for 30d"), false);
  assert.deepEqual(h.settled, []);
});

test("our own kick is claimed, so the mirror does not punish twice", async () => {
  // Without this a Discord ban relays a `/g kick`, reads its own notice back,
  // and mirrors it into a second case that kicks the member from Discord again.
  const h = harness();
  assert.equal(h.echo.claimedKick("Notch"), false);
  h.echo.watch("g1", "corr-1", "/g kick Notch Ban evasion");
  h.echo.observe("Notch was kicked from the guild by Bridge!");
  assert.equal(h.echo.claimedKick("notch"), true);
  h.advance(121_000);
  assert.equal(h.echo.claimedKick("Notch"), false);
});

test("a kick nobody here asked for is not claimed", async () => {
  // The whole point of the mirror: a staffer acting in game must still reach
  // Discord.
  const h = harness();
  h.echo.observe("Steve was kicked from the guild by Alex!");
  assert.equal(h.echo.claimedKick("Steve"), false);
});

test("only guild moderation verbs are watched", async () => {
  assert.deepEqual(parseCommandIntent("/g kick Notch Ban evasion"), { kind: "KICK", target: "notch" });
  assert.deepEqual(parseCommandIntent("/guild mute Notch 30m"), { kind: "MUTE", target: "notch" });
  assert.deepEqual(parseCommandIntent("/g unmute Notch"), { kind: "UNMUTE", target: "notch" });
  // A join answer reports through its own button; watching it would let an
  // unrelated refusal settle a punishment still in flight.
  assert.equal(parseCommandIntent("/guild accept Jack"), null);
  assert.equal(parseCommandIntent("/g online"), null);
  assert.equal(parseCommandIntent("hello"), null);
});
