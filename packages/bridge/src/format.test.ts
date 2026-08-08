/**
 * Relay formatting is the boundary where text typed by someone in Hypixel guild
 * chat becomes a Discord message, and vice versa. Both destinations read text as
 * more than text, so these are the tests that keep a chat line from becoming a
 * mass ping or a protocol violation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISCORD_MESSAGE_LIMIT,
  GAME_CHAT_LIMIT,
  defangMentions,
  flattenForGame,
  formatRelay,
  stripMinecraftColors,
  truncate,
} from "./format.js";

const toDiscord = (content: string): string =>
  formatRelay({
    guildId: "g1",
    direction: "GAME_TO_DISCORD",
    authorId: "Steve",
    authorName: "Steve",
    content,
  });

const toGame = (content: string, authorName = "Alice"): string =>
  formatRelay({
    guildId: "g1",
    direction: "DISCORD_TO_GAME",
    authorId: "1",
    authorName,
    content,
  });

// ── game → Discord: mention injection ──

test("an in-game player cannot mass-ping Discord with @everyone", () => {
  const out = toDiscord("hey @everyone look at this");
  assert.ok(!/(^|[^​])@everyone/.test(out), `still pingable: ${out}`);
  assert.ok(out.includes("everyone"), "the word should survive for the reader");
});

test("@here is defanged regardless of case", () => {
  for (const raw of ["@here", "@HERE", "@Here"]) {
    const out = toDiscord(raw);
    assert.ok(out.includes("​"), `not defanged: ${raw} → ${out}`);
  }
});

test("id-based role and user mentions are defanged, not just the mass pings", () => {
  // The original filter only matched @everyone/@here, so a raw role mention
  // typed in guild chat pinged the role.
  assert.ok(defangMentions("<@&123456>").includes("​"));
  assert.ok(defangMentions("<@123456>").includes("​"));
  assert.ok(defangMentions("<@!123456>").includes("​"));
});

test("ordinary text with an @ in it is left readable", () => {
  assert.equal(toDiscord("email me at steve@example.com"), "email me at steve@example.com");
});

test("Minecraft colour codes never reach Discord", () => {
  assert.equal(stripMinecraftColors("§ahello §cworld"), "hello world");
  assert.equal(toDiscord("§lBOLD"), "BOLD");
});

test("a game message is capped below Discord's own limit", () => {
  const out = toDiscord("x".repeat(5000));
  assert.ok(out.length <= DISCORD_MESSAGE_LIMIT, `length was ${out.length}`);
  assert.ok(out.endsWith("…"), "truncation should be visible");
});

// ── Discord → game: protocol safety ──

test("a relayed line always fits the Minecraft chat packet", () => {
  // The transport prepends "/gc ", so the formatted line plus that prefix is
  // what actually goes on the wire. Over 256 gets the bot kicked on 1.8.
  const out = toGame("y".repeat(5000));
  assert.ok(`/gc ${out}`.length <= GAME_CHAT_LIMIT, `packet was ${`/gc ${out}`.length}`);
});

test("a long author name cannot crowd out the whole message", () => {
  const out = toGame("the actual message", "A".repeat(200));
  assert.ok(`/gc ${out}`.length <= GAME_CHAT_LIMIT);
  assert.ok(out.startsWith("[D] "), `lost its tag: ${out}`);
});

test("newlines cannot split a relayed message into a second chat line", () => {
  // A second line would be read by the server as a fresh command, which is how
  // "/gc hi\n/kick someone" would work if whitespace were not collapsed.
  const out = toGame("hi\n/gc oops");
  assert.ok(!out.includes("\n"), `contains a newline: ${out}`);
});

test("control characters cannot smuggle a line break past the newline filter", () => {
  const out = toGame(`hi${String.fromCharCode(13)}${String.fromCharCode(0)}there`);
  for (const ch of out) {
    const code = ch.codePointAt(0) ?? 0;
    assert.ok(code >= 0x20 && code !== 0x7f, `control char survived: U+${code.toString(16)}`);
  }
});

test("the author name is tagged so an in-game player can tell a bridge apart", () => {
  assert.equal(toGame("hello", "Alice"), "[D] Alice: hello");
});

test("a Discord display name cannot spoof Minecraft formatting", () => {
  const out = toGame("hi", "§cAdmin");
  assert.ok(!out.includes("§"), `colour code survived: ${out}`);
});

// ── helpers ──

test("truncate leaves short strings untouched and marks long ones", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
});

test("flattenForGame strips Discord markdown that means nothing in chat", () => {
  assert.equal(flattenForGame("**bold** and `code`"), "bold and code");
});
