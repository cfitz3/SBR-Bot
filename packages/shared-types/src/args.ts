/**
 * Typed command arguments.
 *
 * Commands need more than strings: `/purge count:50` is a number, `/kick
 * also_guild:true` a boolean, `/ticket action:open` a subcommand. But the same
 * handlers are driven from Discord interactions *and* from in-game guild chat
 * (`!price ENCHANTED_DIAMOND 64`), so the accessor is an interface rather than a
 * concrete type — each transport supplies its own reader.
 */

export interface CommandArgs {
  getString(name: string): string | null;
  getNumber(name: string): number | null;
  getBoolean(name: string): boolean | null;
  /** Discord snowflake of a user option; in-game this is null (no proven identity). */
  getUser(name: string): string | null;
  /** Discord snowflake of a channel option. */
  getChannel(name: string): string | null;
  /** Selected subcommand, or null when the command has none. */
  subcommand(): string | null;
}

/** Option kinds a spec may declare. Mirrors the subset of Discord types we use. */
export type OptionType = "string" | "number" | "integer" | "boolean" | "user" | "channel";

const TRUTHY = new Set(["true", "yes", "y", "1", "on"]);
const FALSY = new Set(["false", "no", "n", "0", "off"]);

/**
 * `CommandArgs` over a plain string record — used by the in-game parser (which
 * has only text to work with) and by tests. Coercion is deliberately strict:
 * a malformed number reads as absent rather than NaN, so handlers can treat
 * `null` as "not supplied or not usable" and emit one usage hint.
 */
export function recordArgs(record: Readonly<Record<string, string>>, subcommandName?: string): CommandArgs {
  const raw = (name: string): string | null => {
    const value = record[name];
    return value === undefined || value.trim() === "" ? null : value.trim();
  };

  return {
    getString: raw,
    getNumber(name) {
      const value = raw(name);
      if (value === null) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    },
    getBoolean(name) {
      const value = raw(name)?.toLowerCase();
      if (value === undefined || value === null) return null;
      if (TRUTHY.has(value)) return true;
      if (FALSY.has(value)) return false;
      return null;
    },
    getUser(name) {
      const value = raw(name);
      if (value === null) return null;
      // Accept a raw snowflake or a <@123>/<@!123> mention.
      const mention = /^<@!?(\d{5,25})>$/.exec(value);
      if (mention) return mention[1] ?? null;
      return /^\d{5,25}$/.test(value) ? value : null;
    },
    getChannel(name) {
      const value = raw(name);
      if (value === null) return null;
      const mention = /^<#(\d{5,25})>$/.exec(value);
      if (mention) return mention[1] ?? null;
      return /^\d{5,25}$/.test(value) ? value : null;
    },
    subcommand: () => subcommandName ?? null,
  };
}

/** Empty args, for commands that take none. */
export const noArgs: CommandArgs = recordArgs({});
