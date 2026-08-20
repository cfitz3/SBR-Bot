/**
 * The browser's copy of the role-menu limits.
 *
 * Literal declarations rather than an import of `@sbr/roles`, for the same
 * reason as `enums.ts`: the client half has no bundler, so a runtime import of
 * a workspace package emits a bare specifier the browser cannot resolve — and
 * `main.ts` imports every page statically, so one such specifier stops the whole
 * shell at its `Loading…` placeholder.
 *
 * The duplication is guarded: `role-menu-limits.test.ts` runs under Node,
 * imports the real constants, and fails if either copy drifts.
 */

/** Menus per guild, and roles per menu (five buttons a row, five rows). */
export const MAX_MENUS = 10;
export const MAX_MENU_OPTIONS = 25;

export const MAX_MENU_TITLE = 100;
export const MAX_MENU_BODY = 2_000;
export const MAX_OPTION_LABEL = 80;
export const MAX_OPTION_DESCRIPTION = 200;

/**
 * Ids travel inside a colon-separated custom id, so no colons — which is the
 * one way this shape differs from the auto-role rule key beside it on the page.
 */
export const ROLE_MENU_KEY_SHAPE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
export const MAX_ROLE_MENU_KEY = 32;
