/**
 * Adapter between skyhelper-networth's result and our `NetworthComputation`.
 *
 * Lives here rather than in each app's composition root because both the bridge
 * and the workers value profiles, and a breakdown that differs between the two
 * would make a member's `/networth` disagree with their own snapshot history.
 *
 * The input is `unknown` on purpose: it crosses a package boundary we don't
 * control, and a shape change upstream should cost us a missing category, not a
 * thrown command.
 */
import type { NetworthComputation, NetworthItem } from "./ports.js";

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function items(value: unknown): readonly NetworthItem[] {
  if (!Array.isArray(value)) return [];
  const out: NetworthItem[] = [];
  for (const entry of value) {
    const record = obj(entry);
    const price = num(record?.["price"]);
    const name = record?.["name"];
    if (price === null || typeof name !== "string") continue;
    // The library leaves colour codes in the item name; a bare name reads better
    // in an embed and is what the player sees in-game anyway.
    out.push({ name: name.replace(/§./g, "").trim(), price });
  }
  return out;
}

/**
 * Coins live outside `types` in the library's result, but a networth breakdown
 * that omitted the bank would be missing the largest slice for most members.
 */
const COIN_SECTIONS = ["purse", "bank", "personalBank"] as const;

export function summariseNetworth(result: unknown): NetworthComputation {
  const root = obj(result);
  const total = num(root?.["networth"]);
  const breakdown: Record<string, number> = {};
  const byCategory: Record<string, readonly NetworthItem[]> = {};

  for (const section of COIN_SECTIONS) {
    const value = num(root?.[section]);
    // Zero coins is a real reading; an absent field is not.
    if (value !== null && value > 0) breakdown[section] = value;
  }

  for (const [category, value] of Object.entries(obj(root?.["types"]) ?? {})) {
    const section = obj(value);
    const sectionTotal = num(section?.["total"]);
    if (sectionTotal !== null && sectionTotal > 0) breakdown[category] = sectionTotal;
    const list = items(section?.["items"]);
    if (list.length > 0) byCategory[category] = list;
  }

  return { total, breakdown, items: byCategory };
}
