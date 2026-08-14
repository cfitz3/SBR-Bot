/**
 * Applying command copy to a registry.
 *
 * The overlay is deliberately **structural**: it asks for a `name`, a
 * `description` and an optional `options` array of the same, and hands back the
 * same object with the prose replaced. That is all `CommandSpec` and
 * `AdminCommandSpec` have in common, and it is all this needs — so
 * `@sbr/brand-defaults` does not depend on either command package, and neither
 * of them needs to know the other exists.
 *
 * Everything else on a spec — `cooldownMs`, `capability`, `inGame`, `minRole`,
 * `destructive`, `handler`, `autocomplete`, `deprecatedBy` — is carried through
 * untouched. Copy changes what a command *says*, never what it *does*.
 */
import type { CommandCopy } from "./defaults/commands.js";

/** The shape an option must have for its description to be overridable. */
export interface CopyableOption {
  readonly name: string;
  readonly description: string;
}

/** The shape a command spec must have. Both registries' specs satisfy it. */
export interface CopyableSpec {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly CopyableOption[];
}

/** The table this reads. `copy.command` satisfies it; so does a test fixture. */
export type CommandCopyTable = Readonly<Record<string, CommandCopy>>;

/**
 * Overlay one spec.
 *
 * A command with no entry in the table, or an option with no entry under its
 * command, keeps the description its spec declares. That is the honest default
 * for a newly added command: it works immediately, it is simply not overridable
 * until somebody adds it to `defaults/commands.ts`.
 */
export function applyCommandCopy<S extends CopyableSpec>(spec: S, table: CommandCopyTable): S {
  const entry = table[spec.name];
  if (entry === undefined) return spec;

  const options = spec.options?.map((option) => {
    const text = entry.option?.[option.name];
    return text === undefined ? option : { ...option, description: text };
  });

  // The cast is TypeScript's long-standing limitation on spreading a generic:
  // `{...spec, description}` is known to be `S & {description: string}`, which
  // is an `S`, but the compiler will not conclude that on its own.
  return {
    ...spec,
    description: entry.description,
    ...(options === undefined ? {} : { options }),
  } as S;
}

/**
 * Overlay a whole registry, preserving iteration order.
 *
 * Applied inside `buildBridgeRegistry()` and `buildAdminRegistry()` — the one
 * place each registry is assembled — so slash registration, `/help`, in-game
 * `!help` and the panel's command docs physically cannot disagree about what a
 * command claims to do.
 */
export function withCommandCopy<S extends CopyableSpec>(
  registry: ReadonlyMap<string, S>,
  table: CommandCopyTable,
): Map<string, S> {
  const out = new Map<string, S>();
  for (const [name, spec] of registry) out.set(name, applyCommandCopy(spec, table));
  return out;
}
