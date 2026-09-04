/**
 * Minimal NBT reader for auction `item_bytes`.
 *
 * Hypixel's `auctions_ended` endpoint gives a price and an opaque blob — the
 * item's identity lives only inside that blob, as base64-encoded gzipped NBT. So
 * without this, realised sale prices can't be attributed to an item at all, and
 * `/price` has no "actually sells for" number to report.
 *
 * This reads the format rather than parsing it fully: it walks the tag tree and
 * extracts the two strings that matter (`ExtraAttributes.id` and the display
 * name), skipping every payload it doesn't need. A general-purpose NBT library
 * would be a dependency and a lot more surface for one field.
 */
import { gunzipSync } from "node:zlib";

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

/** A decoded compound, flattened to the fields this module cares about. */
export interface DecodedItem {
  /** Canonical Skyblock item id from `ExtraAttributes.id`, e.g. `HYPERION`. */
  readonly itemId: string | null;
  /** Display name with colour codes stripped, when the blob carries one. */
  readonly itemName: string | null;
  /** Stack size, so a sale of 64 can be priced per unit. */
  readonly count: number;
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.offset >= this.buf.length;
  }

  u8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  i16(): number {
    const v = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }
  i32(): number {
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }
  skip(n: number): void {
    this.offset += n;
  }
  str(): string {
    const length = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    const s = this.buf.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return s;
  }
}

/** Strip Minecraft §-prefixed colour codes so names are comparable. */
function stripColors(s: string): string {
  return s.replace(/§./g, "").trim();
}

interface Found {
  itemId: string | null;
  itemName: string | null;
  count: number;
}

/**
 * Walk one payload, collecting the fields of interest.
 *
 * The walk is depth-limited: a malformed or hostile blob must not be able to
 * spend unbounded time here, and real item NBT never nests more than a handful
 * of levels.
 */
function walkPayload(r: Reader, type: number, name: string, found: Found, depth: number): void {
  if (depth > 32) throw new Error("nbt too deeply nested");

  switch (type) {
    case TAG_BYTE:
      if (name === "Count") found.count = r.u8();
      else r.skip(1);
      return;
    case TAG_SHORT:
      r.skip(2);
      return;
    case TAG_INT:
      r.skip(4);
      return;
    case TAG_LONG:
      r.skip(8);
      return;
    case TAG_FLOAT:
      r.skip(4);
      return;
    case TAG_DOUBLE:
      r.skip(8);
      return;
    case TAG_BYTE_ARRAY:
      r.skip(r.i32());
      return;
    case TAG_STRING: {
      const value = r.str();
      // `id` appears both as the vanilla material and, inside ExtraAttributes,
      // as the Skyblock id. The Skyblock one is nested deeper and read last,
      // so preferring the deeper write is exactly what we want.
      if (name === "id") found.itemId = value;
      else if (name === "Name" && found.itemName === null) found.itemName = stripColors(value);
      return;
    }
    case TAG_LIST: {
      const itemType = r.u8();
      const length = r.i32();
      for (let i = 0; i < length; i += 1) {
        if (itemType === TAG_END) break;
        walkPayload(r, itemType, "", found, depth + 1);
      }
      return;
    }
    case TAG_COMPOUND: {
      for (;;) {
        const childType = r.u8();
        if (childType === TAG_END) return;
        const childName = r.str();
        walkPayload(r, childType, childName, found, depth + 1);
      }
    }
    case TAG_INT_ARRAY:
      r.skip(r.i32() * 4);
      return;
    case TAG_LONG_ARRAY:
      r.skip(r.i32() * 8);
      return;
    default:
      throw new Error(`unknown nbt tag ${type}`);
  }
}

/**
 * Decode a base64 gzipped `item_bytes` blob.
 *
 * Returns null on anything malformed rather than throwing: this runs over
 * hundreds of auctions per sweep, and one unreadable blob should cost that one
 * sale, not the whole run.
 */
export function decodeItemBytes(base64: string): DecodedItem | null {
  try {
    const raw = gunzipSync(Buffer.from(base64, "base64"));
    const r = new Reader(raw);

    const rootType = r.u8();
    if (rootType !== TAG_COMPOUND) return null;
    r.str(); // root name, always empty in practice

    const found: Found = { itemId: null, itemName: null, count: 1 };
    walkPayload(r, TAG_COMPOUND, "", found, 0);

    if (found.itemId === null && found.itemName === null) return null;
    return { itemId: found.itemId, itemName: found.itemName, count: found.count };
  } catch {
    return null;
  }
}
