import assert from "node:assert/strict";
import { test } from "node:test";

import { deepFreeze, deepMerge, makeScope } from "./merge.js";

test("an override wins for the key it names and only that key", () => {
  const base = { panel: { members: { title: "Members", subtitle: "Everyone." } } };
  const merged = deepMerge(base, { panel: { members: { title: "Roster" } } });

  assert.equal(merged.panel.members.title, "Roster");
  assert.equal(merged.panel.members.subtitle, "Everyone.");
});

test("an empty override changes nothing", () => {
  const base = { a: { b: "c" } };
  assert.deepEqual(deepMerge(base, {}), base);
  assert.deepEqual(deepMerge(base, undefined), base);
});

test("an explicit undefined means absent, not blank", () => {
  // `exactOptionalPropertyTypes` means an override file cannot spell this in the
  // first place — hence the cast. The runtime guard stays because the merge also
  // runs over values that reached it some other way, and a `undefined` that
  // blanked its default would erase a string rather than leave it alone.
  const override = { title: undefined } as unknown as { readonly title?: string };
  const merged = deepMerge({ title: "Members" }, override);
  assert.equal(merged.title, "Members");
});

test("arrays replace rather than concatenate", () => {
  // A merged font stack — "my list, then yours appended" — is never what anybody
  // meant, and there is no sensible answer for order or duplicates.
  const merged = deepMerge({ stack: ["Inter", "system-ui"] }, { stack: ["Comic Sans"] });
  assert.deepEqual(merged.stack, ["Comic Sans"]);
});

test("numbers and other non-objects are replaced whole", () => {
  const merged = deepMerge({ embed: { fields: 12, inlineRow: 3 } }, { embed: { fields: 6 } });
  assert.equal(merged.embed.fields, 6);
  assert.equal(merged.embed.inlineRow, 3);
});

test("the resolved tree is frozen all the way down", () => {
  const frozen = deepFreeze({ panel: { nav: { overview: "Overview" } } });

  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.panel));
  assert.ok(Object.isFrozen(frozen.panel.nav));
  assert.throws(() => {
    // A page that "just tweaked" a label in place would otherwise change it for
    // every other reader in the process, and the bug would surface elsewhere.
    (frozen.panel.nav as { overview: string }).overview = "Home";
  }, TypeError);
});

test("scope reads one subtree by key", () => {
  const root = { panel: { members: { title: "Members", subtitle: "Everyone." } } };
  const scope = makeScope(root);
  const t = scope("panel.members");

  assert.equal(t("title"), "Members");
  assert.equal(t("subtitle"), "Everyone.");
});

test("scope on a path that resolves to nothing answers undefined rather than throwing", () => {
  // The compiler rejects an unknown path — `Get<Root, P>` is `never`, which makes
  // the argument unassignable. This covers the runtime edge that survives a cast:
  // a reader is still returned, so a stale call site degrades to a missing string
  // rather than taking down the page that rendered it.
  const scope = makeScope({ panel: {} });
  const t = (scope as unknown as (p: string) => (k: string) => unknown)("panel.nope");

  assert.equal(t("title"), undefined);
});
