/**
 * The sink half of the logger: the part a Discord shipper hangs off. The console
 * half is exercised everywhere else in the suite by simply being used.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger, type LogRecord } from "./logger.js";

function collector() {
  const seen: LogRecord[] = [];
  return { seen, sink: (r: LogRecord) => void seen.push(r) };
}

test("the sink defaults to errors only, whatever the console level is", () => {
  const c = collector();
  const log = createLogger({ level: "error", name: "svc", sink: c.sink });

  log.warn("a warning");
  log.error("a failure");

  assert.deepEqual(
    c.seen.map((r) => r.msg),
    ["a failure"],
  );
});

test("the sink level is independent of the console level", () => {
  const c = collector();
  // Quiet console, chatty sink: the shape a production process actually runs in.
  const log = createLogger({ level: "error", name: "svc", sink: c.sink, sinkLevel: "warn" });

  log.info("not shipped");
  log.warn("shipped");

  assert.deepEqual(
    c.seen.map((r) => r.msg),
    ["shipped"],
  );
});

test("a child ships too, carrying its bound fields", () => {
  const c = collector();
  const log = createLogger({ level: "error", name: "svc", sink: c.sink, base: { region: "eu" } });

  log.child({ guildId: "g-1" }).error("child failure", { attempt: 2 });

  const record = c.seen[0];
  assert.ok(record);
  assert.equal(record.name, "svc");
  assert.equal(record.level, "error");
  assert.deepEqual(record.fields, { region: "eu", guildId: "g-1", attempt: 2 });
});

test("a sink that throws does not take the call site down", () => {
  const log = createLogger({
    level: "error",
    sink() {
      throw new Error("shipper exploded");
    },
  });

  assert.doesNotThrow(() => log.error("still logged"));
});

test("the record's fields are a copy, not the caller's object", () => {
  const c = collector();
  const log = createLogger({ level: "error", sink: c.sink });
  const fields = { attempt: 1 };

  log.error("first", fields);
  fields.attempt = 99;

  assert.equal(c.seen[0]?.fields["attempt"], 1);
});
