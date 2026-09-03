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
 * The design language is **Operator** (`Direction 1 — Operator`): instrument
 * panel density. Colour is reserved for state — every surface, line and label is
 * a cool grey, and the accent appears only on the active thing. It replaced
 * Nocturne, which spent its accent on decoration and could not then use it to
 * mean anything.
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
     *
     * These are the panel's own tone hues, not Discord's defaults. `INFO` used to
     * be blurple (`0x5865f2`) and `SUCCESS`/`WARNING`/`DANGER` were Discord's
     * three — so a card sent by this platform was indistinguishable from a card
     * sent by any other bot in the channel. Operator's accent and tone map make
     * the stripe down the left of a card the same colour as the state it names in
     * the panel, which is the only reason a member ever learns what the colours
     * mean.
     */
    colors: {
      NEUTRAL: 0x232830,
      INFO: 0x5fa8d3,
      SUCCESS: 0x4fb286,
      WARNING: 0xd9a441,
      DANGER: 0xd9534f,
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
      /**
       * Between a card's subject and what the card is: `Frostbyte_ — stats`.
       * An em dash, not a hyphen — the two are indistinguishable in a changelog
       * and very distinguishable in a card.
       */
      titleSeparator: " — ",
      /** An author row is one line naming the subject, not a summary. */
      author: 80,
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
      themeColor: "#0d0f12",
    },

    /**
     * The Operator palette. Mirrors `app.css`'s `:root`, which stays in place as
     * the documented fallback for a panel served without the brand layer.
     *
     * Two things to know before editing the ramps. The neutral ramp is not a
     * smooth gradient — 100…700 are *text* greys and 800/900 are *line* greys,
     * and the step between 700 and 800 is deliberately large because nothing in
     * the design sits between "dimmest readable label" and "hairline". The
     * accent ramp ends the same way: 800 and 900 are the two accent-tinted
     * surfaces (a chip's fill, the active nav row's ground), not shades of the
     * accent you would ever set text in.
     */
    colors: {
      bg: "#0d0f12",
      surface: "#101318",
      text: "#d8dee7",
      accent: "#5fa8d3",
      accent2: "#8fc6e6",
      divider: "#232830",

      neutral100: "#eef2f7",
      neutral200: "#d8dee7",
      neutral300: "#b6bfcb",
      neutral400: "#98a2b0",
      neutral500: "#7b8492",
      neutral600: "#5a6270",
      neutral700: "#4e5663",
      neutral800: "#232830",
      neutral900: "#171b21",

      accent100: "#eaf4fa",
      accent200: "#cfe6f3",
      accent300: "#a8d2e9",
      accent400: "#8fc6e6",
      accent500: "#5fa8d3",
      accent600: "#4a8bb3",
      accent700: "#3a6d8c",
      accent800: "#1e2732",
      accent900: "#182029",
    },

    /**
     * Status hues, straight from the design's swatch.
     *
     * Nocturne painted "warn" in the accent and this file carried a note about
     * having to invent an amber, because warn and accent shared a table on Health
     * and Events and had to mean different things. Operator reserves the accent
     * for state *selection* rather than for a state, so all three tones are the
     * design's own values and there is nothing left to reconcile.
     */
    tone: {
      ok: "#4fb286",
      warn: "#d9a441",
      bad: "#d9534f",
    },

    /**
     * The eight-step scale, in px.
     *
     * Whole pixels. Nocturne's scale was a 2.8px geometric run, which put a
     * hairline border on a fractional boundary and let the browser round two
     * adjacent 1px rules to different widths — visible as a seam in the tile grid
     * at exactly the density Operator asks for.
     */
    space: {
      s1: "2px",
      s2: "4px",
      s3: "6px",
      s4: "8px",
      s5: "12px",
      s6: "16px",
      s7: "22px",
      s8: "32px",
    },

    /** Sharp. A card is a bounded region, not a rounded object. */
    radius: {
      sm: "2px",
      md: "3px",
      lg: "4px",
    },

    /**
     * Rings, not shadows.
     *
     * Operator is flat: depth is carried by a hairline and a surface step, never
     * by a drop shadow. The three names survive because `app.css` and the theme
     * contract both use them, but each is now a 1px ring — an override that wants
     * a real shadow can still supply one.
     */
    shadow: {
      sm: "0 0 0 1px var(--color-neutral-800)",
      md: "0 0 0 1px var(--color-neutral-800)",
      lg: "0 0 0 1px var(--color-neutral-700)",
    },

    /**
     * No webfont is fetched: the CSP names no external origin, so IBM Plex is
     * used only when the operator happens to have it installed and the system
     * stack carries the same measurements otherwise.
     *
     * The mono stack matters more than the sans one here. Operator sets every
     * numeral, IGN, id and timestamp in mono, so `ui-monospace` is doing real
     * work on most machines — and it is a good fallback, which is why this is
     * still the right trade against shipping four woff2 files.
     */
    font: {
      sans: '"IBM Plex Sans", "IBM Plex Sans Var", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },
  },
};

/** Derived from the defaults, so there is no second list to keep in step. */
export type Theme = typeof DEFAULT_THEME;
