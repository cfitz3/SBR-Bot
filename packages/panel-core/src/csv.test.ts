import assert from "node:assert/strict";
import { test } from "node:test";
import { commandStatsToCsv, csvCell, rollupsToCsv, toCsv } from "./csv.js";

test("plain values pass through unquoted", () => {
  assert.equal(csvCell("stats"), "stats");
  assert.equal(csvCell(42), "42");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});

test("separators, quotes, and newlines are quoted and escaped", () => {
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
});

/**
 * This export is opened in Excel or Sheets. A cell beginning with `=` is
 * evaluated as a formula there, so anything that could carry a user-supplied
 * string has to be neutralised on the way out.
 */
test("cells that a spreadsheet would evaluate as formulas are neutralised", () => {
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+cmd"), "'+cmd");
  assert.equal(csvCell("-cmd"), "'-cmd");
  assert.equal(csvCell("@cmd"), "'@cmd");
  // A negative number is still a formula lead by this rule; quoting it as text
  // is the safe direction, and no numeric column here carries one.
  assert.equal(csvCell(-3), "'-3");
});

test("rows are CRLF-terminated including the last", () => {
  const csv = toCsv(["a", "b"], [[1, 2]]);
  assert.equal(csv, "a,b\r\n1,2\r\n");
});

test("rollup rows carry their dimensions as JSON", () => {
  const csv = rollupsToCsv([
    { metric: "command.used", bucketStart: "2026-08-01T00:00:00.000Z", count: 5, dims: { command: "stats" } },
  ]);
  assert.equal(
    csv,
    "metric,bucket_start,count,dimensions\r\n" +
      'command.used,2026-08-01T00:00:00.000Z,5,"{""command"":""stats""}"\r\n',
  );
});

test("command stats derive the failure count the table doesn't store", () => {
  const csv = commandStatsToCsv([{ command: "stats", count: 10, successCount: 8, avgLatencyMs: 120 }]);
  assert.match(csv, /^command,uses,successes,failures,avg_latency_ms\r\n/);
  assert.match(csv, /\r\nstats,10,8,2,120\r\n$/);
});

test("a null latency exports as empty rather than the string 'null'", () => {
  const csv = commandStatsToCsv([{ command: "nw", count: 1, successCount: 1, avgLatencyMs: null }]);
  assert.match(csv, /\r\nnw,1,1,0,\r\n$/);
});
