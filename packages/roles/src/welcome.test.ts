import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WELCOME,
  MAX_TEMPLATE_LENGTH,
  parseWelcome,
  renderTemplate,
  tokensUsed,
  validateWelcome,
} from "./welcome.js";

test("every known token is substituted", () => {
  const out = renderTemplate("{user} {username} {server} {memberCount} {ign} {guildRank} {level}", {
    user: "<@1>",
    username: "ash",
    server: "SBR",
    memberCount: "214",
    ign: "AshPlays",
    guildRank: "Officer",
    level: "31",
  });
  assert.equal(out, "<@1> ash SBR 214 AshPlays Officer 31");
});

test("an unknown token renders literally rather than vanishing", () => {
  // Vanishing is the failure mode that looks like the feature being broken;
  // a literal `{membercount}` in the channel tells the admin exactly what to fix.
  assert.equal(renderTemplate("hi {membercount}", { memberCount: "9" }), "hi {membercount}");
});

test("a token with no value renders as nothing, not as the token", () => {
  assert.equal(renderTemplate("welcome {user}{ign}", { user: "<@1>" }), "welcome <@1>");
});

test("@everyone and @here cannot escape through the template", () => {
  const out = renderTemplate("hey @everyone and @here", {});
  assert.ok(!/@everyone/.test(out), "everyone was neutered");
  assert.ok(!/@here/.test(out), "here was neutered");
  assert.ok(out.includes("everyone") && out.includes("here"), "the words still read normally");
});

test("@everyone cannot escape through a token value either", () => {
  // A nickname is attacker-controlled in a way the template is not.
  const out = renderTemplate("welcome {username}", { username: "@everyone" });
  assert.ok(!/@everyone/.test(out));
});

test("a token-shaped value is not expanded a second time", () => {
  const out = renderTemplate("hi {username}", { username: "{server}", server: "SBR" });
  assert.equal(out, "hi {server}");
});

test("tokensUsed reports only the real ones", () => {
  assert.deepEqual([...tokensUsed("{user} {nope} {level}")].sort(), ["level", "user"]);
});

test("an unreadable blob parses to the defaults rather than throwing", () => {
  assert.deepEqual(parseWelcome("not an object"), DEFAULT_WELCOME);
  assert.deepEqual(parseWelcome(null), DEFAULT_WELCOME);
  assert.deepEqual(parseWelcome({ join: 7 }), DEFAULT_WELCOME);
});

test("a future version keeps the fields it understands", () => {
  const policy = parseWelcome({ version: 99, join: { enabled: true, text: "hi" }, unknownSection: {} });
  assert.equal(policy.join.enabled, true);
  assert.equal(policy.join.text, "hi");
});

test("a nonsense mode falls back rather than reaching Discord", () => {
  assert.equal(parseWelcome({ join: { mode: "SHOUT" } }).join.mode, DEFAULT_WELCOME.join.mode);
});

test("an empty DM string is null, not an empty message", () => {
  assert.equal(parseWelcome({ join: { dm: "   " } }).join.dm, null);
  assert.equal(parseWelcome({ join: { dm: "hello" } }).join.dm, "hello");
});

test("a too-eager delete timer is dropped rather than posting invisibly", () => {
  assert.equal(parseWelcome({ join: { deleteAfterSeconds: 0 } }).join.deleteAfterSeconds, null);
  assert.equal(parseWelcome({ join: { deleteAfterSeconds: 30 } }).join.deleteAfterSeconds, 30);
});

test("overlong text is truncated on read rather than rejected", () => {
  const long = "x".repeat(MAX_TEMPLATE_LENGTH + 500);
  assert.equal(parseWelcome({ join: { text: long } }).join.text.length, MAX_TEMPLATE_LENGTH);
});

test("a valid blob validates", () => {
  assert.equal(
    validateWelcome({
      version: 1,
      join: { enabled: true, channelSlot: "welcome", mode: "EMBED", text: "hi {user}", dm: null, deleteAfterSeconds: null },
      leave: { enabled: false, channelSlot: "welcome", text: "{username} left." },
    }),
    null,
  );
});

test("a misspelled field is refused instead of silently defaulting", () => {
  const problem = validateWelcome({ join: { chanelSlot: "welcome" } });
  assert.ok(problem?.includes("chanelSlot"), problem ?? "no problem reported");
});

test("an unknown section is refused", () => {
  assert.ok(validateWelcome({ farewell: {} })?.includes("farewell"));
});

test("an unknown token is named at save time, with the list of real ones", () => {
  const problem = validateWelcome({ join: { text: "hi {membercount}" } });
  assert.ok(problem?.includes("{membercount}"), problem ?? "no problem reported");
  assert.ok(problem?.includes("{memberCount}"), "the correct spelling is offered");
});

test("switching a section on with nothing to say is refused", () => {
  assert.ok(validateWelcome({ join: { enabled: true, text: "   " } })?.includes("no message"));
});

test("a delete timer outside the sane range is refused with the range", () => {
  const problem = validateWelcome({ join: { deleteAfterSeconds: 1 } });
  assert.ok(problem?.includes("86400"), problem ?? "no problem reported");
});

test("a non-object is refused rather than parsed", () => {
  assert.ok(validateWelcome([]) !== null);
  assert.ok(validateWelcome("nope") !== null);
});

test("every validation message is a sentence an admin can act on", () => {
  const problems = [
    validateWelcome([]),
    validateWelcome({ farewell: {} }),
    validateWelcome({ join: { text: "{nope}" } }),
    validateWelcome({ join: { enabled: true, text: "" } }),
    validateWelcome({ join: { mode: "SHOUT" } }),
  ];
  for (const problem of problems) {
    assert.ok(problem !== null && problem.length > 15 && problem.endsWith("."), problem ?? "missing");
  }
});
