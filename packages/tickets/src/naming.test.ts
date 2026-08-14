import assert from "node:assert/strict";
import test from "node:test";
import { PLACEHOLDERS, UNKNOWN, channelName, expand, humanDuration, type NamingContext } from "./naming.js";

function ctx(over: Partial<NamingContext> = {}): NamingContext {
  return {
    number: 42,
    username: "Ada",
    nickname: "Ada L",
    avgRating: null,
    avgResponseTimeMs: null,
    avgResolutionTimeMs: null,
    ...over,
  };
}

test("every documented placeholder expands", () => {
  const c = ctx({ avgRating: 4.25, avgResponseTimeMs: 180_000, avgResolutionTimeMs: 7_200_000 });
  const expanded = expand(PLACEHOLDERS.map((p) => `{${p}}`).join("|"), c);
  assert.equal(expanded, ["42", "42", "Ada", "Ada", "Ada L", "Ada L", "4.3", "3m", "2h"].join("|"));
  // Nothing was left unexpanded.
  assert.ok(!expanded.includes("{"));
});

test("an unknown placeholder is left visible rather than blanked", () => {
  assert.equal(expand("ticket-{num}-{nope}", ctx()), "ticket-42-{nope}");
});

test("a statistic with no data renders as an em dash, never as zero", () => {
  const out = expand("{avgRating} {avgResponseTime} {avgResolutionTime}", ctx());
  assert.equal(out, `${UNKNOWN} ${UNKNOWN} ${UNKNOWN}`);
  assert.ok(!out.includes("0"));
});

test("humanDuration coarsens and refuses nonsense", () => {
  assert.equal(humanDuration(0), "0s");
  assert.equal(humanDuration(45_000), "45s");
  assert.equal(humanDuration(90_000), "2m");
  assert.equal(humanDuration(3 * 3600_000), "3h");
  assert.equal(humanDuration(5 * 24 * 3600_000), "5d");
  assert.equal(humanDuration(null), UNKNOWN);
  assert.equal(humanDuration(-1), UNKNOWN);
  assert.equal(humanDuration(Number.NaN), UNKNOWN);
});

test("channelName lowercases, strips and collapses", () => {
  assert.equal(channelName("ticket-{num}", ctx()), "ticket-42");
  assert.equal(channelName("{name}'s Ticket", ctx({ username: "Ada Lovelace" })), "ada-lovelaces-ticket");
  assert.equal(channelName("  ---{nick}---  ", ctx({ nickname: "Ada" })), "ada");
  assert.equal(channelName("🎫 {num} 🎫", ctx()), "42");
});

test("a template that reduces to nothing falls back to ticket-<num>", () => {
  assert.equal(channelName("🎫🎫🎫", ctx({ number: 7 })), "ticket-7");
  assert.equal(channelName("", ctx({ number: 7 })), "ticket-7");
});

test("the name is clipped to Discord's 100 characters without a trailing dash", () => {
  const name = channelName(`${"a".repeat(99)}-bbbb`, ctx());
  assert.ok(name.length <= 100, `expected a clipped name, got ${name.length} characters`);
  assert.ok(!name.endsWith("-"));
  assert.equal(name, "a".repeat(99));
});
