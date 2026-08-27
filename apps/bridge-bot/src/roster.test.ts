import assert from "node:assert/strict";
import { test } from "node:test";
import { isRosterEnd, parseGuildOnline, rosterMembers } from "./roster.js";

const AT = (): Date => new Date("2026-08-07T12:00:00.000Z");

const BLOCK = [
  "§b-----------------------------------------------------",
  "§eGuild Name: SBR",
  "",
  "§6-- Guild Master --",
  "§aNotch §r§a●",
  "",
  "§6-- Officer --",
  "§a[MVP+] Steve §r§a●§r §aAlex §r§a●",
  "",
  "§b-- Member --",
  "§aAria §a●§r §aBex §a●§r §aCyd §a●",
  "",
  "§bTotal Members: §a125",
  "§bOnline Members: §a6",
  "§b-----------------------------------------------------",
];

test("reads ranks, members and counts out of a /g online block", () => {
  const roster = parseGuildOnline(BLOCK, AT);
  assert.ok(roster);
  assert.equal(roster.guildName, "SBR");
  assert.equal(roster.online, 6);
  assert.equal(roster.total, 125);
  assert.deepEqual(roster.ranks, [
    { rank: "Guild Master", members: ["Notch"] },
    { rank: "Officer", members: ["Steve", "Alex"] },
    { rank: "Member", members: ["Aria", "Bex", "Cyd"] },
  ]);
  assert.equal(roster.fetchedAt, "2026-08-07T12:00:00.000Z");
});

test("strips Hypixel rank tags rather than reading them as names", () => {
  const roster = parseGuildOnline(["-- Member --", "[MVP++] Steve ●  [VIP] Alex ●"], AT);
  assert.deepEqual(rosterMembers(roster!), ["Steve", "Alex"]);
});

test("ignores guild chat that lands in the capture window", () => {
  const roster = parseGuildOnline(
    ["Guild Name: SBR", "Guild > Someone: anyone for f7?", "-- Member --", "Aria ●", "Online Members: 1"],
    AT,
  );
  assert.deepEqual(rosterMembers(roster!), ["Aria"]);
  assert.equal(roster!.online, 1);
});

test("drops rank sections nobody is online in", () => {
  const roster = parseGuildOnline(["-- Guild Master --", "-- Member --", "Aria ●", "Online Members: 1"], AT);
  assert.deepEqual(
    roster!.ranks.map((r) => r.rank),
    ["Member"],
  );
});

test("returns null when the capture held nothing resembling a roster", () => {
  assert.equal(parseGuildOnline(["Guild > Steve: hi", "Guild > Alex: hello"], AT), null);
  assert.equal(parseGuildOnline([], AT), null);
});

test("survives a block with the counts but no ranks parsed", () => {
  const roster = parseGuildOnline(["Online Members: 0", "Total Members: 12"], AT);
  assert.deepEqual(roster, {
    guildName: null,
    ranks: [],
    online: 0,
    total: 12,
    fetchedAt: "2026-08-07T12:00:00.000Z",
  });
});

test("recognises the closing line so collection can stop early", () => {
  assert.equal(isRosterEnd("§bOnline Members: §a6"), true);
  assert.equal(isRosterEnd("§bTotal Members: §a125"), false);
  assert.equal(isRosterEnd("Guild > Steve: online members: 6"), false);
});

test("every member on a rank line is read, not just the first", () => {
  // The bug: Hypixel separates members with whitespace, and the parser split on
  // commas and took one name per chunk. `/online` reported a guild of four
  // while its own headline count — read from Hypixel's line — said forty.
  const roster = parseGuildOnline(
    ["-- Member --", "§aAria §a● §aBex §a● §aCyd §a● §aDot §a●", "Online Members: 4"],
    AT,
  );
  assert.deepEqual(rosterMembers(roster!), ["Aria", "Bex", "Cyd", "Dot"]);
  assert.equal(roster!.online, 4, "and the count and the list finally agree");
});

test("a comma-separated line still parses, in case the format moves back", () => {
  const roster = parseGuildOnline(["-- Member --", "Aria ●, Bex ●, Cyd ●"], AT);
  assert.deepEqual(rosterMembers(roster!), ["Aria", "Bex", "Cyd"]);
});

test("chat inside a rank section is not read as a roomful of members", () => {
  // Widening the name scan without this guard turns one sentence into a dozen
  // members, which is a worse failure than the one being fixed.
  const roster = parseGuildOnline(
    ["-- Member --", "Aria ●", "Guild > Bex: anyone want to do f7 right now", "Online Members: 1"],
    AT,
  );
  assert.deepEqual(rosterMembers(roster!), ["Aria"]);
});
