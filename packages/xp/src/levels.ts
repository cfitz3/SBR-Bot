/**
 * The level curve.
 *
 * Level `L` costs `STEP × L` XP, so the cumulative cost of reaching it is
 * `STEP × L(L+1)/2` — a triangular curve. Two reasons for that shape over the
 * exponential curves these systems usually reach for:
 *
 *  - **It inverts in closed form.** Level from total XP is one `Math.sqrt`, not
 *    a loop, so a leaderboard of 400 members costs nothing to render.
 *  - **It stays reachable.** Each level costs a fixed amount more than the last,
 *    so level 30 is thirty days of steady activity rather than an asymptote that
 *    quietly tells everyone below the top ten not to bother.
 */

/** XP for the first level. Every subsequent level costs this much more again. */
export const LEVEL_STEP = 100;

/** Cumulative XP required to *reach* `level`. Level 0 is free. */
export function xpForLevel(level: number): number {
  const l = Math.max(0, Math.floor(level));
  return (LEVEL_STEP * l * (l + 1)) / 2;
}

/**
 * The level a total buys. Negative totals (possible after a MANUAL deduction)
 * floor at 0 rather than producing an imaginary level.
 */
export function levelForXp(totalXp: number): number {
  if (!Number.isFinite(totalXp) || totalXp <= 0) return 0;
  // Inverse of xpForLevel: solve STEP·L(L+1)/2 ≤ total for L.
  return Math.floor((Math.sqrt(1 + (8 * totalXp) / LEVEL_STEP) - 1) / 2);
}

export interface LevelProgress {
  readonly level: number;
  /** XP earned since reaching `level`. */
  readonly intoLevel: number;
  /** XP the next level costs in total. Never 0, so callers can divide. */
  readonly levelSpan: number;
}

export function levelProgress(totalXp: number): LevelProgress {
  const level = levelForXp(totalXp);
  const base = xpForLevel(level);
  const span = xpForLevel(level + 1) - base;
  return { level, intoLevel: Math.max(0, Math.floor(totalXp) - base), levelSpan: span };
}

/** `▰▰▰▱▱▱▱▱▱▱` — a progress bar for the standing embed. */
export function progressBar(progress: LevelProgress, width = 10): string {
  const ratio = progress.levelSpan === 0 ? 0 : progress.intoLevel / progress.levelSpan;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}
