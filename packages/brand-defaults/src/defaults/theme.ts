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
