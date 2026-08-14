/**
 * Your words.
 *
 * Name only what you want to change. Everything you leave out keeps its default,
 * and an empty `{}` is a perfectly valid file — that is what `DeepPartial` buys
 * you. Your editor will autocomplete every valid key, and `npm run build` will
 * reject a key that does not exist or a value of the wrong type, so a typo is a
 * build error rather than a setting that sits there looking configured while
 * changing nothing.
 *
 * See `README.md` next to this file, or `docs/BRANDING.md`.
 */
import type { Copy, DeepPartial } from "@sbr/brand-defaults";

export const copyOverride: DeepPartial<Copy> = {
  // Example — delete or edit:
  //
  // panel: {
  //   nav: { members: "Roster" },
  //   members: { subtitle: "Everyone in the guild, on both sides." },
  // },
};
