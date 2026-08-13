/**
 * The launcher scripts run before anything is built, so they sit outside the
 * TypeScript workspaces and their tests run directly on source. What is worth
 * asserting here is narrow but high-stakes: `scaffoldEnv` rewrites the file
 * holding the operator's live Discord tokens, Hypixel key and Minecraft
 * account, and those values exist nowhere else.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { isConfigured, parseEnv, scaffoldEnv, writeEnvFile } from "./lib.mjs";

const dirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "sbr-env-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** Lay down an .env.example (and optionally an .env) in a scratch directory. */
function fixture(example, existing) {
  const dir = scratch();
  const examplePath = join(dir, ".env.example");
  const envPath = join(dir, ".env");
  writeFileSync(examplePath, example);
  if (existing !== undefined) writeFileSync(envPath, existing);
  return { envPath, examplePath, read: () => readFileSync(envPath, "utf8") };
}

// ── parsing ──

test("parseEnv keeps values that contain the delimiter", () => {
  // A Postgres URL has an '=' in its query string and a ':' in its credentials.
  const env = parseEnv("DATABASE_URL=postgres://u:p@localhost:5432/db?schema=public");
  assert.equal(env.get("DATABASE_URL"), "postgres://u:p@localhost:5432/db?schema=public");
});

test("parseEnv strips surrounding quotes but not inner ones", () => {
  const env = parseEnv(`A="quoted"\nB='single'\nC=say "hi"`);
  assert.equal(env.get("A"), "quoted");
  assert.equal(env.get("B"), "single");
  assert.equal(env.get("C"), 'say "hi"');
});

test("parseEnv ignores comments and blank lines", () => {
  const env = parseEnv("# comment\n\nA=1\n  # indented\nB=2\n");
  assert.deepEqual([...env.keys()], ["A", "B"]);
});

test("placeholder values do not count as configured", () => {
  assert.equal(isConfigured("your_hypixel_api_key_here"), false);
  assert.equal(isConfigured("change_me_please"), false);
  assert.equal(isConfigured(""), false);
  assert.equal(isConfigured(undefined), false);
  assert.equal(isConfigured("a-real-looking-token"), true);
});

// ── scaffolding ──

test("an existing value is never overwritten by the template", () => {
  // The whole contract of re-running setup: it resyncs structure, not content.
  const f = fixture("HYPIXEL_API_KEY=your_key_here\n", "HYPIXEL_API_KEY=real-key-abc\nSESSION_SECRET=" + "a".repeat(64) + "\n");
  scaffoldEnv(f.envPath, f.examplePath);
  assert.equal(parseEnv(f.read()).get("HYPIXEL_API_KEY"), "real-key-abc");
});

test("a placeholder SESSION_SECRET is replaced with a real random one", () => {
  const f = fixture("SESSION_SECRET=change_me\n", "SESSION_SECRET=change_me\n");
  const result = scaffoldEnv(f.envPath, f.examplePath);

  assert.equal(result.generatedSecret, true);
  const secret = parseEnv(f.read()).get("SESSION_SECRET");
  assert.ok(secret.length >= 32, `secret was only ${secret.length} chars`);
  assert.ok(isConfigured(secret));
});

test("a real SESSION_SECRET survives a re-run", () => {
  const mine = "b".repeat(64);
  const f = fixture("SESSION_SECRET=change_me\n", `SESSION_SECRET=${mine}\n`);
  const result = scaffoldEnv(f.envPath, f.examplePath);

  assert.equal(result.generatedSecret, false);
  assert.equal(parseEnv(f.read()).get("SESSION_SECRET"), mine);
});

test("keys added to the template since install are appended", () => {
  const f = fixture("OLD=1\nNEW_FEATURE_FLAG=off\n", "OLD=1\n");
  const result = scaffoldEnv(f.envPath, f.examplePath);

  assert.deepEqual(result.addedKeys, ["NEW_FEATURE_FLAG"]);
  assert.equal(parseEnv(f.read()).get("NEW_FEATURE_FLAG"), "off");
  assert.equal(parseEnv(f.read()).get("OLD"), "1", "the existing key should be untouched");
});

test("a missing INTERNAL_API_TOKEN is generated, not left empty", () => {
  // An empty token silently disables the panel's whole Discord directory —
  // pickers, member lookup and the member scan — so setup fills it in rather
  // than asking a human for a shared secret with no counterpart to match.
  const f = fixture("INTERNAL_API_TOKEN=\n", "INTERNAL_API_TOKEN=\n");
  const result = scaffoldEnv(f.envPath, f.examplePath);

  assert.ok(result.generated.includes("INTERNAL_API_TOKEN"));
  const token = parseEnv(f.read()).get("INTERNAL_API_TOKEN");
  assert.ok(token.length >= 32, `token was only ${token.length} chars`);
});

test("an existing INTERNAL_API_TOKEN survives a re-run", () => {
  const mine = "d".repeat(64);
  const f = fixture("INTERNAL_API_TOKEN=\n", `INTERNAL_API_TOKEN=${mine}\n`);
  scaffoldEnv(f.envPath, f.examplePath);
  assert.equal(parseEnv(f.read()).get("INTERNAL_API_TOKEN"), mine);
});

test("a no-op re-run does not rewrite the file at all", () => {
  const settled = `A=1\nSESSION_SECRET=${"c".repeat(64)}\nINTERNAL_API_TOKEN=${"d".repeat(64)}\n`;
  const f = fixture("A=1\nSESSION_SECRET=x\nINTERNAL_API_TOKEN=\n", settled);
  const before = statSync(f.envPath).mtimeMs;
  const result = scaffoldEnv(f.envPath, f.examplePath);

  assert.deepEqual(
    { created: result.created, generatedSecret: result.generatedSecret, added: result.addedKeys.length },
    { created: false, generatedSecret: false, added: 0 },
  );
  assert.equal(statSync(f.envPath).mtimeMs, before, "an idempotent run should not touch the file");
});

test("a missing template is reported rather than silently skipped", () => {
  const dir = scratch();
  assert.throws(() => scaffoldEnv(join(dir, ".env"), join(dir, ".env.example")), /\.env\.example not found/);
});

// ── the write itself ──

test("writeEnvFile leaves no temp file behind", () => {
  const dir = scratch();
  const envPath = join(dir, ".env");
  writeEnvFile(envPath, "A=1\n");
  assert.equal(readFileSync(envPath, "utf8"), "A=1\n");
  assert.throws(() => statSync(`${envPath}.${process.pid}.tmp`), /ENOENT/);
});

test("the written .env is not readable by other users", { skip: process.platform === "win32" }, () => {
  const dir = scratch();
  const envPath = join(dir, ".env");
  writeEnvFile(envPath, "DISCORD_BRIDGE_TOKEN=secret\n");
  // 0o777 masks off the file-type bits; group and other must both be empty.
  assert.equal(statSync(envPath).mode & 0o077, 0, "secrets file is group/world accessible");
});
