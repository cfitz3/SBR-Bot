/**
 * Command spec → Discord registration payload.
 *
 * The registration list is *derived* from the handler registry rather than
 * maintained beside it. When the two were separate hand-written lists they
 * drifted, and a command could be published to Discord with nothing behind it —
 * the "Unknown command" class of bug. Deriving makes that state unreachable.
 */
import type { OptionType } from "@sbr/shared-types";
import { SlashCommandBuilder, type SlashCommandOptionsOnlyBuilder } from "discord.js";

/** One suggestion in a static choice list. */
export interface ChoiceLike {
  readonly name: string;
  readonly value: string;
}

/**
 * Structural shape shared by `CommandOptionSpec` and `AdminOptionSpec`. Declared
 * here so this package stays independent of both command packages.
 */
export interface OptionSpecLike {
  readonly name: string;
  readonly description: string;
  readonly type: OptionType;
  readonly required?: boolean;
  readonly autocomplete?: boolean;
  readonly choices?: readonly ChoiceLike[];
  readonly minValue?: number;
  readonly maxValue?: number;
}

export interface CommandSpecLike {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly OptionSpecLike[];
  /**
   * Off means the command does not exist as far as Discord is concerned.
   *
   * Defaulting to enabled keeps every existing spec unchanged, and the flag is
   * honoured in three places rather than one — here, in the dispatcher, and in
   * the in-game router — because a command absent from the registry but still
   * accepted by a dispatcher is exactly the "Unknown command" asymmetry this
   * module's header exists to prevent, just pointing the other way.
   */
  readonly enabled?: boolean;
  /** The command that replaced this one; see `describe` below. */
  readonly deprecatedBy?: string;
}

/** Discord caps command and option descriptions at 100 characters. */
const MAX_DESCRIPTION = 100;

function clamp(text: string): string {
  return text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION - 1)}…`;
}

/**
 * What Discord's picker says about a command.
 *
 * A deprecated alias describes itself as one, derived from `deprecatedBy` in
 * exactly the way the dispatcher's notice is. Writing it into the copy layer by
 * hand worked right up until the replacement was renamed again, at which point
 * the picker was confidently pointing at a command that no longer existed —
 * the same class of drift that made the registration list derived in the first
 * place. The spec's own description is not lost: it is what the command says
 * everywhere the alias is not the thing being described.
 */
function describe(spec: CommandSpecLike): string {
  return spec.deprecatedBy === undefined
    ? clamp(spec.description)
    : clamp(`Deprecated — use /${spec.deprecatedBy}`);
}

/** Whether a spec should exist in Discord's registry at all. */
export function isRegistrable(spec: CommandSpecLike): boolean {
  return spec.enabled !== false;
}

function addOption(builder: SlashCommandOptionsOnlyBuilder, spec: OptionSpecLike): void {
  const description = clamp(spec.description);
  const required = spec.required ?? false;

  switch (spec.type) {
    case "string":
      builder.addStringOption((o) => {
        o.setName(spec.name).setDescription(description).setRequired(required);
        // Discord rejects a payload that sets both; choices win because they are
        // the stricter contract.
        if (spec.choices?.length) o.addChoices(...spec.choices.map((c) => ({ name: c.name, value: c.value })));
        else if (spec.autocomplete) o.setAutocomplete(true);
        return o;
      });
      return;
    case "integer":
      builder.addIntegerOption((o) => {
        o.setName(spec.name).setDescription(description).setRequired(required);
        if (spec.minValue !== undefined) o.setMinValue(spec.minValue);
        if (spec.maxValue !== undefined) o.setMaxValue(spec.maxValue);
        if (spec.autocomplete) o.setAutocomplete(true);
        return o;
      });
      return;
    case "number":
      builder.addNumberOption((o) => {
        o.setName(spec.name).setDescription(description).setRequired(required);
        if (spec.minValue !== undefined) o.setMinValue(spec.minValue);
        if (spec.maxValue !== undefined) o.setMaxValue(spec.maxValue);
        if (spec.autocomplete) o.setAutocomplete(true);
        return o;
      });
      return;
    case "boolean":
      builder.addBooleanOption((o) =>
        o.setName(spec.name).setDescription(description).setRequired(required),
      );
      return;
    case "user":
      builder.addUserOption((o) => o.setName(spec.name).setDescription(description).setRequired(required));
      return;
    case "channel":
      builder.addChannelOption((o) => o.setName(spec.name).setDescription(description).setRequired(required));
      return;
  }
}

/** Build the JSON payload for one command spec. */
export function toSlashCommand(spec: CommandSpecLike): unknown {
  const builder = new SlashCommandBuilder()
    .setName(spec.name)
    .setDescription(describe(spec)) as SlashCommandOptionsOnlyBuilder;

  // Discord requires every required option to precede the optional ones, so
  // sort rather than trusting each spec to have declared them in order.
  const options = [...(spec.options ?? [])].sort(
    (a, b) => Number(b.required ?? false) - Number(a.required ?? false),
  );
  for (const option of options) addOption(builder, option);
  return builder.toJSON();
}

/**
 * Build the full registration payload from a handler registry.
 *
 * Disabled specs are dropped, which is what makes `enabled: false` a real
 * removal: the command disappears from Discord's list on the next deploy
 * instead of staying in the picker and answering with an error, which reads to
 * a member as a broken bot rather than as a retired feature.
 */
export function toSlashCommands(registry: ReadonlyMap<string, CommandSpecLike>): unknown[] {
  return [...registry.values()].filter(isRegistrable).map(toSlashCommand);
}
