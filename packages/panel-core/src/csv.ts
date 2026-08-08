/**
 * CSV serialization for the analytics export (WEB_PANEL.md §4).
 *
 * Hand-rolled because the requirements are small and the two that matter are
 * easy to get wrong by reaching for `rows.join(",")`: quoting, and the fact that
 * this file is going to be opened in Excel or Sheets.
 */
import type { CommandUsageStat, RollupPoint } from "./reads.js";

/** RFC 4180 line ending — Excel is the target reader, and it wants CRLF. */
const EOL = "\r\n";

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than
 * text. A command named `=cmd` or a dimension value starting with `+` would
 * otherwise be evaluated on open, which is the CSV-injection problem.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);

  // Prefixing with an apostrophe is the conventional fix and survives a
  // round-trip through a spreadsheet as visible text.
  if (FORMULA_LEAD.test(text)) text = `'${text}`;

  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  // Trailing newline: a file whose last line has no terminator trips some
  // parsers into dropping or merging the final record.
  return lines.join(EOL) + EOL;
}

/**
 * Rollup rows, one line per (metric, bucket, dimension set).
 *
 * `dims` is exported as JSON rather than flattened into columns: the dimension
 * keys differ per metric, so flattening would produce a sparse table whose
 * column set changes with the query.
 */
export function rollupsToCsv(rollups: readonly RollupPoint[]): string {
  return toCsv(
    ["metric", "bucket_start", "count", "dimensions"],
    rollups.map((r) => [r.metric, r.bucketStart, r.count, JSON.stringify(r.dims ?? {})]),
  );
}

export function commandStatsToCsv(stats: readonly CommandUsageStat[]): string {
  return toCsv(
    ["command", "uses", "successes", "failures", "avg_latency_ms"],
    stats.map((s) => [s.command, s.count, s.successCount, s.count - s.successCount, s.avgLatencyMs]),
  );
}
