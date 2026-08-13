/**
 * Parsing Hypixel's own guild moderation notices out of the chat stream.
 *
 * The guild is moderated from two places: this platform, and the game. The
 * platform half is fully recorded; the game half was invisible, so a member
 * kicked in-game left no trace on the Moderation page and staff had to hold two
 * histories in their heads.
 *
 * This closes that as far as it can be closed, and no further. **It is
 * best-effort by construction:** Hypixel emits a line for some moderation
 * events and not others, the wording is not versioned and can change without
 * notice, and a line only reaches us while the bridge account is connected —
 * anything done during a disconnect is simply not seen. So the actions this
 * produces are recorded with `sourceContext: INGAME` and the page says what
 * they are, rather than presenting a partial record as a complete one.
 *
 * Pure and separately tested for the same reason `parseGuildChat` is: these are
 * regexes against a format we do not control, and the only way to change them
 * safely is to have the old cases pinned.
 */

/** What kind of in-game action a notice describes. */
export type ModNoticeKind = "KICK" | "MUTE" | "UNMUTE" | "PROMOTE" | "DEMOTE";

export interface ModNotice {
  readonly kind: ModNoticeKind;
  /** The member the action was taken against. */
  readonly target: string;
  /**
   * Who did it, when Hypixel named them. Several notices are written in the
   * passive voice and name nobody; a guessed actor would be worse than none.
   */
  readonly actor: string | null;
  /** Mute length in seconds, when the notice carried one. */
  readonly durationSeconds: number | null;
}

/**
 * Strip Hypixel's rank prefix from a name.
 *
 * Notices interleave `[MVP+] Steve` and bare `Steve` depending on the line, and
 * a target recorded with its prefix will not match the same player recorded
 * without it.
 */
function bareName(raw: string): string {
  return raw.replace(/^\[[^\]]+\]\s*/, "").trim();
}

/**
 * Hypixel writes mute durations as a single unit — `30d`, `12h`, `10m`, `60s` —
 * never a compound. Anything else is left unparsed rather than guessed at.
 */
export function parseNoticeDuration(raw: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  switch (m[2]) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 3_600;
    case "d":
      return value * 86_400;
    default:
      return null;
  }
}

/**
 * The notice forms this recognises. Ordered most specific first, since the kick
 * forms overlap: "was kicked from the guild by X" must be tried before the
 * plain "was kicked from the guild".
 */
const PATTERNS: readonly {
  readonly kind: ModNoticeKind;
  readonly re: RegExp;
  readonly target: number;
  readonly actor: number | null;
  readonly duration: number | null;
}[] = [
  // "[MVP+] Steve was kicked from the guild by [ADMIN] Alex!"
  {
    kind: "KICK",
    re: /^(\S+(?: \S+)?) was kicked from the guild by (.+?)!?$/,
    target: 1,
    actor: 2,
    duration: null,
  },
  // "[MVP+] Steve was kicked from the guild!" — Hypixel names nobody here.
  { kind: "KICK", re: /^(\S+(?: \S+)?) was kicked from the guild!?$/, target: 1, actor: null, duration: null },
  // "[ADMIN] Alex has muted [MVP+] Steve for 30d"
  { kind: "MUTE", re: /^(.+?) has muted (.+?) for (\d+[smhd])$/, target: 2, actor: 1, duration: 3 },
  // "[ADMIN] Alex has unmuted [MVP+] Steve"
  { kind: "UNMUTE", re: /^(.+?) has unmuted (.+?)$/, target: 2, actor: 1, duration: null },
  // "[ADMIN] Alex has promoted [MVP+] Steve from Member to Officer"
  { kind: "PROMOTE", re: /^(.+?) has promoted (.+?) from .+? to .+?$/, target: 2, actor: 1, duration: null },
  { kind: "DEMOTE", re: /^(.+?) has demoted (.+?) from .+? to .+?$/, target: 2, actor: 1, duration: null },
];

/**
 * Read one chat line as a moderation notice, or `null` if it is not one.
 *
 * Guild-chat lines are rejected up front: a member typing "Steve was kicked
 * from the guild" in chat must not manufacture a moderation record, and the
 * `Guild >` prefix is exactly what separates what Hypixel said from what a
 * player said.
 */
export function parseModNotice(line: string): ModNotice | null {
  const text = line.trim();
  if (text.length === 0) return null;
  if (text.startsWith("Guild >") || text.startsWith("Officer >")) return null;

  for (const pattern of PATTERNS) {
    const m = pattern.re.exec(text);
    if (!m) continue;
    const target = bareName(m[pattern.target] ?? "");
    if (target.length === 0 || !/^\w{1,16}$/.test(target)) continue;
    const rawActor = pattern.actor === null ? null : (m[pattern.actor] ?? null);
    const actor = rawActor === null ? null : bareName(rawActor);
    const rawDuration = pattern.duration === null ? null : (m[pattern.duration] ?? null);
    return {
      kind: pattern.kind,
      target,
      actor: actor !== null && /^\w{1,16}$/.test(actor) ? actor : null,
      durationSeconds: rawDuration === null ? null : parseNoticeDuration(rawDuration),
    };
  }
  return null;
}

/**
 * Whether a notice is worth recording as a moderation action.
 *
 * Promotions and demotions are parsed — they are the same family of line and
 * cost nothing to recognise — but they are not punishments and do not belong in
 * an infraction history. They are returned so a caller that wants a rank feed
 * later has them, and filtered here so the moderation path does not.
 */
export function isPunitiveNotice(notice: ModNotice): boolean {
  return notice.kind === "KICK" || notice.kind === "MUTE" || notice.kind === "UNMUTE";
}
