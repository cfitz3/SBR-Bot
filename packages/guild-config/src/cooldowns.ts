/**
 * Per-guild cooldown overrides — pure parsing and resolution, no I/O.
 *
 * Every command already carries a `cooldownMs` in its spec, chosen by whoever
 * wrote the command. Those numbers are defaults, not law: a large guild wants a
 * longer floor on the expensive lookups, a quiet one wants none at all. This
 * module is the layer that lets a guild say so.
 *
 * Two things are configurable, and deliberately only two:
 *
 * - **Commands** — a guild-wide default, plus per-command overrides for the
 *   handful a guild actually cares about. Anything unmentioned keeps the spec's
 *   own number, so an empty policy behaves exactly as no policy at all.
 * - **Relay messages** — a floor between one member's relayed chat lines. This
 *   is a comfort setting, *not* the flood control: `flood:` counters still
 *   protect the bridge account from Hypixel's own limit whatever is set here,
 *   and this cannot be raised or lowered into disabling them.
 *
 * Stored in `GuildSetting["config.cooldowns"]`.
 *
 * The `GuildConfig.cooldownDefaults` Json column predates this and is left
 * alone: it has no reader, no writer and no port method, and adding one for a
 * single consumer would buy nothing the settings row does not already give —
 * including cache invalidation and the config broadcast.
 */

export const COOLDOWN_SETTING_KEY = "config.cooldowns";

/** The widest a cooldown may be set. Ten minutes is already absurd; past it, a
 * mistyped value stops looking like a cooldown and starts looking like an
 * outage nobody can explain. */
export const MAX_COOLDOWN_SECONDS = 600;

export interface CooldownPolicy {
  /**
   * Applied to every command with no entry of its own. Null means "leave each
   * command on the number its author chose" — which is not the same as 0, and
   * the difference is the whole reason this is nullable.
   */
  readonly commandDefaultSeconds: number | null;
  /** Command name → seconds. 0 is a legitimate value: no cooldown at all. */
  readonly perCommand: Readonly<Record<string, number>>;
  /** Floor between one author's relayed messages, in seconds. 0 disables it. */
  readonly relaySeconds: number;
}

export const DEFAULT_COOLDOWNS: CooldownPolicy = {
  commandDefaultSeconds: null,
  perCommand: {},
  relaySeconds: 0,
};

function seconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > MAX_COOLDOWN_SECONDS) return null;
  return value;
}

/**
 * Reads a stored policy. Anything unparseable falls back to the default rather
 * than throwing: a corrupt settings row must not stop commands from running.
 */
export function parseCooldowns(raw: unknown): CooldownPolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_COOLDOWNS;
  const o = raw as Record<string, unknown>;

  const rawDefault = o["commandDefaultSeconds"];
  const commandDefaultSeconds =
    rawDefault === null || rawDefault === undefined ? null : seconds(rawDefault);

  const perCommand: Record<string, number> = {};
  const rawPer = o["perCommand"];
  if (typeof rawPer === "object" && rawPer !== null && !Array.isArray(rawPer)) {
    for (const [name, value] of Object.entries(rawPer as Record<string, unknown>)) {
      const s = seconds(value);
      if (s !== null) perCommand[name] = s;
    }
  }

  return {
    commandDefaultSeconds,
    perCommand,
    relaySeconds: seconds(o["relaySeconds"]) ?? 0,
  };
}

/**
 * The cooldown one command should actually use, in milliseconds.
 *
 * Most specific wins: a per-command entry, else the guild default, else the
 * number the command shipped with.
 */
export function resolveCommandCooldownMs(
  policy: CooldownPolicy,
  command: string,
  specMs: number,
): number {
  const own = policy.perCommand[command];
  if (own !== undefined) return own * 1_000;
  if (policy.commandDefaultSeconds !== null) return policy.commandDefaultSeconds * 1_000;
  return specMs;
}
