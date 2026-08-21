/**
 * Inline SVG icons.
 *
 * The design calls for Phosphor, which ships as a webfont from a CDN — two
 * things the panel's CSP forbids at once (`font-src` is `'self'` and there is no
 * off-origin host in the policy at all). These are hand-drawn stand-ins in the
 * same visual register: 24×24, stroked rather than filled, round joins, one
 * weight. They take their colour from `currentColor`, so a nav row's active
 * state tints the icon without a second rule.
 */
import { s } from "./dom.js";

/** Path data, keyed by the name call sites use. */
const PATHS: Readonly<Record<string, readonly string[]>> = {
  // Four panes: the dashboard glyph.
  overview: ["M4 4h6.5v6.5H4z", "M13.5 4H20v4.5h-6.5z", "M13.5 11.5H20V20h-6.5z", "M4 14h6.5v6H4z"],
  // Axes with a trend line.
  analytics: ["M4 4v16h16", "M7.5 15l3.5-4.5 3 2.5 5-6.5"],
  // A pulse trace.
  health: ["M3 12h3.5l2.2-6.5 3.6 12.5 2.2-6h6.5"],
  // Calendar.
  events: ["M4.5 6.5h15v13h-15z", "M8.5 3.5v4", "M15.5 3.5v4", "M4.5 10.5h15"],
  // Shield.
  moderation: ["M12 3.2l7 2.8v5c0 4.4-2.9 7.4-7 9.8-4.1-2.4-7-5.4-7-9.8V6z"],
  // Two people.
  members: [
    "M9.5 11.5a3.4 3.4 0 100-6.8 3.4 3.4 0 000 6.8z",
    "M3.5 20c0-3.3 2.7-5.3 6-5.3s6 2 6 5.3",
    "M16.4 5.4a3.4 3.4 0 010 6.4",
    "M17.4 14.9c1.9.8 3.1 2.6 3.1 5.1",
  ],
  // Sliders, standing in for a gear at this size where teeth turn to mush.
  settings: ["M4 7.5h9", "M17 7.5h3", "M4 16.5h3", "M11 16.5h9", "M15 5.5v4", "M9 14.5v4"],
  // Trophy.
  milestones: [
    "M8 4h8v4.8a4 4 0 01-8 0z",
    "M8 5.5H5v1.8a3 3 0 003 3",
    "M16 5.5h3v1.8a3 3 0 01-3 3",
    "M12 12.8V17",
    "M8.5 20h7",
  ],
  // Three bars of a podium, tallest in the middle.
  leaderboard: ["M4 13.5h4.5V20H4z", "M9.75 8h4.5v12h-4.5z", "M15.5 11h4.5v9h-4.5z"],
  // Conversation.
  tickets: ["M4.5 5.5h15v10h-9l-6 4.5z"],
  // A key: what a level actually is on this platform.
  permissions: ["M10.7 15.2a3.3 3.3 0 100-6.6 3.3 3.3 0 000 6.6z", "M14 11.9h6", "M17 11.9v3", "M19.4 11.9v2.2"],
  // A luggage tag: a role handed to somebody, hanging off them.
  roles: ["M4.5 4.5h6.2L20 13.8l-6.2 6.2-9.3-9.3z", "M8.2 8.2h.01"],
  // Funnel: the word filter.
  wordlist: ["M4 5h16l-6.2 7.2V19l-3.6 1.8v-8.6z"],
  // Chrome.
  back: ["M14.5 6l-6 6 6 6"],
  signout: ["M9.5 20H5V4h4.5", "M15 16l4-4-4-4", "M19 12H9.5"],
  caret: ["M7.5 10.5l4.5 4.5 4.5-4.5"],
  download: ["M12 4v10.5", "M8 11l4 4 4-4", "M5 19.5h14"],
};

export type IconName = keyof typeof PATHS;

/**
 * Build an icon. `cls` lands on the `<svg>` so the caller decides the size —
 * the element carries no intrinsic dimensions beyond its viewBox.
 */
export function icon(name: IconName, cls = "icon"): SVGElement {
  const paths = PATHS[name] ?? [];
  return s(
    "svg",
    {
      class: cls,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.7",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      // Decorative: every icon in the panel sits next to its own text label.
      "aria-hidden": "true",
      focusable: "false",
    },
    ...paths.map((d) => s("path", { d })),
  );
}

/**
 * Initials for a circular avatar. Two letters from the first two words, or the
 * first two characters when there is only one word — the same rule the design's
 * mock applies to guild names and Discord usernames alike.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
