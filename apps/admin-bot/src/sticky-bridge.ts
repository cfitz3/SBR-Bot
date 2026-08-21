/**
 * The admin bot's client for sticky messages.
 *
 * Split the same way `role-menu-bridge.ts` is. The document is guild settings,
 * and this process has the same database, so listing and writing happen here
 * and work whether or not the bridge is up. Putting the message in the channel
 * is the member-facing bot's job, so that half is one loopback call — and its
 * failure is reported as "not yet", not as a failed command, because the
 * configuration is already saved and the channel will catch up on its own.
 */
import type { StickyBridge, StickySummary } from "@sbr/commands-admin";
import {
  MAX_STICKIES,
  MAX_STICKY_CONTENT,
  STICKY_SETTING_KEY,
  parseStickies,
  removeSticky,
  upsertSticky,
} from "@sbr/guild-config";
import type { GuildConfigService } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";

/** One message write in the community server. */
const TIMEOUT_MS = 10_000;

interface StickyBridgeDeps {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly config: GuildConfigService;
  readonly logger: Logger;
}

export function createStickyBridge(deps: StickyBridgeDeps): StickyBridge {
  async function read(guildId: string) {
    return parseStickies(await deps.config.getSetting(guildId, STICKY_SETTING_KEY));
  }

  /** Ask the bridge to make the channel match what was just saved. */
  async function apply(guildId: string, channelId: string): Promise<boolean> {
    if (deps.token === undefined) return false;
    try {
      const res = await fetch(
        `${deps.baseUrl.replace(/\/+$/, "")}/internal/g/${encodeURIComponent(guildId)}/sticky`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
          body: JSON.stringify({ channelId }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      return res.ok;
    } catch (error) {
      deps.logger.warn("bridge sticky api unreachable", { guildId, channelId, error: String(error) });
      return false;
    }
  }

  return {
    async list(guildId): Promise<readonly StickySummary[]> {
      const doc = await read(guildId);
      return doc.stickies.map((entry) => ({
        channelId: entry.channelId,
        content: entry.content,
        enabled: entry.enabled,
      }));
    },

    async set(guildId, channelId, content) {
      if (content.length > MAX_STICKY_CONTENT) {
        return { ok: false, detail: `a sticky is at most ${String(MAX_STICKY_CONTENT)} characters` };
      }
      const doc = await read(guildId);
      const existing = doc.stickies.some((entry) => entry.channelId === channelId);
      const next = upsertSticky(doc, { channelId, content, enabled: true });
      if (next === null) {
        return { ok: false, detail: `this server already has ${String(MAX_STICKIES)} sticky messages` };
      }

      const saved = await deps.config.setSetting(guildId, STICKY_SETTING_KEY, next);
      if (!saved.ok) return { ok: false, detail: "I couldn't save that just now" };

      return { ok: true, created: !existing, applied: await apply(guildId, channelId) };
    },

    async clear(guildId, channelId) {
      const doc = await read(guildId);
      const next = removeSticky(doc, channelId);
      if (next === null) return { ok: false, detail: "that channel has no sticky" };

      const saved = await deps.config.setSetting(guildId, STICKY_SETTING_KEY, next);
      if (!saved.ok) return { ok: false, detail: "I couldn't save that just now" };

      // Applied after the write, so the bridge re-reads a document that no
      // longer has it and takes the old message down.
      return { ok: true, applied: await apply(guildId, channelId) };
    },
  };
}
