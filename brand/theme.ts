/**
 * Your looks.
 *
 * Same rules as `copy.ts`: name only what you want to change, and the compiler
 * checks the rest. Panel colours here become CSS custom properties served as
 * `/theme.css`, which the panel links after `app.css` — so your tokens win by
 * cascade without any rule in `app.css` being rewritten, and without an inline
 * style that the panel's content-security policy would refuse.
 *
 * Embed colours here are what every card in both bots renders with.
 */
import type { DeepPartial, Theme } from "@sbr/brand-defaults";

export const themeOverride: DeepPartial<Theme> = {
  // Example — delete or edit:
  //
  // embed: { colors: { INFO: 0x9184d9 } },
  // panel: { colors: { accent: "#9184d9" }, chrome: { themeColor: "#161826" } },
  //
  // The panel's *name* is a word, not a colour — it lives in `copy.ts` under
  // `panel.shell.name`, so there is only ever one place it is written down.
};
