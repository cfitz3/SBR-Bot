import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findRepoRoot, loadRootEnv } from "./index.js";

test("findRepoRoot resolves the directory containing pnpm-workspace.yaml", () => {
  const root = findRepoRoot();
  assert.ok(existsSync(join(root, "pnpm-workspace.yaml")), "root should contain the workspace marker");
});

test("findRepoRoot is cwd-independent (deep start still finds root)", () => {
  const fromDeep = findRepoRoot(join(findRepoRoot(), "packages", "env", "src"));
  assert.equal(fromDeep, findRepoRoot());
});

test("loadRootEnv loads the root .env and is idempotent", () => {
  const first = loadRootEnv();
  const second = loadRootEnv();
  assert.ok(first.files.includes(".env"), "should load the base .env");
  assert.strictEqual(first, second, "second call returns the cached result");
  assert.ok(existsSync(join(first.root, ".env")));
});
