import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { contentTypeFor, resolveAsset } from "./static.js";

/**
 * Built from the real cwd rather than a hardcoded `file:///srv/...`, because
 * `fileURLToPath` rejects a drive-letter-less path on Windows — which is where
 * this repo is developed. The directory need not exist; resolution is pure.
 */
const ROOT = new URL("public/", pathToFileURL(join(process.cwd(), "/")));

test("serves the shell at the root path", () => {
  const asset = resolveAsset("/", ROOT);
  assert.equal(asset?.contentType, "text/html; charset=utf-8");
  assert.match(asset?.filePath ?? "", /index\.html$/);
});

test("serves compiled client modules and stylesheets", () => {
  assert.equal(resolveAsset("/app/main.js", ROOT)?.contentType, "text/javascript; charset=utf-8");
  assert.equal(resolveAsset("/app.css", ROOT)?.contentType, "text/css; charset=utf-8");
});

test("refuses paths that escape the asset root", () => {
  assert.equal(resolveAsset("/../src/server.js", ROOT), null);
  assert.equal(resolveAsset("/app/../../.env", ROOT), null);
  // Encoded traversal must fail for the same reason, not slip past a literal
  // ".." check.
  assert.equal(resolveAsset("/%2e%2e/%2e%2e/package.json", ROOT), null);
});

test("refuses absolute and protocol-relative paths", () => {
  assert.equal(resolveAsset("//evil.example/app.js", ROOT), null);
  assert.equal(resolveAsset("/file:///etc/passwd", ROOT), null);
});

test("refuses extensions the panel does not ship", () => {
  assert.equal(resolveAsset("/.env", ROOT), null);
  assert.equal(resolveAsset("/app/main.ts", ROOT), null);
  assert.equal(resolveAsset("/app/main", ROOT), null);
});

test("refuses compiled client tests, which are build output rather than app", () => {
  assert.equal(resolveAsset("/app/format.test.js", ROOT), null);
  // The module they cover is still served.
  assert.ok(resolveAsset("/app/format.js", ROOT));
});

test("refuses malformed percent-encoding and NUL bytes", () => {
  assert.equal(resolveAsset("/%zz", ROOT), null);
  assert.equal(resolveAsset("/app%00.js", ROOT), null);
});

test("contentTypeFor is extension-driven and case-insensitive", () => {
  assert.equal(contentTypeFor("APP.CSS"), "text/css; charset=utf-8");
  assert.equal(contentTypeFor("noextension"), null);
});
