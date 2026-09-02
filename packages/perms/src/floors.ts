/**
 * What a party is going *into* — the floors and tiers `/lfg` asks for.
 *
 * A sibling of `activities.ts` and for the same reason: this is Skyblock's
 * vocabulary, which moves with the game. Floor 8 will exist one day, and adding
 * it should be one row here rather than an enum, a migration and a deploy
 * ordering problem.
 *
 * Codes are the short forms people already type — `f7`, `m3`, `k5` — because
 * guild chat is the surface with no menus, and `!lfg f7` has to be the thing
 * that works. Labels are the long forms, because a card has the room and
 * "Master Mode 7" reads at a glance where "M7" has to be decoded.
 */
import type { LFGActivity } from "@sbr/shared-types";

/**
 * The three things a party runs.
 *
 * A distinct vocabulary from `LFGActivity` rather than a reuse of it: Catacombs
 * and Master Mode are the *same* activity as far as party shape goes — five
 * seats, one per class — and a different one as far as anybody choosing a run is
 * concerned. `activityOf` is the one place the two vocabularies meet.
 */
export type LFGRunType = "CATACOMBS" | "MASTER" | "KUUDRA";

export const RUN_TYPES: readonly LFGRunType[] = ["CATACOMBS", "MASTER", "KUUDRA"];

export interface DungeonFloor {
  /** `F7`, `M3`, `K5`. Uppercase; what a customId and a chat token carry. */
  readonly code: string;
  readonly type: LFGRunType;
  readonly label: string;
}

const FLOORS: readonly DungeonFloor[] = [
  { code: "E", type: "CATACOMBS", label: "Entrance" },
  { code: "F1", type: "CATACOMBS", label: "Floor 1" },
  { code: "F2", type: "CATACOMBS", label: "Floor 2" },
  { code: "F3", type: "CATACOMBS", label: "Floor 3" },
  { code: "F4", type: "CATACOMBS", label: "Floor 4" },
  { code: "F5", type: "CATACOMBS", label: "Floor 5" },
  { code: "F6", type: "CATACOMBS", label: "Floor 6" },
  { code: "F7", type: "CATACOMBS", label: "Floor 7" },
  { code: "M1", type: "MASTER", label: "Master Mode 1" },
  { code: "M2", type: "MASTER", label: "Master Mode 2" },
  { code: "M3", type: "MASTER", label: "Master Mode 3" },
  { code: "M4", type: "MASTER", label: "Master Mode 4" },
  { code: "M5", type: "MASTER", label: "Master Mode 5" },
  { code: "M6", type: "MASTER", label: "Master Mode 6" },
  { code: "M7", type: "MASTER", label: "Master Mode 7" },
  // Kuudra's tiers are named in game and numbered nowhere, so the code is ours
  // and the label is theirs. Both are offered: the menu shows the name people
  // know, and chat takes the number nobody has to spell.
  { code: "K1", type: "KUUDRA", label: "Kuudra — Basic" },
  { code: "K2", type: "KUUDRA", label: "Kuudra — Hot" },
  { code: "K3", type: "KUUDRA", label: "Kuudra — Burning" },
  { code: "K4", type: "KUUDRA", label: "Kuudra — Fiery" },
  { code: "K5", type: "KUUDRA", label: "Kuudra — Infernal" },
];

/** Every floor, in the order they are offered. */
export function allFloors(): readonly DungeonFloor[] {
  return FLOORS;
}

/** The floors of one run type, in offer order. */
export function floorsFor(type: LFGRunType): readonly DungeonFloor[] {
  return FLOORS.filter((floor) => floor.type === type);
}

/**
 * The party shape a run type has, so `@sbr/perms`' role tables can be reached
 * from a floor. Catacombs and Master Mode are both `DUNGEONS`.
 */
export function activityOf(type: LFGRunType): LFGActivity {
  return type === "KUUDRA" ? "KUUDRA" : "DUNGEONS";
}

/**
 * A typed floor token, or null.
 *
 * Generous about the forms people use, because this is the guild-chat path and
 * a member who typed `!lfg floor7` meant Floor 7. It is not generous about
 * ambiguity: a bare `7` is not accepted, since Floor 7 and Master 7 are
 * different runs and guessing between them posts the wrong one.
 */
export function parseFloor(raw: string): DungeonFloor | null {
  const key = raw.trim().toUpperCase().replace(/[\s_-]/g, "");
  if (key === "") return null;

  const direct = FLOORS.find((floor) => floor.code === key);
  if (direct !== undefined) return direct;

  const alias = ALIASES[key];
  if (alias !== undefined) return FLOORS.find((floor) => floor.code === alias) ?? null;

  const long = /^(FLOOR|MASTER|MASTERMODE|M|F|K|KUUDRA|T|TIER)(\d)$/.exec(key);
  if (long === null) return null;
  const [, word, digit] = long;
  const prefix = word === "FLOOR" || word === "F" ? "F" : word === "KUUDRA" || word === "K" || word === "T" || word === "TIER" ? "K" : "M";
  return FLOORS.find((floor) => floor.code === `${prefix}${digit}`) ?? null;
}

/** The names for a floor that are not its code. Kuudra's tiers are the reason. */
const ALIASES: Readonly<Record<string, string>> = {
  ENTRANCE: "E",
  F0: "E",
  BASIC: "K1",
  HOT: "K2",
  BURNING: "K3",
  FIERY: "K4",
  INFERNAL: "K5",
};
