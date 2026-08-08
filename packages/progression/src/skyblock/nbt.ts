/**
 * A minimal NBT reader, just enough to name the items in a Skyblock bag.
 *
 * Hypixel ships inventories as gzipped, base64-encoded NBT rather than JSON, so
 * `/missing` cannot know what a member owns without decoding it. This reads the
 * whole tree but only the item id and count are ever used downstream — a full
 * NBT library would be a large dependency for two fields.
 *
 * Every failure mode here means the same thing to callers: the bag is
 * unreadable. A member whose inventory API is off, a truncated blob and a
 * format change all return null, and `/missing` reports "unknown" rather than
 * pretending the member owns nothing.
 */
import { gunzipSync } from "node:zlib";

/** One item as the bag records it; empty slots are omitted entirely. */
export interface BagItem {
  /** The Skyblock item id from `tag.ExtraAttributes.id`, e.g. "TITANIC_EXPERIENCE_BOTTLE". */
  readonly id: string;
  readonly count: number;
  /** Display name with colour codes stripped, when present. */
  readonly name: string | null;
  /** From `tag.ExtraAttributes.rarity_upgrades` — recombobulated when > 0. */
  readonly recombobulated: boolean;
}

type Nbt = unknown;

class Reader {
  private o = 0;
  constructor(private readonly b: Buffer) {}

  private need(n: number): void {
    if (this.o + n > this.b.length) throw new Error("nbt: truncated");
  }
  i8(): number {
    this.need(1);
    const v = this.b.readInt8(this.o);
    this.o += 1;
    return v;
  }
  u8(): number {
    this.need(1);
    const v = this.b.readUInt8(this.o);
    this.o += 1;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.b.readInt16BE(this.o);
    this.o += 2;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.b.readInt32BE(this.o);
    this.o += 4;
    return v;
  }
  i64(): number {
    this.need(8);
    // Skyblock item metadata never approaches 2^53, so a plain number keeps the
    // rest of the codebase free of BigInt.
    const v = Number(this.b.readBigInt64BE(this.o));
    this.o += 8;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.b.readFloatBE(this.o);
    this.o += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.b.readDoubleBE(this.o);
    this.o += 8;
    return v;
  }
  str(): string {
    const len = this.b.readUInt16BE(this.o);
    this.need(2 + len);
    const v = this.b.toString("utf8", this.o + 2, this.o + 2 + len);
    this.o += 2 + len;
    return v;
  }

  payload(type: number): Nbt {
    switch (type) {
      case 1:
        return this.i8();
      case 2:
        return this.i16();
      case 3:
        return this.i32();
      case 4:
        return this.i64();
      case 5:
        return this.f32();
      case 6:
        return this.f64();
      case 7: {
        const n = this.i32();
        this.need(n);
        const v = [...this.b.subarray(this.o, this.o + n)];
        this.o += n;
        return v;
      }
      case 8:
        return this.str();
      case 9: {
        const itemType = this.u8();
        const n = this.i32();
        const out: Nbt[] = [];
        // A zero-length list may declare TAG_End as its type; reading payloads
        // for it would desynchronise the stream.
        for (let i = 0; i < n && itemType !== 0; i += 1) out.push(this.payload(itemType));
        return out;
      }
      case 10: {
        const out: Record<string, Nbt> = {};
        for (;;) {
          const t = this.u8();
          if (t === 0) break;
          const name = this.str();
          out[name] = this.payload(t);
        }
        return out;
      }
      case 11: {
        const n = this.i32();
        const out: number[] = [];
        for (let i = 0; i < n; i += 1) out.push(this.i32());
        return out;
      }
      case 12: {
        const n = this.i32();
        const out: number[] = [];
        for (let i = 0; i < n; i += 1) out.push(this.i64());
        return out;
      }
      default:
        throw new Error(`nbt: unknown tag type ${type}`);
    }
  }
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Minecraft's §-prefixed colour codes, which are noise in an embed. */
function stripColors(s: string): string {
  return s.replace(/§./g, "");
}

/**
 * Decode a bag blob (`{ type, data }` as Hypixel returns it) into its items.
 * Null means unreadable — an absent bag, a hidden inventory API, or a blob this
 * reader could not parse.
 */
export function readBag(blob: unknown): readonly BagItem[] | null {
  const holder = rec(blob);
  const data = holder?.["data"];
  if (typeof data !== "string" || data.length === 0) return null;

  let root: Nbt;
  try {
    const raw = gunzipSync(Buffer.from(data, "base64"));
    const reader = new Reader(raw);
    const type = reader.u8();
    if (type !== 10) return null;
    reader.str(); // root name, always empty in practice
    root = reader.payload(10);
  } catch {
    return null;
  }

  const list = rec(root)?.["i"];
  if (!Array.isArray(list)) return null;

  const items: BagItem[] = [];
  for (const entry of list) {
    const slot = rec(entry);
    if (!slot) continue;
    const tag = rec(slot["tag"]);
    const extra = rec(tag?.["ExtraAttributes"]);
    const id = extra?.["id"];
    // Empty slots are `{}` — skipping them is what makes the count meaningful.
    if (typeof id !== "string") continue;
    const display = rec(tag?.["display"]);
    const name = display?.["Name"];
    const upgrades = extra?.["rarity_upgrades"];
    items.push({
      id,
      count: typeof slot["Count"] === "number" ? slot["Count"] : 1,
      name: typeof name === "string" ? stripColors(name) : null,
      recombobulated: typeof upgrades === "number" && upgrades > 0,
    });
  }
  return items;
}
