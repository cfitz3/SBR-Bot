import assert from "node:assert/strict";
import test from "node:test";
import { compileTag, compileTags, findTag, matchTag } from "./tags.js";
import { tag } from "./fixtures.test.js";

test("a tag with no pattern compiles to no pattern and no problem", () => {
  assert.deepEqual(compileTag(tag({ autoPattern: null })), {
    tag: tag({ autoPattern: null }),
    pattern: null,
    problem: null,
  });
  assert.equal(compileTag(tag({ autoPattern: "   " })).problem, null);
});

test("a pattern is case-insensitive and anchors per line", () => {
  const compiled = compileTag(tag({ autoPattern: "^how do i link" }));
  assert.notEqual(compiled.pattern, null);
  assert.equal(compiled.pattern?.test("HOW DO I LINK my account"), true);
  assert.equal(compiled.pattern?.test("hello\nhow do i link"), true);
});

test("a broken pattern is reported, not silently skipped", () => {
  const compiled = compileTag(tag({ autoPattern: "([unclosed" }));
  assert.equal(compiled.pattern, null);
  assert.match(compiled.problem ?? "", /not a valid expression/);
});

test("a pattern that could hang the message path is refused", () => {
  for (const pattern of ["(a+)+", "(.*)*", "(x|y+)+"]) {
    const compiled = compileTag(tag({ autoPattern: pattern }));
    assert.equal(compiled.pattern, null, `${pattern} should not compile`);
    assert.match(compiled.problem ?? "", /could hang/);
  }
});

test("an absurdly long pattern is refused before it is compiled", () => {
  const compiled = compileTag(tag({ autoPattern: "a".repeat(301) }));
  assert.equal(compiled.pattern, null);
  assert.match(compiled.problem ?? "", /too long/);
  assert.equal(compileTag(tag({ autoPattern: "a".repeat(300) })).problem, null);
});

test("the first matching enabled tag wins — one question, one answer", () => {
  const compiled = compileTags([
    tag({ id: "1", name: "Link", autoPattern: "link" }),
    tag({ id: "2", name: "Linking", autoPattern: "link" }),
  ]);
  assert.equal(matchTag(compiled, "how do i link?")?.id, "1");
});

test("a disabled or uncompilable tag never fires", () => {
  const compiled = compileTags([
    tag({ id: "1", name: "Off", autoPattern: "link", enabled: false }),
    tag({ id: "2", name: "Broken", autoPattern: "([" }),
    tag({ id: "3", name: "Good", autoPattern: "link" }),
  ]);
  assert.equal(matchTag(compiled, "link")?.id, "3");
  assert.equal(matchTag(compiled, "nothing here"), null);
});

test("findTag is case-insensitive and forgives surrounding space", () => {
  const tags = [tag({ id: "1", name: "Welcome" }), tag({ id: "2", name: "Rules" })];
  assert.equal(findTag(tags, "welcome")?.id, "1");
  assert.equal(findTag(tags, "  RULES ")?.id, "2");
  assert.equal(findTag(tags, "missing"), null);
});

test("scope decides where a pattern may fire on its own", () => {
  const compiled = compileTags([
    tag({ id: "t", name: "Ticket", autoPattern: "link", scope: "TICKET" }),
    tag({ id: "s", name: "Server", autoPattern: "link", scope: "SERVER" }),
  ]);

  // The default is where the feature started: a ticket channel.
  assert.equal(matchTag(compiled, "link")?.id, "t");
  assert.equal(matchTag(compiled, "link", "TICKET")?.id, "t");
  assert.equal(matchTag(compiled, "link", "SERVER")?.id, "s");
});

test("an ANY tag answers in both places", () => {
  const compiled = compileTags([tag({ id: "a", autoPattern: "link", scope: "ANY" })]);
  assert.equal(matchTag(compiled, "link", "TICKET")?.id, "a");
  assert.equal(matchTag(compiled, "link", "SERVER")?.id, "a");
});

test("findTag ignores scope — asking for a tag by name is always deliberate", () => {
  const tags = [tag({ id: "1", name: "Welcome", scope: "TICKET" })];
  assert.equal(findTag(tags, "welcome")?.id, "1");
});
