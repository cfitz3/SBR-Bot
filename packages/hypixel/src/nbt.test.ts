import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { decodeItemBytes } from "./nbt.js";

// ── A tiny NBT writer, so the fixtures are the real binary format ──
// Hand-building the bytes is the point: a fixture produced by the same
// assumptions as the reader would pass even if both were wrong.

const buf = (...parts: Buffer[]): Buffer => Buffer.concat(parts);
const u8 = (v: number): Buffer => Buffer.from([v]);
const i32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
};
const name = (s: string): Buffer => {
  const body = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length);
  return buf(len, body);
};
const tagString = (key: string, value: string): Buffer => buf(u8(8), name(key), name(value));
const tagByte = (key: string, value: number): Buffer => buf(u8(1), name(key), u8(value));
const tagCompound = (key: string, ...children: Buffer[]): Buffer =>
  buf(u8(10), name(key), ...children, u8(0));
const tagList = (key: string, itemType: number, ...items: Buffer[]): Buffer =>
  buf(u8(9), name(key), u8(itemType), i32(items.length), ...items);
/** A compound as a *list element*: no tag byte, no name. */
const compoundBody = (...children: Buffer[]): Buffer => buf(...children, u8(0));

const root = (...children: Buffer[]): string =>
  gzipSync(buf(u8(10), name(""), ...children, u8(0))).toString("base64");

test("the Skyblock id wins over the vanilla material id", () => {
  const blob = root(
    tagList(
      "i",
      10,
      compoundBody(
        tagString("id", "minecraft:diamond_sword"),
        tagByte("Count", 1),
        tagCompound("tag", tagCompound("ExtraAttributes", tagString("id", "HYPERION"))),
      ),
    ),
  );

  assert.equal(decodeItemBytes(blob)?.itemId, "HYPERION");
});

test("a display name is read and stripped of colour codes", () => {
  const blob = root(
    tagList(
      "i",
      10,
      compoundBody(
        tagByte("Count", 1),
        tagCompound("tag", tagCompound("display", tagString("Name", "§dHeroic Hyperion §6✪"))),
        tagCompound("tag2", tagCompound("ExtraAttributes", tagString("id", "HYPERION"))),
      ),
    ),
  );

  assert.equal(decodeItemBytes(blob)?.itemName, "Heroic Hyperion ✪");
});

test("stack size is carried through so a bulk sale can be priced per unit", () => {
  const blob = root(
    tagList("i", 10, compoundBody(tagByte("Count", 64), tagString("id", "ENCHANTED_DIAMOND"))),
  );
  assert.equal(decodeItemBytes(blob)?.count, 64);
});

test("an item with no identifying fields at all decodes to null", () => {
  const blob = root(tagList("i", 10, compoundBody(tagByte("Count", 1))));
  assert.equal(decodeItemBytes(blob), null);
});

test("garbage decodes to null rather than throwing and sinking the sweep", () => {
  assert.equal(decodeItemBytes("not base64 gzip at all"), null);
  assert.equal(decodeItemBytes(""), null);
  assert.equal(decodeItemBytes(gzipSync(Buffer.from("plain text")).toString("base64")), null);
});

test("an unknown tag type is rejected instead of read as something else", () => {
  const blob = gzipSync(buf(u8(10), name(""), u8(99), name("weird"))).toString("base64");
  assert.equal(decodeItemBytes(blob), null);
});
