import assert from "node:assert/strict";
import { test } from "node:test";
import { redisConnection } from "./connection.js";

test("a plain local url is host and port and nothing else", () => {
  assert.deepEqual(redisConnection("redis://127.0.0.1:6379"), { host: "127.0.0.1", port: 6379 });
});

test("credentials survive the translation", () => {
  const c = redisConnection("redis://default:hunter2@cache.internal:6379");
  assert.equal(c.username, "default");
  assert.equal(c.password, "hunter2");
});

test("a percent-encoded password is decoded, not passed through encoded", () => {
  assert.equal(redisConnection("redis://:p%40ss%2Fword@host:6379").password, "p@ss/word");
});

test("rediss turns tls on and defaults to its own port", () => {
  const c = redisConnection("rediss://default:secret@managed.example.com");
  assert.deepEqual(c.tls, {});
  assert.equal(c.port, 6380);
});

test("a database in the path is carried across", () => {
  assert.equal(redisConnection("redis://host:6379/2").db, 2);
  assert.equal(redisConnection("redis://host:6379/").db, undefined, "database 0 is the default anyway");
  assert.equal(redisConnection("redis://host:6379/not-a-number").db, undefined);
});
