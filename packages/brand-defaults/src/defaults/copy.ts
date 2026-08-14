/**
 * The whole copy tree, assembled from the four namespaces.
 *
 * Four files rather than one because the audiences differ: `commands` is read by
 * anyone typing a slash, `panel` by an operator, `errors` by whoever is having a
 * bad time, and `embeds` by everyone at once. Splitting them keeps each file
 * reviewable and keeps a Phase-C churn of 180 command lines out of the same diff
 * as a one-word panel fix.
 */
import { DEFAULT_COMMANDS } from "./commands.js";
import { DEFAULT_EMBEDS } from "./embeds.js";
import { DEFAULT_ERRORS } from "./errors.js";
import { DEFAULT_PANEL } from "./panel.js";

export const DEFAULT_COPY = {
  command: DEFAULT_COMMANDS,
  panel: DEFAULT_PANEL,
  embed: DEFAULT_EMBEDS,
  error: DEFAULT_ERRORS,
};

/** Derived from the defaults, so there is no second list to keep in step. */
export type Copy = typeof DEFAULT_COPY;
