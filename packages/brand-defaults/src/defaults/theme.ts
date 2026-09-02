/**
 * Default appearance: the embed palette, the embed style constants, and the
 * panel's visual tokens.
 *
 * This file is the single origin of three things that used to be written down
 * more than once:
 *
 *  - the semantic embed colours, which existed as a private `COLORS` map in
 *    `discord-kit/render.ts` *and* as `VIEW_COLORS` in `style.ts` — two copies
 *    that agreed only because nobody had edited one of them yet;
 *  - the fact separator, which `flattenEmbed` hardcoded as `" | "` while the
 *    house style checker in the same repo called for `" · "` and flagged the
 *    other as wrong;
 *  - the panel token block, which `app.css` declares in `:root` and the panel
 *    now re-serves from here as `/theme.css`.
 *
 * Written without `as const` deliberately: see `../types.ts` — leaves must widen
 * so an override can replace them.
 */

export const DEFAULT_THEME = {
  embed: {
    /**
     * Semantic colour → hex. Central so every card in the platform agrees, and so
     * an imported specimen's raw hex can be matched back to a name — a card whose
     * colour is a literal has escaped the palette, which is exactly the drift the
     * style checker exists to catch.
     */
    colors: {
      NEUTRAL: 0x2b2d31,
      INFO: 0x5865f2,
      SUCCESS: 0x57f287,
      WARNING: 0xfee75c,
      DANGER: 0xed4245,
    },

    /**
     * The house style. These are the numbers to argue about — each is a taste
     * judgement, not a platform constraint. Discord's own hard caps live in
     * `EMBED_LIMITS` (`discord-kit/style.ts`) and are not overridable, because
     * exceeding one is a rejected message rather than an untidy card.
     */
    style: {
      /** Past this the description is an essay; move it into fields or a page. */
      descriptionLines: 12,
      /** Past this the card is a wall; paginate instead. */
      fields: 12,
      /** Discord packs inline fields three to a row. */
      inlineRow: 3,
      /** A footer is a caption, not a second description. */
      footer: 120,
      /** Between facts on one line: `cata 42 · sa 51.3`. */
      separator: " · ",
      /** What an unknown value prints as. Never "N/A", never a silent zero. */
      unknown: "—",

      /**
       * The readability budget, well under Discord's hard cap of 25.
       *
       * Fewer than `minFields` and the facts were worth a sentence in the
       * description instead of a grid; more than `maxFields` and the reader is
       * scanning rather than reading. Both are warnings, not errors — a card
       * with a data-dependent field count (networth categories, an application
       * that may or may not have been reviewed) legitimately crosses the line
       * sometimes, and says so by ignoring the rule by id.
       */
      minFields: 4,
      maxFields: 6,
    },

    /**
     * The marks a card is allowed to make.
     *
     * These are here, rather than as literals in whichever renderer needed one
     * first, because that is exactly how the platform ended up with two progress
     * bars: `▰▱` in the standing card and `█░` in achievements and goals, on the
     * same screen, meaning the same thing. A member cannot be expected to read
     * that as one product.
     *
     * `marker` is the qualifying flag — a maxed skill, a capped stat. It is gold
     * on purpose: the old `✦` rendered in the body colour, so "maxed" looked
     * exactly like "not maxed" to anyone not counting.
     *
     * `on`/`off` are the switch pair, for any card that lists things a guild
     * has turned on: feature flags, lockdowns, per-source XP. Deliberately not
     * a tick and a cross — off is a choice somebody made, not a failure, and a
     * red cross beside "Autoresponders" reads as one.
     */
    glyphs: {
      barFilled: "▰",
      barEmpty: "▱",
      barWidth: 10,
      marker: "⭐",

      /**
       * The sparkline ramp, lowest to highest, and the gap.
       *
       * Same reasoning as the bar above it, applied before the drift happens
       * rather than after: `/price` draws a price series, and the next card that
       * wants to draw one must not get to pick its own ramp.
       *
       * `sparkGap` is deliberately not the lowest step. A bucket where nothing
       * traded has no price, and drawing it at the floor would report a crash
       * that did not happen.
       */
      spark: "▁▂▃▄▅▆▇█",
      sparkGap: "·",
      /** Hourly buckets over a week are 168 points; a phone shows about this many. */
      sparkWidth: 24,
      /** The two states a feature switch has, as one glyph each. */
      on: "🟢",
      off: "⚪",
    },

    /**
     * Where a player's face comes from.
     *
     * Discord will not render a Minecraft skin for us, so a card that shows one
     * is naming a third-party image host. That is a dependency, and dependencies
     * belong in the theme where an operator can see and change it — not baked
     * into whichever renderer needed a face first.
     *
     * `{uuid}` is substituted. Both must be https or the style checker rejects
     * the card before Discord does.
     */
    avatars: {
      head: "https://mc-heads.net/avatar/{uuid}/64",
      body: "https://mc-heads.net/head/{uuid}/128",
    },
  },

  panel: {
    /**
     * The chrome that is a *colour* rather than a word.
     *
     * The product name, the wordmark and the tagline are words, so they live in
     * `copy.panel.shell` and not here — one name in one place. This is the
     * browser-UI tint mobile Chrome and Safari paint their address bar with, and
     * it wants to match `colors.bg`.
     */
    chrome: {
      themeColor: "#161826",
    },

    /**
     * The Nocturne palette. Mirrors `app.css`'s `:root`, which stays in place as
     * the documented fallback for a panel served without the brand layer.
     */
    colors: {
      bg: "#161826",
      surface: "#232532",
      text: "#e9e9ed",
      accent: "#9184d9",
      accent2: "#a7a1db",
      divider: "color-mix(in srgb, #e9e9ed 16%, transparent)",

      neutral100: "#f3f5fe",
      neutral200: "#e4e7f5",
      neutral300: "#cfd3e5",
      neutral400: "#b2b6ca",
      neutral500: "#9397ab",
      neutral600: "#75798c",
      neutral700: "#595d6c",
      neutral800: "#3f424d",
      neutral900: "#292b31",

      accent100: "#f5f4ff",
      accent200: "#e7e5fe",
      accent300: "#d2cefd",
      accent400: "#b5abfc",
      accent500: "#968ae0",
      accent600: "#796cbf",
      accent700: "#5d5294",
      accent800: "#423a6a",
      accent900: "#2b2741",
    },

    /**
     * Status hues. The design's own tone map paints "warn" in the accent, which
     * reads fine on a mock with one warning on screen but collapses on Health and
     * Events, where warn and accent sit in the same table and must mean different
     * things. Warn gets its own amber for that reason.
     */
    tone: {
      ok: "#6fcf97",
      warn: "#e0b061",
      bad: "#e2726b",
    },

    /** The eight-step scale, in px. */
    space: {
      s1: "2.8px",
      s2: "5.6px",
      s3: "8.4px",
      s4: "11.2px",
      s5: "16.8px",
      s6: "22.4px",
      s7: "33.6px",
      s8: "44.8px",
    },

    radius: {
      sm: "4px",
      md: "8px",
      lg: "14px",
    },

    shadow: {
      sm: "0 0 0 1px var(--color-neutral-800)",
      md: "0 0 0 1px var(--color-neutral-700), 0 6px 18px rgb(0 0 0 / 55%)",
      lg: "0 0 0 1px var(--color-neutral-500), 0 16px 40px rgb(0 0 0 / 65%)",
    },

    /**
     * No webfont is fetched: the CSP names no external origin, so Inter is used
     * only when the operator happens to have it installed and the system stack
     * carries the same measurements otherwise.
     */
    font: {
      sans: 'Inter, "Inter var", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
  },
};

/** Derived from the defaults, so there is no second list to keep in step. */
export type Theme = typeof DEFAULT_THEME;
