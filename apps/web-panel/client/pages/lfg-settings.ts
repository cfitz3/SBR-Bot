/**
 * The browser's copy of the `/lfg` ping-role setting key.
 *
 * A literal rather than an import of `LFG_PING_ROLE_SETTING_KEY`, for the same
 * reason `channel-slots.ts` spells its registry out: this module is loaded by
 * the browser, the client half has no bundler, and a runtime import of a
 * workspace package would emit a bare specifier nothing can resolve. The
 * duplication is guarded — `lfg-settings.test.ts` runs under Node, imports the
 * real constant, and fails if the two ever differ.
 */
export const LFG_PING_ROLE_KEY = "lfg.pingRole";
