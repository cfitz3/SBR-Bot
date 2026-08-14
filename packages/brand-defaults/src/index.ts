/**
 * `@sbr/brand-defaults` — the words and looks I own, plus the machinery that lets
 * somebody else override them.
 *
 * This package holds **only defaults**. The resolved brand — defaults with the
 * operator's `brand/copy.ts` and `brand/theme.ts` merged over the top — is
 * `@sbr/brand`, and that is what application code imports. The split exists
 * because the override files must import the types from here to be typed against
 * them, so a single package would have to depend on its own consumer.
 *
 * Nothing here may reach for a Node API or for discord.js: the browser bundle,
 * both bots, the workers and the CLI scripts all read the same tree.
 */
export { DEFAULT_COPY, type Copy } from "./defaults/copy.js";
export { DEFAULT_COMMANDS, type CommandCopy, type Commands } from "./defaults/commands.js";
export {
  applyCommandCopy,
  withCommandCopy,
  type CommandCopyTable,
  type CopyableOption,
  type CopyableSpec,
} from "./commands-overlay.js";
export { DEFAULT_EMBEDS, type Embeds } from "./defaults/embeds.js";
export { DEFAULT_ERRORS, type Errors } from "./defaults/errors.js";
export { DEFAULT_PANEL, type Panel } from "./defaults/panel.js";
export { DEFAULT_THEME, type Theme } from "./defaults/theme.js";
export { deepFreeze, deepMerge, makeScope, type Scoped } from "./merge.js";
export type { DeepPartial, DeepReadonly, Get } from "./types.js";
