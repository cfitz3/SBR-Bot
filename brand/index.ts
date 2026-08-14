/**
 * `@sbr/brand` — the resolved brand: my defaults with your overrides on top.
 *
 * Application code imports from here and never from `@sbr/brand-defaults`, so
 * there is exactly one answer to "what does this say" and "what colour is this"
 * in the whole platform.
 *
 * Resolved once, at module load, and frozen. The merge is not paid per request
 * or per rendered card, and no runtime path can mutate the result.
 */
import {
  DEFAULT_COPY,
  DEFAULT_THEME,
  deepFreeze,
  deepMerge,
  makeScope,
  withCommandCopy as overlayCommandCopy,
  type Copy,
  type CopyableSpec,
  type DeepReadonly,
  type Theme,
} from "@sbr/brand-defaults";

import { copyOverride } from "./copy.js";
import { themeOverride } from "./theme.js";

/** Every user-visible string, resolved. */
export const copy: DeepReadonly<Copy> = deepFreeze(deepMerge(DEFAULT_COPY, copyOverride));

/** Every visual decision, resolved. */
export const theme: DeepReadonly<Theme> = deepFreeze(deepMerge(DEFAULT_THEME, themeOverride));

/**
 * Read one namespace of the copy tree:
 *
 * ```ts
 * const t = scope("panel.members");
 * t("title"); // "Members"
 * ```
 *
 * The namespace is stated once rather than repeated at forty call sites, and a
 * path that does not exist fails to compile.
 */
export const scope = makeScope(copy);

/**
 * Put the resolved descriptions onto a command registry.
 *
 * Called by `buildBridgeRegistry()` and `buildAdminRegistry()` on their way out,
 * which is the only place either registry is assembled — so every surface that
 * quotes a command reads the same words. A spec keeps everything else it has.
 */
export function withCommandCopy<S extends CopyableSpec>(registry: ReadonlyMap<string, S>): Map<string, S> {
  return overlayCommandCopy(registry, copy.command);
}

export type { Copy, Theme, DeepPartial, DeepReadonly } from "@sbr/brand-defaults";
export type { CommandCopy, CopyableOption, CopyableSpec, Scoped } from "@sbr/brand-defaults";
