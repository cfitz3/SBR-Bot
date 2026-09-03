/**
 * Self-service role menus: the roles a guild has decided members may take
 * themselves, and what a press on one of them means.
 *
 * Pure, like the rest of this package. Nothing here talks to Discord — the
 * bridge bot posts the message and routes the press, and the admin bot's
 * effector is what actually moves a role. This file owns two things:
 *
 * - **The whitelist.** The stored document *is* the list of self-assignable
 *   roles. A press is resolved against it by id rather than trusted from the
 *   button, so a forged custom id can only ever name an option the guild
 *   published; it can never smuggle in a role that was not on the menu. The
 *   effector's own preflight still runs on top of that, so a staff role put on
 *   a menu by mistake is refused a second time before anything moves.
 * - **What a press does.** Toggling is the obvious half; the exclusive mode is
 *   the half worth writing down, because "pick your one colour" has to take the
 *   previous colour away in the same decision — two calls would leave somebody
 *   holding both whenever the second one failed.
 *
 * Tolerant on read, strict on write, as every policy in the platform is.
 */
import { normalizeEmoji } from "@sbr/shared-types";


/** One button on a menu. */
export interface RoleMenuOption {
  /**
   * Stable identity, carried in the button's custom id. Renaming the label or
   * repointing the role keeps buttons posted months ago working.
   */
  readonly key: string;
  readonly roleId: string;
  readonly label: string;
  /** Shown as a line of the embed. Null means no note. */
  readonly description: string | null;
  /** A unicode emoji or `<:name:id>`. Null means a plain button. */
  readonly emoji: string | null;
}

export interface RoleMenu {
  readonly id: string;
  readonly title: string;
  /** The embed body. Empty is allowed — a colour picker explains itself. */
  readonly body: string;
  /** Where it is published. Null means it has never been posted. */
  readonly channelId: string | null;
  /** The posted message, so a republish edits in place instead of littering. */
  readonly messageId: string | null;
  /**
   * Pick one: taking an option gives up the others on this menu.
   *
   * Defaults to false. Toggling is what most menus want, and a menu that
   * silently removed a role somebody already held would be the surprising one.
   */
  readonly exclusive: boolean;
  readonly options: readonly RoleMenuOption[];
}

export interface RoleMenuDoc {
  readonly menus: readonly RoleMenu[];
}

export const ROLE_MENUS_SETTING_KEY = "roles.menus";

/** Nothing published. Installing the platform posts no menus. */
export const DEFAULT_ROLE_MENUS: RoleMenuDoc = Object.freeze({ menus: [] });

/** More menus than this is a channel nobody reads. */
export const MAX_MENUS = 10;

/** Discord fits five buttons to a row and five rows to a message. */
export const MAX_MENU_OPTIONS = 25;

/** Discord's caps on the pieces we render. */
export const MAX_MENU_TITLE = 100;
export const MAX_MENU_BODY = 2_000;
export const MAX_OPTION_LABEL = 80;
export const MAX_OPTION_DESCRIPTION = 200;

/**
 * Ids travel inside a colon-separated custom id, so they may not contain a
 * colon and have to stay short enough that the whole id clears Discord's cap.
 */
export const ROLE_MENU_KEY_SHAPE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const KEY_SHAPE = ROLE_MENU_KEY_SHAPE;
export const MAX_ROLE_MENU_KEY = 32;
const MAX_KEY = MAX_ROLE_MENU_KEY;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function key(value: unknown): string | null {
  const raw = str(value);
  if (raw === null) return null;
  const lowered = raw.toLowerCase();
  return lowered.length <= MAX_KEY && KEY_SHAPE.test(lowered) ? lowered : null;
}

/**
 * The emoji as it should be stored, or none.
 *
 * Read is tolerant, so an emoji Discord would reject becomes no emoji rather
 * than a menu that cannot be posted; the strict half below refuses it on save
 * so nobody has to discover that by the button being bare.
 */
function storedEmoji(raw: unknown): string | null {
  const normalized = normalizeEmoji(str(raw));
  return normalized.ok ? normalized.value : null;
}

function parseOption(raw: unknown): RoleMenuOption | null {
  if (!isRecord(raw)) return null;
  const optionKey = key(raw["key"]);
  const roleId = str(raw["roleId"]);
  if (optionKey === null || roleId === null) return null;
  return {
    key: optionKey,
    roleId,
    label: (str(raw["label"]) ?? optionKey).slice(0, MAX_OPTION_LABEL),
    description: str(raw["description"])?.slice(0, MAX_OPTION_DESCRIPTION) ?? null,
    // Normalised, not copied: `<:star:123>` is stored `star:123`, and anything
    // Discord would reject is dropped rather than carried to a send that would
    // then fail the whole menu message.
    emoji: storedEmoji(raw["emoji"]),
  };
}

function parseMenu(raw: unknown): RoleMenu | null {
  if (!isRecord(raw)) return null;
  const id = key(raw["id"]);
  if (id === null) return null;
  const list = Array.isArray(raw["options"]) ? raw["options"] : [];
  const seen = new Set<string>();
  const options: RoleMenuOption[] = [];
  for (const entry of list) {
    const option = parseOption(entry);
    // Duplicate keys collapse to the first: a press names a key, and two
    // options sharing one would make the press ambiguous.
    if (option === null || seen.has(option.key)) continue;
    seen.add(option.key);
    options.push(option);
  }
  return {
    id,
    title: (str(raw["title"]) ?? id).slice(0, MAX_MENU_TITLE),
    body: (str(raw["body"]) ?? "").slice(0, MAX_MENU_BODY),
    channelId: str(raw["channelId"]),
    messageId: str(raw["messageId"]),
    exclusive: raw["exclusive"] === true,
    options: options.slice(0, MAX_MENU_OPTIONS),
  };
}

/** Read the stored document, dropping only what cannot be understood. */
export function parseRoleMenus(raw: unknown): RoleMenuDoc {
  if (!isRecord(raw)) return DEFAULT_ROLE_MENUS;
  const list = Array.isArray(raw["menus"]) ? raw["menus"] : [];
  const seen = new Set<string>();
  const menus: RoleMenu[] = [];
  for (const entry of list) {
    const menu = parseMenu(entry);
    if (menu === null || seen.has(menu.id)) continue;
    seen.add(menu.id);
    menus.push(menu);
  }
  return { menus };
}

/** The strict half, for the panel: the first thing wrong with this blob, or null. */
export function validateRoleMenus(raw: unknown): string | null {
  if (!isRecord(raw)) return "menus must be an object";
  const list = raw["menus"];
  if (!Array.isArray(list)) return "menus must be a list";
  if (list.length > MAX_MENUS) return `at most ${MAX_MENUS} menus`;
  const seenMenu = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const where = `menu ${index + 1}`;
    if (!isRecord(entry)) return `${where} must be an object`;
    const id = key(entry["id"]);
    if (id === null) return `${where} needs an id of lowercase letters, digits, dots or dashes`;
    if (seenMenu.has(id)) return `${where} repeats the id ${id}`;
    seenMenu.add(id);
    const title = str(entry["title"]);
    if (title === null) return `${where} needs a title`;
    if (title.length > MAX_MENU_TITLE) return `${where}: title is over ${MAX_MENU_TITLE} characters`;
    if (typeof entry["body"] === "string" && entry["body"].length > MAX_MENU_BODY) {
      return `${where}: body is over ${MAX_MENU_BODY} characters`;
    }
    if (entry["exclusive"] !== undefined && typeof entry["exclusive"] !== "boolean") {
      return `${where}: exclusive must be a boolean`;
    }
    const options = entry["options"];
    if (!Array.isArray(options)) return `${where} needs a list of roles`;
    if (options.length === 0) return `${where} has no roles on it`;
    if (options.length > MAX_MENU_OPTIONS) return `${where}: at most ${MAX_MENU_OPTIONS} roles`;
    const seenOption = new Set<string>();
    const seenRole = new Set<string>();
    for (const [i, option] of options.entries()) {
      const spot = `${where}, role ${i + 1}`;
      if (!isRecord(option)) return `${spot} must be an object`;
      const optionKey = key(option["key"]);
      if (optionKey === null) return `${spot} needs a key of lowercase letters, digits, dots or dashes`;
      if (seenOption.has(optionKey)) return `${spot} repeats the key ${optionKey}`;
      seenOption.add(optionKey);
      const roleId = str(option["roleId"]);
      if (roleId === null) return `${spot} needs a role`;
      // The same role twice on one menu makes an exclusive press remove what it
      // just granted, and reads as a duplicate button either way.
      if (seenRole.has(roleId)) return `${spot} offers a role the menu already offers`;
      seenRole.add(roleId);
      const label = str(option["label"]);
      if (label === null) return `${spot} needs a label`;
      if (label.length > MAX_OPTION_LABEL) return `${spot}: label is over ${MAX_OPTION_LABEL} characters`;
      if (option["description"] !== undefined && option["description"] !== null && str(option["description"]) === null) {
        return `${spot} has an empty note`;
      }
      // Refused here rather than at send time: Discord rejects the entire menu
      // message over one bad emoji, and names a component index when it does.
      const emoji = normalizeEmoji(str(option["emoji"]));
      if (!emoji.ok) return `${spot}: ${emoji.reason}`;
    }
  }
  return null;
}

export function findRoleMenu(doc: RoleMenuDoc, menuId: string): RoleMenu | null {
  return doc.menus.find((menu) => menu.id === menuId) ?? null;
}

/** What a press should change, in the presser's held-role terms. */
export interface RoleMenuPress {
  readonly option: RoleMenuOption;
  readonly add: readonly string[];
  readonly remove: readonly string[];
  /** True when the press gave the role rather than taking it back. */
  readonly granted: boolean;
}

/**
 * Resolve a press against the published menu.
 *
 * Null means the button names something this menu no longer offers — a menu
 * edited since it was posted, which is normal and should be answered with "that
 * option is gone" rather than treated as an attack.
 */
export function decideMenuPress(
  menu: RoleMenu,
  optionKey: string,
  heldRoleIds: readonly string[],
): RoleMenuPress | null {
  const option = menu.options.find((o) => o.key === optionKey);
  if (option === undefined) return null;

  const held = new Set(heldRoleIds);
  if (held.has(option.roleId)) {
    // Toggling off is allowed even on an exclusive menu: somebody who no longer
    // wants any of the options should not be forced to keep one.
    return { option, add: [], remove: [option.roleId], granted: false };
  }

  const remove = menu.exclusive
    ? menu.options.filter((o) => o.roleId !== option.roleId && held.has(o.roleId)).map((o) => o.roleId)
    : [];
  return { option, add: [option.roleId], remove, granted: true };
}
