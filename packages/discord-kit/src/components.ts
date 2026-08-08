/**
 * Persistent component routing.
 *
 * RSVP buttons, run sign-ups and application accept/deny have to keep working
 * after a restart, so they cannot rely on a collector living in process memory.
 * Instead every button encodes its own state in the customId —
 * `rsvp:<eventId>:GOING` — and this router dispatches on the leading namespace.
 * The button is therefore stateless: the message rendered last week still routes
 * correctly today.
 *
 * Ephemeral controls (pagination) deliberately do *not* go through here; see
 * `respond.ts`.
 */
import type { ButtonInteraction } from "discord.js";

export const CUSTOM_ID_SEPARATOR = ":";

/** Discord caps customId at 100 characters; over that the payload is rejected. */
const MAX_CUSTOM_ID = 100;

/**
 * Build a routable customId. Segments must not contain the separator — ids and
 * enum names never do, and silently producing an unroutable button would be far
 * worse than failing at the call site.
 */
export function customId(namespace: string, ...segments: string[]): string {
  const parts = [namespace, ...segments];
  for (const part of parts) {
    if (part.includes(CUSTOM_ID_SEPARATOR)) {
      throw new Error(`customId segment must not contain "${CUSTOM_ID_SEPARATOR}": ${part}`);
    }
  }
  const id = parts.join(CUSTOM_ID_SEPARATOR);
  if (id.length > MAX_CUSTOM_ID) throw new Error(`customId exceeds ${MAX_CUSTOM_ID} characters: ${id}`);
  return id;
}

/** Handles one namespace. `segments` excludes the namespace itself. */
export type ComponentHandler = (
  interaction: ButtonInteraction,
  segments: readonly string[],
) => Promise<void>;

export interface ComponentRouterDeps {
  /** Called when a handler throws, so the app can log it its own way. */
  readonly onError?: (namespace: string, error: unknown) => void;
}

export class ComponentRouter {
  private readonly handlers = new Map<string, ComponentHandler>();
  private readonly onError: ((namespace: string, error: unknown) => void) | undefined;

  constructor(deps: ComponentRouterDeps = {}) {
    this.onError = deps.onError;
  }

  register(namespace: string, handler: ComponentHandler): this {
    if (namespace.includes(CUSTOM_ID_SEPARATOR)) {
      throw new Error(`namespace must not contain "${CUSTOM_ID_SEPARATOR}": ${namespace}`);
    }
    this.handlers.set(namespace, handler);
    return this;
  }

  /**
   * Route a button press. Returns false when nothing claims the namespace — the
   * caller decides whether that is a stale button worth telling the user about.
   */
  async handle(interaction: ButtonInteraction): Promise<boolean> {
    const [namespace, ...segments] = interaction.customId.split(CUSTOM_ID_SEPARATOR);
    if (!namespace) return false;
    const handler = this.handlers.get(namespace);
    if (!handler) return false;

    try {
      await handler(interaction, segments);
    } catch (error) {
      this.onError?.(namespace, error);
      // The user pressed a button and must see *something*; a silent failure
      // leaves Discord showing "This interaction failed" with no explanation.
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: "That didn't work — try again in a moment.", ephemeral: true })
          .catch(() => {});
      }
    }
    return true;
  }
}
