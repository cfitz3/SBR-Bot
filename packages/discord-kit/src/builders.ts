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
}

/** Discord caps command and option descriptions at 100 characters. */
const MAX_DESCRIPTION = 100;

function clamp(text: string): string {
  return text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION - 1)}…`;
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
    .setDescription(clamp(spec.description)) as SlashCommandOptionsOnlyBuilder;

  // Discord requires every required option to precede the optional ones, so
  // sort rather than trusting each spec to have declared them in order.
  const options = [...(spec.options ?? [])].sort(
    (a, b) => Number(b.required ?? false) - Number(a.required ?? false),
  );
  for (const option of options) addOption(builder, option);
  return builder.toJSON();
}

/** Build the full registration payload from a handler registry. */
export function toSlashCommands(registry: ReadonlyMap<string, CommandSpecLike>): unknown[] {
  return [...registry.values()].map(toSlashCommand);
}
