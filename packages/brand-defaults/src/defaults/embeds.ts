/**
 * Embed copy: card titles, footers, tone words and the placeholder text.
 *
 * The words here are the ones that repeat across cards. A title that belongs to
 * exactly one card is still a key — that is decision 2, exhaustive coverage — but
 * the shared vocabulary lands first because it is what makes the cards read as
 * one product rather than as several.
 */

export const DEFAULT_EMBEDS = {
  /**
   * What a missing value prints as, everywhere. Never "N/A", and never a silent
   * zero: a zero that means "we don't know" is the specific dishonesty the
   * platform's own rules forbid.
   */
  unknown: "—",

  /** Tone words, so a state reads the same on a card as it does in the panel. */
  tone: {
    ok: "OK",
    warn: "Warning",
    bad: "Failing",
    neutral: "Unknown",
  },

  /** Footers that appear on more than one card. */
  footer: {
    stale: "Data as of {at}",
    estimate: "Estimated",
    partial: "Some sources didn't answer; figures may be incomplete.",
  },

  /** Per-card copy. Populated alongside the gallery in Phase B. */
  card: {},
};

export type Embeds = typeof DEFAULT_EMBEDS;
