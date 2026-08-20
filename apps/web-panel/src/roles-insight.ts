/**
 * The Roles page's window onto the roster and the reconciler.
 *
 * Two halves that live in different places — the roster in Postgres, the dirty
 * set and the refusal diagnostics in Redis — joined here rather than in
 * panel-core, which depends on neither. Everything it returns is a read; the
 * dry run this feeds does not queue, mark, or write anything.
 */
import { roleGrantRepository, roleSyncRepository } from "@sbr/db";
import type { RolesInsight } from "@sbr/panel-core";
import type { RedisRoleDirtySet, RedisRoleRefusals } from "@sbr/redis";

export interface RolesInsightDeps {
  readonly dirty: RedisRoleDirtySet;
  readonly refusals: RedisRoleRefusals;
}

export function createRolesInsight(deps: RolesInsightDeps): RolesInsight {
  return {
    async previewMembers(guildId, limit) {
      const everyone = await roleSyncRepository.listMemberIds(guildId);
      // The total is the whole roster even though only a page is loaded: it is
      // what lets the preview say "the first 500 of 1,200" instead of quietly
      // presenting a page as if it were the guild.
      const page = everyone.slice(0, Math.max(0, limit));
      if (page.length === 0) return { members: [], total: everyone.length };

      const [snapshots, ledgers] = await Promise.all([
        roleSyncRepository.loadSnapshots(guildId, page),
        roleGrantRepository.openGrantsByMember(guildId, page),
      ]);

      return {
        members: snapshots.map((snapshot) => ({
          facts: snapshot.facts,
          heldRoleIds: snapshot.heldRoleIds,
          // Absent means no open grants, which is the honest ledger for
          // somebody the reconciler has never acted on.
          ledger: ledgers.get(snapshot.facts.discordId) ?? [],
        })),
        total: everyone.length,
      };
    },

    pendingDirty: (guildId) => deps.dirty.pending(guildId),

    async refusals(guildId) {
      return await deps.refusals.list(guildId);
    },

    clearRefusals: (guildId) => deps.refusals.clear(guildId),
  };
}
