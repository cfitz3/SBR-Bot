/**
 * Self-service role menus, the bridge bot's half.
 *
 * `@sbr/roles/menus` decides what a press means and holds the whitelist; this
 * decides nothing about roles at all. It renders the published message, routes
 * the press, and asks the admin bot's effector to carry it out.
 *
 * Three things here are load-bearing:
 *
 * - **The button is not trusted.** A press carries a menu id and an option key,
 *   and both are looked up in the stored document before anything moves. The
 *   role id never travels in the custom id, so a hand-crafted press can only
 *   ever name a role the guild published on that menu — and the effector's own
 *   preflight refuses staff roles on top of that.
 * - **The reply says what happened, not what was asked for.** The note is built
 *   from the effector's `added`/`removed`, so an unreachable admin bot or a
 *   refused role reads as a failure rather than a cheerful lie.
 * - **Publishing edits in place.** The menu remembers its message, so pressing
 *   Publish twice updates the post instead of leaving a dead set of buttons
 *   above a live one — and a dead set is worse than none, because it looks
 *   exactly like the working one.
 */
import { customId } from "@sbr/discord-kit";
import type { ActionRowView, ButtonView, EmbedView } from "@sbr/shared-types";
import {
  ROLE_MENUS_SETTING_KEY,
  decideMenuPress,
  findRoleMenu,
  parseRoleMenus,
  type RoleMenu,
  type RoleMenuDoc,
} from "@sbr/roles";
import type { Logger } from "@sbr/observability";
import type { BridgeRoleEffector } from "./role-effector.js";

/** The component-router namespace. `rmenu:<menuId>:<optionKey>`. */
export const ROLE_MENU_NAMESPACE = "rmenu";

/** Discord fits five buttons to a row. */
const PER_ROW = 5;

export interface RoleMenuConfigPort {
  getSetting<T>(guildId: string, key: string): Promise<T | null>;
  setSetting(guildId: string, key: string, value: unknown): Promise<unknown>;
}

/** The two message writes a published menu needs. */
export interface RoleMenuMessagePort {
  /** The new message's id, or null when the channel could not be posted to. */
  post(channelId: string, embed: EmbedView, rows: readonly ActionRowView[]): Promise<string | null>;
  /** False when the message is gone — the caller posts a fresh one. */
  edit(channelId: string, messageId: string, embed: EmbedView, rows: readonly ActionRowView[]): Promise<boolean>;
}

export interface RoleMenuDeps {
  readonly config: RoleMenuConfigPort;
  readonly messages: RoleMenuMessagePort;
  readonly roles: BridgeRoleEffector;
  readonly log: Logger;
}

export type PublishResult =
  | { readonly ok: true; readonly channelId: string; readonly messageId: string; readonly edited: boolean }
  | { readonly ok: false; readonly problem: string; readonly detail: string };

export type PressResult = { readonly ok: true; readonly note: string } | { readonly ok: false; readonly detail: string };

// ── rendering ────────────────────────────────────────────────────────────────

/**
 * The embed and its buttons.
 *
 * Every button is SECONDARY. One message is read by everybody, so there is no
 * "you have this one" state to colour: styling a button as held would be right
 * for whoever published it and wrong for everyone else.
 */
export function renderRoleMenu(menu: RoleMenu): { embed: EmbedView; rows: readonly ActionRowView[] } {
  const notes = menu.options
    .filter((option) => option.description !== null)
    .map((option) => `**${option.label}** — ${option.description ?? ""}`);
  const description = [menu.body, ...notes].filter((line) => line !== "").join("\n");

  const buttons: ButtonView[] = menu.options.map((option) => ({
    label: option.label,
    style: "SECONDARY" as const,
    customId: customId(ROLE_MENU_NAMESPACE, menu.id, option.key),
    ...(option.emoji === null ? {} : { emoji: option.emoji }),
  }));

  const rows: ActionRowView[] = [];
  for (let i = 0; i < buttons.length; i += PER_ROW) rows.push({ buttons: buttons.slice(i, i + PER_ROW) });

  return {
    embed: {
      title: menu.title,
      ...(description === "" ? {} : { description }),
      color: "NEUTRAL",
      footer: menu.exclusive ? "Pick one — taking another gives up the last." : "Press again to take it back.",
    },
    rows,
  };
}

// ── the gateway ──────────────────────────────────────────────────────────────

export class RoleMenuGateway {
  private readonly d: RoleMenuDeps;

  constructor(deps: RoleMenuDeps) {
    this.d = deps;
  }

  async menus(guildId: string): Promise<RoleMenuDoc> {
    return parseRoleMenus(await this.d.config.getSetting(guildId, ROLE_MENUS_SETTING_KEY));
  }

  /**
   * Post or update one menu.
   *
   * `channelId` overrides where it lives — that is what `/rolemenu post` in a
   * channel means. Without one it goes back where it was, which is what the
   * panel's Publish means.
   */
  async publish(guildId: string, menuId: string, channelId: string | null): Promise<PublishResult> {
    const doc = await this.menus(guildId);
    const menu = findRoleMenu(doc, menuId);
    if (menu === null) return { ok: false, problem: "NO_MENU", detail: "there is no menu with that id" };

    const target = channelId ?? menu.channelId;
    if (target === null) {
      return { ok: false, problem: "NO_CHANNEL", detail: "that menu has no channel yet — post it in one first" };
    }
    if (menu.options.length === 0) {
      return { ok: false, problem: "EMPTY", detail: "that menu has no roles on it yet" };
    }

    const { embed, rows } = renderRoleMenu(menu);
    // Moving channel means the old post is orphaned, so it is never edited: a
    // menu that moved should not keep answering presses in the old channel.
    const sameChannel = menu.messageId !== null && target === menu.channelId;
    const edited = sameChannel && (await this.d.messages.edit(target, menu.messageId ?? "", embed, rows));

    let messageId = menu.messageId;
    if (!edited) {
      const posted = await this.d.messages.post(target, embed, rows);
      if (posted === null) {
        return { ok: false, problem: "CANNOT_POST", detail: "I cannot post in that channel — check my permissions" };
      }
      messageId = posted;
    }

    await this.remember(guildId, doc, menuId, target, messageId ?? "");
    return { ok: true, channelId: target, messageId: messageId ?? "", edited };
  }

  /**
   * A member pressed a button.
   *
   * `heldRoleIds` comes from the interaction's own member, which is why this
   * never fetches: the press already carries who pressed it and what they hold,
   * and a second fetch inside the three-second window is a second way to run out
   * of it.
   */
  async press(
    guildId: string,
    menuId: string,
    optionKey: string,
    userId: string,
    heldRoleIds: readonly string[],
  ): Promise<PressResult> {
    const menu = findRoleMenu(await this.menus(guildId), menuId);
    if (menu === null) return { ok: false, detail: "That menu isn't offered here any more." };

    const press = decideMenuPress(menu, optionKey, heldRoleIds);
    if (press === null) return { ok: false, detail: "That option isn't on the menu any more." };

    const outcome = await this.d.roles.apply(
      guildId,
      userId,
      press.add,
      press.remove,
      `role menu ${menu.id}: ${press.option.key}`,
    );

    if (!outcome.memberPresent) return { ok: false, detail: "I couldn't find you in this server." };
    if (!outcome.ok) {
      const refusal = outcome.refused.find((row) => row.roleId === press.option.roleId);
      this.d.log.warn("role menu press not applied", { guildId, menuId, optionKey, userId });
      return {
        ok: false,
        detail:
          refusal === undefined
            ? "I couldn't change your roles just now — try again in a moment."
            : `I can't hand out **${press.option.label}**: ${refusal.detail}.`,
      };
    }

    // Built from what the effector did, not from what was asked. Pressing a
    // role you already hold — held by another rule, say — is a no-op there, and
    // saying "given" would be wrong.
    if (press.granted) {
      if (!outcome.added.includes(press.option.roleId)) {
        return { ok: false, detail: `You already have **${press.option.label}**.` };
      }
      const swapped = outcome.removed.length;
      return {
        ok: true,
        note:
          swapped === 0
            ? `You now have **${press.option.label}**.`
            : `You now have **${press.option.label}** instead.`,
      };
    }

    return outcome.removed.includes(press.option.roleId)
      ? { ok: true, note: `Taken **${press.option.label}** back.` }
      : { ok: false, detail: `You don't have **${press.option.label}**.` };
  }

  /**
   * Record where a menu was posted.
   *
   * A whole-document write, like every other list in the platform: merging one
   * menu into a stored list on the server makes "I deleted that menu" and "I
   * never had it" indistinguishable.
   */
  private async remember(
    guildId: string,
    doc: RoleMenuDoc,
    menuId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const menus = doc.menus.map((menu) => (menu.id === menuId ? { ...menu, channelId, messageId } : menu));
    await this.d.config.setSetting(guildId, ROLE_MENUS_SETTING_KEY, { menus });
  }
}
