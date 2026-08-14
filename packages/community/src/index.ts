/**
 * @sbr/community — guild events, membership, applications, and RSVP.
 */
export { CommunityServiceImpl, type CommunityServiceDeps, type RsvpError } from "./service.js";
// The ticket domain used to live here as `tickets.ts`. It is `@sbr/tickets`
// now — a package of its own, because the Discord side, the panel and the
// sweep job all need it and none of them should have to pull in events and
// applications to ask whether a member may open a ticket.
export type {
  CommunityRepository,
  EventRsvpInfo,
  LfgInsert,
  LfgPatch,
  PermRoster,
  PermRosterLookup,
  TicketPatch,
} from "./ports.js";
