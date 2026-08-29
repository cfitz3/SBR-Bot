/**
 * `/lfg` — one member asking for a group, through menus rather than arguments.
 *
 * The old `/lfg` took an activity, a slot count, a title, free-text details and
 * two different ways to name a perm, then made a board post that somebody had to
 * remember to close. Every one of those was a decision taken before the member
 * had anything to show for it, and the board went stale faster than anyone
 * closed a post — which is why the whole board surface was retired.
 *
 * What is left is the thing people actually do: say which floor, say which
 * classes are missing, and let the channel see it. Two menus and a button, in
 * that order, because the floor decides which classes exist to ask for.
 *
 * The rules that shape this file:
 *
 * - **Every control's state is in its customId.** A menu posted before a restart
 *   still works after one, and nothing here reads from process memory. It is the
 *   same contract the perm console and the RSVP buttons hold to.
 * - **The steps are ephemeral; only the post is public.** A member assembling a
 *   request is not news, and three drafts landing in the channel before the real
 *   one is how a looking-for-group channel becomes unreadable.
 * - **Nothing blocks the post that is not the post.** A Hypixel read that fails
 *   costs the card its catacombs line, not the member their group.
 */
import { copy } from "@sbr/brand";
import {
  activityOf,
  floorsFor,
  parseFloor,
  rolesFor,
  RUN_TYPES,
  type DungeonFloor,
  type LFGRunType,
} from "@sbr/perms";
import { LFG_PING_ROLE_SETTING_KEY, type ActionRowView, type SelectOptionView } from "@sbr/shared-types";
import { renderLfgRequestCard, type LfgPlays, type LfgRequestView } from "./render-lfg.js";
import type { CommandReply, HandlerDeps } from "./types.js";

const C = copy.embed.card;

/** The flow's namespace in the component router. */
export const LFG_NS = "lfg";

/**
 * The ping role's setting key, re-exported.
 *
 * It is defined in `@sbr/shared-types` because the panel offers the picker for
 * it and cannot import this package; it is re-exported here because this is the
 * only code that reads it, and a reader looking for what `/lfg` configures
 * should find it in the file that configures it.
 */
export { LFG_PING_ROLE_SETTING_KEY } from "@sbr/shared-types";

/** How the classes ride in a customId. Not `:`, which the router splits on. */
const CLASS_SEPARATOR = ",";

/**
 * A seat nobody has claimed yet is not a class anybody can offer to fill, so it
 * is not something to ask for. `rolesFor` includes it for the perm roster, where
 * it means something different.
 */
const NOT_A_CLASS = "filler";

/**
 * The strings the Discord half needs verbatim, re-exported for the same reason
 * `permConsoleCopy` is: the transport keeps its one dependency on this package,
 * and the words stay in the file with the rules that use them.
 */
export const lfgRequestCopy = {
  pickType: C.lfgPickType,
  pickFloor: C.lfgPickFloor,
  pickClasses: C.lfgPickClasses,
  staleControl: C.lfgStaleControl,
} as const;

/** The words for a run type. Sentence case, because they are read as labels. */
const TYPE_LABELS: Readonly<Record<LFGRunType, string>> = {
  CATACOMBS: "Catacombs",
  MASTER: "Master Mode",
  KUUDRA: "Kuudra",
};

// ─────────────────────────────── Views ───────────────────────────────

/** Step one: what are you running. */
export function typeRows(): readonly ActionRowView[] {
  return [
    {
      buttons: [],
      select: {
        customId: `${LFG_NS}:type`,
        placeholder: C.lfgPickType,
        options: RUN_TYPES.map((type) => ({
          label: TYPE_LABELS[type],
          value: type,
          description: floorSpan(type),
        })),
      },
    },
  ];
}

/** `Entrance – Floor 7`, so the menu says what is behind each option. */
function floorSpan(type: LFGRunType): string {
  const floors = floorsFor(type);
  const first = floors[0];
  const last = floors[floors.length - 1];
  if (first === undefined || last === undefined) return "";
  return first === last ? first.label : `${first.label} – ${last.label}`;
}

/** Step two: which floor of it. */
export function floorRows(type: LFGRunType): readonly ActionRowView[] {
  return [
    {
      buttons: [],
      select: {
        customId: `${LFG_NS}:floor`,
        placeholder: C.lfgPickFloor,
        options: floorsFor(type).map((floor) => ({ label: floor.label, value: floor.code })),
      },
    },
  ];
}

/**
 * Step three: which classes, and the button that ends it.
 *
 * The classes are optional — `minValues: 0` — and the button is present from the
 * moment the floor is known, so "I just need bodies" is one press rather than a
 * menu somebody has to work out how to skip. What has already been chosen comes
 * back marked, because the menu is re-rendered on every pick and a member who
 * cannot see their own selection will make it again.
 */
export function classRows(floor: DungeonFloor, chosen: readonly string[]): readonly ActionRowView[] {
  const classes = rolesFor(activityOf(floor.type)).filter((role) => role !== NOT_A_CLASS);
  const options: SelectOptionView[] = classes.map((role) => ({
    label: titleCase(role),
    value: role,
    ...(chosen.includes(role) ? { default: true } : {}),
  }));

  return [
    {
      buttons: [],
      select: {
        customId: `${LFG_NS}:class:${floor.code}`,
        placeholder: C.lfgPickClasses,
        options,
        minValues: 0,
        maxValues: options.length,
      },
    },
    {
      buttons: [
        {
          label: C.lfgPost,
          style: "PRIMARY",
          customId: `${LFG_NS}:post:${floor.code}:${chosen.join(CLASS_SEPARATOR)}`,
        },
      ],
    },
  ];
}

function titleCase(role: string): string {
  return role.length === 0 ? role : role[0]!.toUpperCase() + role.slice(1);
}

// ────────────────────────────── Replies ──────────────────────────────

/** An ephemeral step: a prompt and the control that answers it. */
function step(text: string, components: readonly ActionRowView[]): CommandReply {
  return { ephemeral: true, text, components };
}

const stale: CommandReply = { ephemeral: true, text: C.lfgStaleControl };

/**
 * The flow, one function per control.
 *
 * Every one of them re-derives its state from the id it was given rather than
 * from anything held between presses, so they are also the whole test surface:
 * `lfg-request.test.ts` calls these directly.
 */
export const lfgRequestReplies = {
  /** `/lfg` with no floor named. */
  start(): CommandReply {
    return step(C.lfgPickType, typeRows());
  },

  chooseType(type: string): CommandReply {
    if (!(RUN_TYPES as readonly string[]).includes(type)) return stale;
    return step(C.lfgPickFloor, floorRows(type as LFGRunType));
  },

  chooseFloor(code: string): CommandReply {
    const floor = parseFloor(code);
    if (floor === null) return stale;
    return step(C.lfgPickClasses, classRows(floor, []));
  },

  chooseClasses(code: string, chosen: readonly string[]): CommandReply {
    const floor = parseFloor(code);
    if (floor === null) return stale;
    return step(C.lfgPickClasses, classRows(floor, canonical(floor, chosen)));
  },

  /**
   * The post itself.
   *
   * Ordered by what it would be rude to waste: the link and the channel are
   * checked before Hypixel is asked anything, so a member who cannot post does
   * not spend a request finding that out.
   */
  async post(
    guildId: string,
    userId: string,
    code: string,
    chosen: readonly string[],
    deps: HandlerDeps,
  ): Promise<CommandReply> {
    const floor = parseFloor(code);
    if (floor === null) return { ephemeral: true, text: C.lfgUnknownFloor.replace("{floor}", code) };

    const linked = await deps.identity.resolveByDiscordId(userId).catch(() => null);
    if (linked === null || !linked.ok || linked.value === null) {
      return { ephemeral: true, text: C.lfgNotLinked };
    }

    const channelId = await deps.config.getChannel(guildId, "lfg").catch(() => null);
    if (channelId === null) return { ephemeral: true, text: C.lfgNoChannel };

    const { minecraftUuid: uuid, ign } = linked.value;
    const request: LfgRequestView = {
      ign,
      uuid,
      discordId: userId,
      floor,
      classes: canonical(floor, chosen),
      requestedAt: new Date().toISOString(),
      ...(await dungeonStats(uuid, floor, deps)),
    };

    const pingRoleId = await roleId(guildId, deps);
    const posted = await deps.lfgAnnouncer
      ?.announce({
        channelId,
        pingRoleId,
        text: pingRoleId === null ? "" : `<@&${pingRoleId}>`,
        embed: renderLfgRequestCard(request),
      })
      .catch(() => false);

    return posted === true
      ? { ephemeral: true, text: C.lfgPosted.replace("{channel}", `<#${channelId}>`) }
      : { ephemeral: true, text: C.lfgPostFailed };
  },
};

/**
 * The requester's own dungeon numbers, or nothing.
 *
 * A failed read is not an error here — it is a card with one less line. The
 * member asked for a group, not for their stats, and refusing the post because
 * Hypixel is rate-limiting us would be punishing them for our budget.
 */
async function dungeonStats(
  uuid: string,
  floor: DungeonFloor,
  deps: HandlerDeps,
): Promise<{ readonly catacombsLevel: number | null; readonly plays: LfgPlays | null }> {
  const result = await deps.progression.getDungeons(uuid).catch(() => null);
  if (result === null || !result.ok) return { catacombsLevel: null, plays: null };

  const data = result.value.data;
  // Kuudra's roles are jobs, so a class level says nothing about the run being
  // asked for and the field is left off rather than filled with something true
  // but irrelevant.
  const plays = activityOf(floor.type) === "DUNGEONS" ? bestClass(data.selectedClass, data.classes) : null;
  return { catacombsLevel: data.catacombsLevel, plays };
}

/**
 * The class they are playing, or failing that the one they have played most.
 *
 * The selected class is the honest answer — it is what they will be in the party
 * as — and the highest is the fallback for a profile that has never picked one.
 */
function bestClass(
  selected: string | null,
  classes: readonly { readonly name: string; readonly level: number }[],
): LfgPlays | null {
  const chosen = selected === null ? null : classes.find((c) => c.name.toLowerCase() === selected.toLowerCase());
  const best = chosen ?? [...classes].sort((a, b) => b.level - a.level)[0];
  return best === undefined ? null : { role: best.name.toLowerCase(), level: best.level };
}

/** The ping role, when it is set and looks like an id. */
async function roleId(guildId: string, deps: HandlerDeps): Promise<string | null> {
  const raw = await deps.config.getSetting<string>(guildId, LFG_PING_ROLE_SETTING_KEY).catch(() => null);
  return typeof raw === "string" && /^\d{17,20}$/.test(raw) ? raw : null;
}

/**
 * The chosen classes, filtered to ones this run actually has and put back into
 * offer order.
 *
 * Order rather than click order because the card is read next to other cards:
 * "Healer, Tank" and "Tank, Healer" are the same request, and reading them as
 * different ones is a cost paid by everyone scanning the channel.
 */
function canonical(floor: DungeonFloor, chosen: readonly string[]): readonly string[] {
  const wanted = new Set(chosen.map((role) => role.trim().toLowerCase()));
  return rolesFor(activityOf(floor.type)).filter((role) => role !== NOT_A_CLASS && wanted.has(role));
}
