/**
 * The `/perm` console — perms created and edited through components, not
 * through typed command arguments.
 *
 * `/perm action:roster-add perm:"F7 core" ign:Aria role:healer slot:2` asked a
 * member to know four things before they could do one: the exact name of the
 * perm, the exact spelling of an IGN, which role words this activity accepts,
 * and that `slot` existed at all. Every one of those was a way to get an error
 * instead of a party, and three of the four are things the platform already
 * knows. So they are dropped down now: the perms are a menu, the roles are a
 * menu built from the activity's own shape, and the seat is the next free one.
 *
 * What is left to type is a name for a new party and, when an owner is adding
 * somebody who has not linked, a Minecraft name. Both go through a modal, which
 * is where free text belongs — a modal is answered in place and validated on
 * submit, rather than being typed into a command line in front of the channel.
 *
 * Every control's whole state is in its customId, exactly as the RSVP and run
 * buttons do it: a console posted before a restart still works after one, and
 * nothing here reads from process memory.
 */
import { copy } from "@sbr/brand";
import { capacityOf, rolesFor } from "@sbr/perms";
import type {
  ActionRowView,
  ButtonView,
  LFGActivity,
  PermError,
  PermGroupDTO,
  PermMemberDTO,
  SelectOptionView,
} from "@sbr/shared-types";
import { permProblem } from "./perm-errors.js";
import { renderPermCard, renderPermListPages } from "./render-perms.js";
import type { CommandReply, HandlerDeps } from "./types.js";

const C = copy.embed.card;

/** The console's namespace in the component router. */
export const PERM_NS = "perm";

/** Discord's own cap on a select menu. */
const MENU_MAX = 25;

/** Perms named in the guild-chat summary line, which has 256 characters. */
const CHAT_MAX = 10;

/** Modal ids. Free text is the only thing that reaches one. */
export const PERM_NAME_MODAL = `${PERM_NS}:name`;
export const PERM_IGN_MODAL = `${PERM_NS}:ign`;

/**
 * The strings the Discord half needs verbatim.
 *
 * Re-exported rather than reached for through `@sbr/brand` in `apps/`, so the
 * transport keeps its one dependency on this package and the console's words
 * stay in one file with the console's rules.
 */
export const permConsoleCopy = {
  staleControl: C.permStaleControl,
  pickActivity: C.permPickActivity,
  pickRole: C.permPickRole,
  nameModalTitle: C.permNameModalTitle,
  nameLabel: C.permNameLabel,
  notesLabel: C.permNotesLabel,
  ignModalTitle: C.permIgnModalTitle,
  ignLabel: C.permIgnLabel,
} as const;

const ACTIVITIES: readonly LFGActivity[] = ["DUNGEONS", "KUUDRA", "SLAYERS", "FISHING", "MINING", "OTHER"];

// ─────────────────────────────── Views ───────────────────────────────

/**
 * The console: the guild's perms, and the controls to open or start one.
 *
 * Public rather than ephemeral, like the list it replaces — half the point of a
 * perm is other people seeing that a five-stack already exists before starting a
 * sixth. The controls are safe to share: every one of them re-checks who pressed
 * it against the perm it names.
 */
export async function permConsole(guildId: string, page: number, deps: HandlerDeps): Promise<CommandReply> {
  const result = await deps.perms.listPerms(guildId);
  if (!result.ok) return { ephemeral: true, text: C.permUnavailable };

  const perms = result.value;
  const pages = renderPermListPages(perms, false);
  const index = Math.min(Math.max(page, 0), pages.length - 1);
  const embed = pages[index];

  return {
    ephemeral: false,
    text: chatSummary(perms),
    ...(embed === undefined ? {} : { embed }),
    components: consoleRows(perms, index, pages.length),
  };
}

/** One perm, with the controls that act on it. */
export async function permView(
  guildId: string,
  idOrName: string,
  userId: string,
  deps: HandlerDeps,
): Promise<CommandReply> {
  const result = await deps.perms.getPerm(guildId, idOrName);
  if (!result.ok) return problem(result.error);

  const perm = result.value;
  const mine = await mayEdit(perm, userId, guildId, deps);
  return {
    ephemeral: false,
    text: permChatSummary(perm),
    embed: renderPermCard(perm),
    components: permRows(perm, userId, mine),
  };
}

/** The list card's own controls: pick one, page through them, start one. */
function consoleRows(
  perms: readonly PermGroupDTO[],
  page: number,
  pageCount: number,
): readonly ActionRowView[] {
  const rows: ActionRowView[] = [];

  if (perms.length > 0) {
    rows.push({
      buttons: [],
      select: {
        customId: `${PERM_NS}:open`,
        placeholder: "Open a party",
        // The menu is the whole guild's perms rather than this page's, up to
        // Discord's own cap: paging the card and the menu separately would mean
        // the thing you can see is not the thing you can pick.
        options: perms.slice(0, MENU_MAX).map(permOption),
      },
    });
  }

  const buttons: ButtonView[] = [{ label: "New party", style: "PRIMARY", customId: `${PERM_NS}:new` }];
  if (pageCount > 1) {
    buttons.push(
      { label: "Back", style: "SECONDARY", customId: `${PERM_NS}:page:${page - 1}`, disabled: page === 0 },
      {
        label: "Next",
        style: "SECONDARY",
        customId: `${PERM_NS}:page:${page + 1}`,
        disabled: page >= pageCount - 1,
      },
    );
  }
  rows.push({ buttons });
  return rows;
}

function permOption(perm: PermGroupDTO): SelectOptionView {
  return {
    label: perm.name.slice(0, 100),
    value: perm.id,
    description: `${copy.embed.activity[perm.activity]} · ${perm.members.length}/${perm.capacity}`.slice(0, 100),
  };
}

/**
 * A perm's own controls.
 *
 * The seat menu is offered only where it can do anything — a live party with
 * room, to somebody not already in it — because a dropdown that answers every
 * choice with an error is worse than no dropdown. What an owner can do beyond
 * that is buttons, and every one of them re-checks the presser rather than
 * trusting that it was only ever shown to somebody allowed to press it.
 */
function permRows(perm: PermGroupDTO, userId: string, mine: boolean): readonly ActionRowView[] {
  const live = perm.status !== "DISBANDED";
  const full = perm.members.length >= perm.capacity;
  const seated = perm.members.some((m) => m.discordId === userId);
  const rows: ActionRowView[] = [];

  if (live && !full && !seated) {
    rows.push({
      buttons: [],
      select: {
        customId: `${PERM_NS}:seat:${perm.id}`,
        placeholder: "Take a seat",
        options: rolesFor(perm.activity).map((role) => ({ label: titleCase(role), value: role })),
      },
    });
  }

  rows.push({
    buttons: [
      { label: "Leave", style: "SECONDARY", customId: `${PERM_NS}:leave:${perm.id}`, disabled: !live || !seated },
      {
        label: "Add someone",
        style: "SECONDARY",
        customId: `${PERM_NS}:add:${perm.id}`,
        disabled: !live || !mine || full,
      },
      { label: "Set default", style: "SECONDARY", customId: `${PERM_NS}:default:${perm.id}`, disabled: !live || !mine },
      { label: "Disband", style: "DANGER", customId: `${PERM_NS}:disband:${perm.id}`, disabled: !live || !mine },
      { label: "All parties", style: "SECONDARY", customId: `${PERM_NS}:page:0` },
    ],
  });

  if (live && mine && perm.members.length > 0) {
    rows.push({
      buttons: [],
      select: {
        customId: `${PERM_NS}:drop:${perm.id}`,
        placeholder: "Remove someone",
        options: perm.members.slice(0, MENU_MAX).map(seatOption),
      },
    });
  }
  return rows;
}

/**
 * A seat, as a menu entry.
 *
 * The value carries the role as well as the IGN because the roster is keyed by
 * both — the same player may hold two seats, and dropping "Aria" without saying
 * which one would be a coin toss.
 */
function seatOption(member: PermMemberDTO): SelectOptionView {
  return {
    label: `${member.ign} — ${titleCase(member.role)}`.slice(0, 100),
    value: `${member.role}/${member.ign}`.slice(0, 100),
  };
}

function titleCase(role: string): string {
  return role.length === 0 ? role : role[0]!.toUpperCase() + role.slice(1);
}

/** The activities, as a menu. Chosen before the name so the modal can say it. */
export function activityRows(): readonly ActionRowView[] {
  return [
    {
      buttons: [],
      select: {
        customId: `${PERM_NS}:activity`,
        placeholder: "What does it run?",
        options: ACTIVITIES.map((activity) => ({
          label: copy.embed.activity[activity],
          value: activity,
          description: `${String(capacityOf(activity))} seats`,
        })),
      },
    },
  ];
}

/** The roles of an activity, as a menu — for an owner adding somebody else. */
export function addRoleRows(permId: string, activity: LFGActivity): readonly ActionRowView[] {
  return [
    {
      buttons: [],
      select: {
        customId: `${PERM_NS}:addrole:${permId}`,
        placeholder: "Which role?",
        options: rolesFor(activity).map((role) => ({ label: titleCase(role), value: role })),
      },
    },
  ];
}

// ─────────────────────────── Component actions ───────────────────────────

/**
 * What each control does, as plain functions of their state.
 *
 * The transport's only job is to unpack the customId and hand the pieces over,
 * exactly as it does for RSVP and run buttons — so the console is testable
 * without a Discord client, and the rules it enforces are the command's rules
 * because they are the command's code.
 */
export const permConsoleReplies = {
  /** `perm:open` — a menu choice. */
  async open(guildId: string, permId: string, userId: string, deps: HandlerDeps): Promise<CommandReply> {
    return permView(guildId, permId, userId, deps);
  },

  /** `perm:page:<n>` — the list again, at a page. */
  async page(guildId: string, page: number, deps: HandlerDeps): Promise<CommandReply> {
    return permConsole(guildId, page, deps);
  },

  /**
   * `perm:name` — the new-party modal, submitted.
   *
   * The activity rode in the modal's own id, so a member who took a minute over
   * the name does not lose the choice they already made.
   */
  async create(
    guildId: string,
    userId: string,
    activity: LFGActivity,
    name: string,
    notes: string,
    deps: HandlerDeps,
  ): Promise<CommandReply> {
    const result = await deps.perms.createPerm({
      guildId,
      ownerDiscordId: userId,
      name: name.trim(),
      activity,
      ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
    });
    if (!result.ok) return problem(result.error);
    return permView(guildId, result.value.id, userId, deps);
  },

  /**
   * `perm:seat:<id>` — the presser takes a seat in the role they picked.
   *
   * Their own IGN, from their link, rather than a typed one: somebody taking a
   * seat for themselves has no business spelling their own name, and an unlinked
   * member is told what to do about it rather than told the name was wrong.
   */
  async seat(
    guildId: string,
    permId: string,
    userId: string,
    role: string,
    deps: HandlerDeps,
  ): Promise<CommandReply> {
    const ign = await ownIgn(userId, deps);
    if (ign === null) return { ephemeral: true, text: C.permNotLinked };
    return rosterChange(guildId, permId, userId, ign, role, "add", deps);
  },

  /** `perm:leave:<id>` — every seat the presser holds, in one press. */
  async leave(guildId: string, permId: string, userId: string, deps: HandlerDeps): Promise<CommandReply> {
    const current = await deps.perms.getPerm(guildId, permId);
    if (!current.ok) return problem(current.error);

    const seats = current.value.members.filter((m) => m.discordId === userId);
    if (seats.length === 0) return { ephemeral: true, text: C.permNotSeated };

    let last: CommandReply | null = null;
    for (const seat of seats) {
      last = await rosterChange(guildId, permId, userId, seat.ign, seat.role, "remove", deps);
    }
    return last ?? { ephemeral: true, text: C.permNotSeated };
  },

  /** `perm:drop:<id>` — an owner removing a named seat, chosen from the menu. */
  async drop(
    guildId: string,
    permId: string,
    userId: string,
    seatValue: string,
    deps: HandlerDeps,
  ): Promise<CommandReply> {
    const cut = seatValue.indexOf("/");
    if (cut <= 0) return { ephemeral: true, text: C.permStaleControl };
    return rosterChange(guildId, permId, userId, seatValue.slice(cut + 1), seatValue.slice(0, cut), "remove", deps);
  },

  /** `perm:ign` — the add-someone modal, submitted with the role already chosen. */
  async add(
    guildId: string,
    permId: string,
    userId: string,
    role: string,
    ign: string,
    deps: HandlerDeps,
  ): Promise<CommandReply> {
    return rosterChange(guildId, permId, userId, ign.trim(), role, "add", deps);
  },

  async setDefault(guildId: string, permId: string, userId: string, deps: HandlerDeps): Promise<CommandReply> {
    const result = await deps.perms.setDefaultPerm(guildId, permId, await actor(userId, guildId, deps));
    if (!result.ok) return problem(result.error);
    return permView(guildId, permId, userId, deps);
  },

  async disband(guildId: string, permId: string, userId: string, deps: HandlerDeps): Promise<CommandReply> {
    const result = await deps.perms.disbandPerm(guildId, permId, await actor(userId, guildId, deps));
    if (!result.ok) return problem(result.error);
    return permView(guildId, permId, userId, deps);
  },
};

// ─────────────────────────────── Plumbing ───────────────────────────────

async function rosterChange(
  guildId: string,
  permId: string,
  userId: string,
  ign: string,
  role: string,
  direction: "add" | "remove",
  deps: HandlerDeps,
): Promise<CommandReply> {
  const change = { guildId, idOrName: permId, actor: await actor(userId, guildId, deps), ign, role };
  const result =
    direction === "add" ? await deps.perms.addToRoster(change) : await deps.perms.removeFromRoster(change);
  if (!result.ok) return problem(result.error);
  return permView(guildId, permId, userId, deps);
}

/**
 * `MENTION` is the moderator floor in the capability table, which is the line
 * the rest of the member surface treats as staff. A failed lookup degrades to
 * "not staff", which is the safe direction.
 */
async function actor(
  userId: string,
  guildId: string,
  deps: HandlerDeps,
): Promise<{ readonly discordId: string; readonly isStaff: boolean }> {
  return {
    discordId: userId,
    isStaff: await deps.identity.hasCapability(guildId, userId, "MENTION").catch(() => false),
  };
}

/** Whether this person may edit this perm — the same rule `@sbr/perms` applies. */
async function mayEdit(
  perm: PermGroupDTO,
  userId: string,
  guildId: string,
  deps: HandlerDeps,
): Promise<boolean> {
  if (perm.ownerDiscordId === userId) return true;
  return deps.identity.hasCapability(guildId, userId, "MENTION").catch(() => false);
}

/** The presser's own IGN, or null if they have not linked an account. */
async function ownIgn(userId: string, deps: HandlerDeps): Promise<string | null> {
  const link = await deps.identity.resolveByDiscordId(userId).catch(() => null);
  if (link === null || !link.ok || link.value === null) return null;
  return link.value.ign;
}

function problem(error: PermError): CommandReply {
  return { ephemeral: true, text: permProblem(error) };
}

/** The guild-chat line for the console — no embeds in game, 256 characters. */
function chatSummary(perms: readonly PermGroupDTO[]): string {
  return perms.length === 0
    ? C.permNone
    : perms
        .slice(0, CHAT_MAX)
        .map((p) => `${p.name} ${p.members.length}/${p.capacity}`)
        .join(" | ");
}

function permChatSummary(perm: PermGroupDTO): string {
  const roster = perm.members.map((m) => `${m.ign}(${m.role})`).join(" ");
  return `${perm.name} [${perm.members.length}/${perm.capacity}] ${roster}`.trim();
}
