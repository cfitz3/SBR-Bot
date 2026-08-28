/**
 * @sbr/perms — standing parties ("perms") and their rosters.
 *
 * Member-facing by design. Nothing here is reachable from the web panel: who a
 * member runs dungeons with is not staff configuration.
 */
export { PermServiceImpl, type PermServiceDeps } from "./service.js";
export {
  capacityOf,
  classMetricFor,
  classRolesFor,
  normalizeRole,
  rolesFor,
  shapeOf,
  type ActivityShape,
} from "./activities.js";
export type {
  CachedGuildMember,
  GuildMemberDirectory,
  LinkDirectory,
  MemberProgress,
  MemberProgressSource,
  NewPermMemberRow,
  PermGroupRow,
  PermMemberRow,
  PermRepository,
} from "./ports.js";
