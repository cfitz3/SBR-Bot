/**
 * The admin bot's client for self-service role menus.
 *
 * Split down the middle on purpose. Listing them is a settings read, and this
 * process has the same database, so `/rolemenu list` answers locally and works
 * even when the bridge is down. Posting one is a message in the community
 * server, where the *member-facing* bot holds the gateway — and it must stay
 * that bot's message, because members press its buttons.
 *
 * Failure is words rather than a thrown error: the caller is a slash command
 * replying to a staffer who is standing there waiting.
 */
import type { RoleMenuBridge, RoleMenuSummary } from "@sbr/commands-admin";
import type { GuildConfigService } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { ROLE_MENUS_SETTING_KEY, parseRoleMenus } from "@sbr/roles";

/** One message write, plus the bridge's own settings read. */
const TIMEOUT_MS = 10_000;

interface RoleMenuBridgeDeps {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly config: GuildConfigService;
  readonly logger: Logger;
}

export function createRoleMenuBridge(deps: RoleMenuBridgeDeps): RoleMenuBridge {
  return {
    async list(guildId): Promise<readonly RoleMenuSummary[]> {
      const doc = parseRoleMenus(await deps.config.getSetting(guildId, ROLE_MENUS_SETTING_KEY));
      return doc.menus.map((menu) => ({
        id: menu.id,
        title: menu.title,
        optionCount: menu.options.length,
        channelId: menu.channelId,
      }));
    },

    async publish(guildId, menuId, channelId) {
      if (deps.token === undefined) return { ok: false, detail: "the bridge bot isn't wired to this one" };
      try {
        const res = await fetch(
          `${deps.baseUrl.replace(/\/+$/, "")}/internal/g/${encodeURIComponent(guildId)}/role-menu`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
            body: JSON.stringify({ menuId, channelId }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          const detail = body["detail"];
          if (typeof detail === "string" && detail !== "") return { ok: false, detail };
          if (res.status === 401) return { ok: false, detail: "INTERNAL_API_TOKEN differs between the two bots" };
          return { ok: false, detail: `the bridge refused that (${String(res.status)})` };
        }
        return { ok: true, edited: body["edited"] === true };
      } catch (error) {
        deps.logger.warn("bridge role menu api unreachable", { guildId, menuId, error: String(error) });
        return { ok: false, detail: "the bridge bot isn't reachable" };
      }
    },
  };
}
