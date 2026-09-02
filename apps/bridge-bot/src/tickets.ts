/**
 * The Discord half of the ticket system.
 *
 * `@sbr/tickets` decides things and touches nothing; `@sbr/community` writes
 * rows. This is the part that has to actually create a channel, post a panel,
 * capture what was said in it and hand somebody a transcript — the only part
 * that needs a gateway connection, which is why it lives in the bridge rather
 * than in a package.
 *
 * Every side effect is behind a port, so the whole flow is testable without a
 * Discord client. `tickets-discord.ts` holds the discord.js implementations of
 * those ports and the interaction routing; nothing in this file imports
 * discord.js, and that separation is what lets the interesting cases — a member
 * on cooldown, a category whose staff role was deleted, a channel that could
 * not be created — be asserted rather than reasoned about.
 *
 * Three rules run through the whole file:
 *
 * - **The row is written before the channel, and bound after.** The channel
 *   name interpolates `{num}`, which does not exist until the row does. A
 *   channel that gets created but never bound is visible and recoverable; a
 *   ticket row pointing at a channel that was never made is not.
 * - **A failure to post is never a failure to open.** If the opening message
 *   cannot be sent, the ticket still exists and the member is still told where
 *   it is. The conversation is the point; the embed is decoration.
 * - **Staff-ness is decided from roles, here, once.** Every lifecycle call
 *   takes a `TicketActor` whose `isStaff` was computed from the category's own
 *   staff roles — never from a caller's assertion.
 */
import {
  RESUME_MESSAGE_COUNT,
  averageRating,
  averageResolutionTimeMs,
  averageResponseTimeMs,
  channelName,
  evaluateEligibility,
  expand,
  findCategory,
  renderPanel,
  sweep,
  ticketControls,
  toHtml,
  toMarkdown,
  transcriptFilename,
  type Eligibility,
  type SweepAction,
  type TranscriptHeader,
} from "@sbr/tickets";
import type { Logger } from "@sbr/observability";
import type {
  BridgeCapability,
  ActionRowView,
  CommunityService,
  EmbedView,
  GuildConfigService,
  TicketAttachmentDTO,
  TicketCategoryDTO,
  TicketDTO,
  TicketMessageDTO,
  TicketPanelDTO,
  TicketSettingsDTO,
} from "@sbr/shared-types";
import { copy } from "@sbr/brand";

const E = copy.error;

// ── ports ────────────────────────────────────────────────────────────────────

/** Ticket configuration, as stored by the panel. Read-mostly. */
export interface TicketConfigPort {
  settings(guildId: string): Promise<TicketSettingsDTO>;
  categories(guildId: string): Promise<readonly TicketCategoryDTO[]>;
  panel(guildId: string, panelId: string): Promise<TicketPanelDTO | null>;
  /** Where a panel was last posted. A null `messageId` un-records a lost message. */
  recordPanelMessage(
    guildId: string,
    panelId: string,
    channelId: string,
    messageId: string | null,
  ): Promise<void>;
}

/** The transcript store, and the two ticket writes the community service lacks. */
export interface TicketArchivePort {
  record(
    input: {
      readonly ticketId: string;
      readonly discordMessageId: string;
      readonly authorDiscordId: string;
      readonly authorTag: string;
      readonly content: string;
      readonly attachments: readonly TicketAttachmentDTO[];
      readonly createdAt: Date;
    },
    fromStaff: boolean,
  ): Promise<void>;
  markEdited(discordMessageId: string, content: string, at: Date): Promise<void>;
  markDeleted(discordMessageId: string, at: Date): Promise<void>;
  messages(ticketId: string): Promise<readonly TicketMessageDTO[]>;
  /** Bind a freshly created channel to the ticket it was made for. */
  bindChannel(ticketId: string, channelId: string): Promise<void>;
  /** Recent tickets in the guild — the input to the `{avg*}` placeholders. */
  recent(guildId: string, limit: number): Promise<readonly TicketDTO[]>;
  /** Messages captured since a close request, for the sweep's resume check. */
  countSince(ticketId: string, since: Date): Promise<number>;
}

/** A message this file wants posted somewhere. */
export interface OutboundMessage {
  readonly content?: string;
  readonly embeds?: readonly EmbedView[];
  readonly components?: readonly ActionRowView[];
  /**
   * Who may be pinged. Absent means nobody: most strings in a ticket message
   * were typed by an admin into a settings page, and an `@everyone` in an
   * opening message must not become a server-wide ping the first time somebody
   * opens a ticket.
   */
  readonly mentionUsers?: readonly string[];
  readonly mentionRoles?: readonly string[];
  readonly file?: { readonly name: string; readonly content: string };
}

export interface NewChannelRequest {
  readonly discordGuildId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly topic: string;
  /** The opener, plus every staff role: exactly who can see the channel. */
  readonly viewerUserIds: readonly string[];
  readonly viewerRoleIds: readonly string[];
  readonly slowModeSeconds: number | null;
}

/** Everything this file needs a gateway connection for. */
export interface TicketDiscordPort {
  /** Roles the member holds. Null when the member could not be read at all. */
  memberRoles(discordGuildId: string, discordId: string): Promise<readonly string[] | null>;
  /** Username and server nickname, for `{name}` and `{nick}`. */
  memberNames(
    discordGuildId: string,
    discordId: string,
  ): Promise<{ readonly username: string; readonly nickname: string } | null>;
  /** A member's tag for the transcript header. Null when they cannot be read. */
  userTag(discordId: string): Promise<string | null>;
  createChannel(request: NewChannelRequest): Promise<string | null>;
  /** Post, returning the message id, or null when it did not land. */
  post(channelId: string, message: OutboundMessage): Promise<string | null>;
  edit(channelId: string, messageId: string, message: OutboundMessage): Promise<boolean>;
  dm(discordId: string, message: OutboundMessage): Promise<boolean>;
  /**
   * Finish with a closed ticket's channel: archive it (rename and lock) or
   * delete it. Which one is `settings.archiveEnabled`.
   */
  disposeChannel(channelId: string, archive: boolean): Promise<void>;
}

export interface TicketGatewayDeps {
  readonly community: CommunityService;
  readonly config: GuildConfigService;
  readonly tickets: TicketConfigPort;
  readonly archive: TicketArchivePort;
  readonly discord: TicketDiscordPort;
  /**
   * The guild's display name, for the transcript header. Resolved from the
   * platform row rather than the gateway so a transcript re-sent from the admin
   * bot — which has no Mineflayer session and may not share the server — reads
   * the same as one sent on close.
   */
  readonly guildName: (guildId: string) => Promise<string>;
  readonly log: Logger;
  readonly now?: () => Date;
  /**
   * Whether a member holds a bridge capability, for the guild-wide half of the
   * staff check.
   *
   * Optional: a deployment without it falls back to the category's own
   * `staffRoleIds`, which is how ticket staff were granted before the
   * capability existed. Absent means "no guild-wide grant", never "denied" —
   * the two halves are OR'd, so losing this port narrows who counts as staff
   * rather than locking out the roles an admin already configured.
   */
  readonly capability?: (guildId: string, discordId: string, capability: BridgeCapability) => Promise<boolean>;
}

// ── results ──────────────────────────────────────────────────────────────────

export type PublishProblem = "NO_PANEL" | "NO_CHANNEL" | "NOT_RENDERABLE" | "NOT_POSTED";

export type PublishResult =
  | { readonly ok: true; readonly channelId: string; readonly messageId: string; readonly edited: boolean }
  | { readonly ok: false; readonly problem: PublishProblem; readonly detail: string };

export type OpenProblem = "NO_CATEGORY" | "NOT_ELIGIBLE" | "NO_CHANNEL" | "FAILED";

export type OpenResult =
  | { readonly ok: true; readonly ticket: TicketDTO; readonly channelId: string | null }
  | {
      readonly ok: false;
      readonly problem: OpenProblem;
      readonly detail: string;
      /** Present for NOT_ELIGIBLE, so the caller can say when to come back. */
      readonly eligibility?: Eligibility;
    };

export type ActionProblem = "NOT_A_TICKET" | "FORBIDDEN" | "ALREADY_CLOSED" | "FAILED";

export type ActionResult =
  | { readonly ok: true; readonly ticket: TicketDTO; readonly note: string }
  | { readonly ok: false; readonly problem: ActionProblem; readonly detail: string };

/** One member's press of a panel control, with everything the flow needs. */
export interface Opener {
  readonly discordId: string;
  readonly username: string;
  readonly nickname: string;
  readonly roleIds: readonly string[];
}

export interface OpenRequest {
  readonly guildId: string;
  readonly discordGuildId: string;
  readonly categoryKey: string;
  readonly opener: Opener;
  readonly topic?: string | null;
  readonly answers?: Readonly<Record<string, string>>;
}

/** How many recent tickets the `{avg*}` placeholders are averaged over. */
export const STATS_WINDOW = 100;

/** Why a member cannot open one, in words they can act on. */
export function eligibilityMessage(eligibility: Eligibility): string {
  switch (eligibility.reason) {
    case "OK":
      return "";
    case "CATEGORY_DISABLED":
      return "That kind of ticket isn't open right now.";
    case "BLOCKED":
      return "You can't open tickets in this server.";
    case "MISSING_ROLE":
      return "You don't have the role this kind of ticket needs.";
    case "MEMBER_LIMIT":
      return "You already have as many of these open as you're allowed. Close one first.";
    case "TOTAL_LIMIT":
      return "There are too many of these open at the moment — try again shortly.";
    case "COOLDOWN": {
      const seconds = eligibility.retryAfterSeconds ?? 0;
      const minutes = Math.ceil(seconds / 60);
      return `You opened one of these recently. Try again in ${minutes <= 1 ? "a minute" : `${minutes} minutes`}.`;
    }
    case "CLOSED_HOURS":
      return eligibility.opensAt === null
        ? "Tickets aren't being taken at the moment."
        : `Staff are closed right now. They open again <t:${Math.floor(Date.parse(eligibility.opensAt) / 1000)}:R>.`;
    default:
      return "You can't open one of those right now.";
  }
}

export class TicketGateway {
  private readonly d: TicketGatewayDeps;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(deps: TicketGatewayDeps) {
    this.d = deps;
    this.log = deps.log.child({ component: "tickets" });
    this.now = deps.now ?? (() => new Date());
  }

  // ── panels ────────────────────────────────────────────────────────────────

  /**
   * Post a panel, or edit the message it was posted as before.
   *
   * Editing rather than reposting is the whole point of recording `messageId`:
   * an admin who tweaks a description should not leave a trail of dead panels
   * behind, each with live buttons on it. When the recorded message has since
   * been deleted the edit fails, the record is cleared, and a fresh one is
   * posted — so "somebody tidied the channel" self-heals instead of becoming a
   * panel that can never be published again.
   */
  async publishPanel(guildId: string, panelId: string): Promise<PublishResult> {
    const panel = await this.d.tickets.panel(guildId, panelId);
    if (panel === null) return { ok: false, problem: "NO_PANEL", detail: "that panel no longer exists" };
    if (panel.channelId === null) {
      return { ok: false, problem: "NO_CHANNEL", detail: "give the panel a channel before publishing it" };
    }

    const categories = await this.d.tickets.categories(guildId);
    const rendered = renderPanel(panel, categories);
    if (!rendered.ok) return { ok: false, problem: "NOT_RENDERABLE", detail: rendered.detail };

    const message: OutboundMessage = {
      embeds: [rendered.value.embed],
      components: rendered.value.components,
    };

    if (panel.messageId !== null) {
      const edited = await this.d.discord.edit(panel.channelId, panel.messageId, message);
      if (edited) {
        return { ok: true, channelId: panel.channelId, messageId: panel.messageId, edited: true };
      }
      this.log.info("panel message is gone; posting a fresh one", { panelId, channelId: panel.channelId });
    }

    const messageId = await this.d.discord.post(panel.channelId, message);
    if (messageId === null) {
      // Un-record first: a stored id that points at nothing would make every
      // future publish try the edit path and fail the same way.
      await this.d.tickets.recordPanelMessage(guildId, panelId, panel.channelId, null).catch(() => {});
      return { ok: false, problem: "NOT_POSTED", detail: E.discord.cannotPost };
    }
    await this.d.tickets.recordPanelMessage(guildId, panelId, panel.channelId, messageId);
    return { ok: true, channelId: panel.channelId, messageId, edited: false };
  }

  /** The categories a panel offers, for the modal a press has to raise. */
  async categoryFor(guildId: string, key: string): Promise<TicketCategoryDTO | null> {
    const categories = await this.d.tickets.categories(guildId);
    // `findCategory` already narrows to enabled categories, so a button for one
    // an admin has since switched off resolves to null and says so.
    return findCategory(categories, key);
  }

  // ── opening ───────────────────────────────────────────────────────────────

  /**
   * Open a ticket: check, record, create the channel, greet.
   *
   * The order matters and is explained in the file header. The one subtlety is
   * that a channel that could not be created is *not* rolled back — the row
   * stays, so staff can see the attempt on the panel and the member is told to
   * ask for help rather than silently getting nothing.
   */
  async open(request: OpenRequest): Promise<OpenResult> {
    const { guildId, opener } = request;
    const categories = await this.d.tickets.categories(guildId);
    const category = findCategory(categories, request.categoryKey);
    if (category === null) {
      return { ok: false, problem: "NO_CATEGORY", detail: "that kind of ticket doesn't exist any more" };
    }

    const settings = await this.d.tickets.settings(guildId);
    const open = await this.d.community.listTickets(guildId);
    const openTickets = open.ok ? open.value : [];
    const mine = await this.d.community.listTickets(guildId, opener.discordId);
    const myTickets = mine.ok ? mine.value : [];

    const runtime = await this.d.config.get(guildId).catch(() => null);
    const timeZone = runtime?.ok === true && runtime.value !== null ? runtime.value.timezone : "UTC";

    const eligibility = evaluateEligibility({
      settings,
      category,
      memberRoleIds: opener.roleIds,
      memberOpenCount: myTickets.filter((t) => t.categoryId === category.id).length,
      categoryOpenCount: openTickets.filter((t) => t.categoryId === category.id).length,
      lastOpenedAt: lastOpenedIn(await this.d.archive.recent(guildId, STATS_WINDOW), opener.discordId, category.id),
      now: this.now(),
      timeZone,
    });
    if (!eligibility.allowed) {
      return {
        ok: false,
        problem: "NOT_ELIGIBLE",
        detail: eligibilityMessage(eligibility),
        eligibility,
      };
    }

    const created = await this.d.community.openTicket({
      guildId,
      openerDiscordId: opener.discordId,
      categoryId: category.id,
      topic: request.topic ?? null,
      answers: request.answers ?? {},
    });
    if (!created.ok) {
      this.log.error("ticket row could not be written", { guildId, category: category.key });
      return { ok: false, problem: "FAILED", detail: E.generic.saveFailed };
    }
    const ticket = created.value;

    const stats = statsFrom(await this.d.archive.recent(guildId, STATS_WINDOW));
    const naming = {
      number: ticket.number,
      username: opener.username,
      nickname: opener.nickname,
      ...stats,
    };

    const channelId = await this.d.discord.createChannel({
      discordGuildId: request.discordGuildId,
      name: channelName(category.channelNameTemplate, naming),
      parentId: category.parentChannelId,
      topic: `Ticket #${ticket.number} — ${category.name} — opened by ${opener.username}`,
      viewerUserIds: [opener.discordId],
      viewerRoleIds: category.staffRoleIds,
      slowModeSeconds: category.slowModeSeconds,
    });

    if (channelId === null) {
      this.log.error("ticket channel could not be created", { ticketId: ticket.id, category: category.key });
      return {
        ok: false,
        problem: "NO_CHANNEL",
        detail: "I opened your ticket but couldn't create its channel — please tell a staff member",
      };
    }

    await this.d.archive.bindChannel(ticket.id, channelId);
    const bound: TicketDTO = { ...ticket, channelId };

    await this.greet(bound, category, settings, naming, opener, request.answers ?? {});
    await this.logNotice(guildId, settings, {
      title: `Ticket #${ticket.number} opened`,
      description: `<#${channelId}> — ${category.name}`,
      color: "INFO",
      fields: [{ name: "Opened by", value: `<@${opener.discordId}>`, inline: true }],
    });

    return { ok: true, ticket: bound, channelId };
  }

  /** The opening message: the greeting, the answers, and the controls. */
  private async greet(
    ticket: TicketDTO,
    category: TicketCategoryDTO,
    settings: TicketSettingsDTO,
    naming: Parameters<typeof expand>[1],
    opener: Opener,
    answered: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (ticket.channelId === null) return;

    // From the request rather than the row: the DTO does not carry answers, and
    // re-reading them would be a second query for something we already hold.
    const answers = Object.entries(answered);
    const questionLabel = (id: string): string =>
      category.questions.find((q) => q.id === id)?.label ?? id;

    const embed: EmbedView = {
      title: `Ticket #${ticket.number} — ${category.name}`,
      description: expand(category.openingMessage, naming),
      color: settings.primaryColor,
      fields: [
        ...(ticket.topic === null ? [] : [{ name: "Topic", value: ticket.topic, inline: false }]),
        ...answers.map(([id, value]) => ({
          name: questionLabel(id),
          // Discord caps a field at 1024; the modal caps input lower, so this
          // only bites on data written before the cap existed.
          value: value.slice(0, 1024),
          inline: false,
        })),
      ],
      ...(settings.footer === null ? {} : { footer: settings.footer }),
      ...(category.image === null ? {} : { thumbnailUrl: category.image }),
    };

    // The opener is pinged so the ticket appears in their mentions, and the
    // ping roles because that is what they are for. Nothing else: the embed
    // carries admin-written prose.
    const posted = await this.d.discord.post(ticket.channelId, {
      content: [`<@${opener.discordId}>`, ...category.pingRoleIds.map((id) => `<@&${id}>`)].join(" "),
      embeds: [embed],
      components: ticketControls({
        claimable: category.claiming,
        claimed: false,
        closeButton: settings.closeButton,
        // The controls in the channel are rendered for staff. A member sees the
        // same row with "Request close" instead of "Close", which is exactly
        // what `ticketControls` produces for `isStaff: false` — but the message
        // is one message for everyone, so the staff variant is posted and the
        // handlers re-check who pressed.
        isStaff: true,
      }),
      mentionUsers: [opener.discordId],
      mentionRoles: category.pingRoleIds,
    });
    if (posted === null) {
      this.log.warn("could not post the opening message", { ticketId: ticket.id, channelId: ticket.channelId });
    }
  }

  // ── lifecycle, from a channel ─────────────────────────────────────────────

  /** Claim. Staff only, and only when the category allows claiming. */
  async claim(channelId: string, discordId: string, discordGuildId: string): Promise<ActionResult> {
    return this.act(channelId, discordId, discordGuildId, async (ticket, actor) => {
      const result = await this.d.community.claimTicket(ticket.id, actor);
      return { result, note: `Claimed by <@${discordId}>.` };
    });
  }

  async release(channelId: string, discordId: string, discordGuildId: string): Promise<ActionResult> {
    return this.act(channelId, discordId, discordGuildId, async (ticket, actor) => {
      const result = await this.d.community.releaseTicket(ticket.id, actor);
      return { result, note: `Released by <@${discordId}>.` };
    });
  }

  /** The opener asking staff to close. Not a close. */
  async requestClose(channelId: string, discordId: string, discordGuildId: string): Promise<ActionResult> {
    return this.act(channelId, discordId, discordGuildId, async (ticket, actor) => {
      const result = await this.d.community.requestTicketClose(ticket.id, actor);
      return { result, note: `<@${discordId}> asked for this ticket to be closed.` };
    });
  }

  /**
   * Close, and finish with the channel.
   *
   * The transcript is sent to the opener *before* the channel is disposed of,
   * because disposal may delete it — and a transcript that failed to send is
   * worth knowing about while the conversation still exists.
   */
  async close(
    channelId: string,
    discordId: string,
    discordGuildId: string,
    reason: string | null,
  ): Promise<ActionResult> {
    const outcome = await this.act(channelId, discordId, discordGuildId, async (ticket, actor) => {
      const result = await this.d.community.closeTicket(ticket.id, actor, reason);
      return { result, note: `Closed by <@${discordId}>.` };
    });
    // The channel the press came from is authoritative: the row's own
    // `channelId` is null for a ticket opened before it was bound.
    return this.afterClose(outcome, discordId, reason, channelId);
  }

  /**
   * Close by id rather than by channel — `/tickets close` from the admin bot,
   * where the staffer is not standing in the ticket.
   *
   * A ticket whose channel is already gone still closes: the row is the record,
   * and refusing here would leave it open forever with nowhere to press the
   * button.
   */
  async closeById(
    ticketId: string,
    discordId: string,
    discordGuildId: string,
    reason: string | null,
  ): Promise<ActionResult> {
    const found = await this.d.community.getTicket(ticketId);
    const ticket = found.ok ? found.value : null;
    if (ticket === null) {
      return { ok: false, problem: "NOT_A_TICKET", detail: "no such ticket" };
    }
    const isStaff = await this.isStaff(ticket, discordId, discordGuildId);
    const result = await this.d.community.closeTicket(ticket.id, { discordId, isStaff }, reason);
    const outcome = this.translate(result, `Closed by <@${discordId}>.`);
    return this.afterClose(outcome, discordId, reason, ticket.channelId);
  }

  /**
   * Everything a close does once the row has moved: the transcript, the log
   * notice, and the channel.
   *
   * Shared by both close paths so an admin-bot close leaves exactly the same
   * trail as one pressed in the channel — a transcript that arrives only
   * sometimes is worse than one that never does, because nobody knows which.
   */
  private async afterClose(
    outcome: ActionResult,
    discordId: string,
    reason: string | null,
    channelId?: string | null,
  ): Promise<ActionResult> {
    if (!outcome.ok) return outcome;
    const target = channelId ?? outcome.ticket.channelId;

    const settings = await this.d.tickets.settings(outcome.ticket.guildId);
    await this.deliverTranscript(outcome.ticket, settings);
    await this.logNotice(outcome.ticket.guildId, settings, {
      title: `Ticket #${outcome.ticket.number} closed`,
      description: reason === null ? "No reason given." : reason,
      color: settings.successColor,
      fields: [
        { name: "Closed by", value: `<@${discordId}>`, inline: true },
        { name: "Opened by", value: `<@${outcome.ticket.openerDiscordId}>`, inline: true },
      ],
    });
    if (target !== null) await this.d.discord.disposeChannel(target, settings.archiveEnabled);
    return outcome;
  }

  /**
   * One shape for every in-channel action: find the ticket, work out whether
   * the presser is staff, call the lifecycle, translate the refusal.
   */
  private async act(
    channelId: string,
    discordId: string,
    discordGuildId: string,
    run: (
      ticket: TicketDTO,
      actor: { readonly discordId: string; readonly isStaff: boolean },
    ) => Promise<{
      readonly result: { readonly ok: true; readonly value: TicketDTO } | { readonly ok: false; readonly error: { readonly kind: string } };
      readonly note: string;
    }>,
  ): Promise<ActionResult> {
    const found = await this.d.community.getTicketByChannel(channelId);
    const ticket = found.ok ? found.value : null;
    if (ticket === null) {
      return { ok: false, problem: "NOT_A_TICKET", detail: "this channel isn't a ticket" };
    }

    const isStaff = await this.isStaff(ticket, discordId, discordGuildId);
    const { result, note } = await run(ticket, { discordId, isStaff });
    return this.translate(result, note);
  }

  /** A lifecycle refusal, in words the presser can read. */
  private translate(
    result: { readonly ok: true; readonly value: TicketDTO } | { readonly ok: false; readonly error: { readonly kind: string } },
    note: string,
  ): ActionResult {
    if (!result.ok) {
      const kind = result.error.kind;
      if (kind === "ALREADY_CLOSED") {
        return { ok: false, problem: "ALREADY_CLOSED", detail: "that ticket is already closed" };
      }
      if (kind === "FORBIDDEN") {
        return { ok: false, problem: "FORBIDDEN", detail: "that isn't yours to do" };
      }
      return { ok: false, problem: "FAILED", detail: E.generic.unknown };
    }
    return { ok: true, ticket: result.value, note };
  }

  /**
   * Whether somebody is staff *for this ticket*.
   *
   * Per-category rather than server-wide: the people who answer ban appeals are
   * not always the people who answer staff applications, and the category's own
   * `staffRoleIds` is the list an admin actually configured. A category that has
   * since been deleted leaves nobody as staff except the opener's own rights,
   * which fails closed.
   */
  async isStaff(ticket: TicketDTO, discordId: string, discordGuildId: string): Promise<boolean> {
    // The guild-wide grant first, because it is one read and does not care
    // which category the ticket is in. A failure here is not a denial: it falls
    // through to the roles, which is what the check was before the capability.
    const granted = await this.d.capability?.(ticket.guildId, discordId, "TICKET_MANAGE").catch(() => false);
    if (granted === true) return true;
    const categories = await this.d.tickets.categories(ticket.guildId);
    const category = categories.find((c) => c.id === ticket.categoryId) ?? null;
    if (category === null || category.staffRoleIds.length === 0) return false;
    const roles = await this.d.discord.memberRoles(discordGuildId, discordId);
    if (roles === null) return false;
    return category.staffRoleIds.some((id) => roles.includes(id));
  }

  // ── transcript ────────────────────────────────────────────────────────────

  /** DM the opener their transcript. Used on close and by "re-send". */
  async deliverTranscript(ticket: TicketDTO, settings?: TicketSettingsDTO): Promise<boolean> {
    const resolved = settings ?? (await this.d.tickets.settings(ticket.guildId));
    const messages = await this.d.archive.messages(ticket.id);
    const header = await this.header(ticket);
    const sent = await this.d.discord.dm(ticket.openerDiscordId, {
      content: `Here's the transcript for ticket #${ticket.number}.`,
      file: { name: transcriptFilename(ticket, "html"), content: toHtml(header, messages) },
    });
    if (!sent) {
      // Closed DMs are ordinary, not an error. The transcript is still on the
      // panel, which is what the log line points staff at.
      this.log.info("could not DM a transcript; it is still on the panel", {
        ticketId: ticket.id,
        opener: ticket.openerDiscordId,
      });
      await this.logNotice(ticket.guildId, resolved, {
        title: `Transcript for #${ticket.number} could not be delivered`,
        description: `<@${ticket.openerDiscordId}> has DMs closed. It is on the panel.`,
        color: resolved.errorColor,
      });
    }
    return sent;
  }

  /**
   * Read a ticket, and refuse it if it belongs to a different server.
   *
   * A ticket id is opaque but it is not a secret, and both callers of the
   * methods below arrive over the internal API, where the guild is a path
   * segment the caller chose. Every other route on that API is scoped to that
   * segment; a transcript — the single most sensitive thing tickets hold — must
   * not be the exception. Both current callers happen to check first. This is
   * the check that does not depend on them continuing to.
   */
  private async ticketIn(guildId: string, ticketId: string): Promise<TicketDTO | null> {
    const found = await this.d.community.getTicket(ticketId);
    const ticket = found.ok ? found.value : null;
    return ticket !== null && ticket.guildId === guildId ? ticket : null;
  }

  /**
   * Re-send by id, for the panel's "Re-send transcript" and the admin bot.
   *
   * Null means there is no such ticket, which is a different answer from false
   * — "the member has DMs closed" is worth showing, and "you typed the wrong
   * id" is worth not disguising as it.
   */
  async deliverTranscriptById(guildId: string, ticketId: string): Promise<boolean | null> {
    const ticket = await this.ticketIn(guildId, ticketId);
    if (ticket === null) return null;
    return this.deliverTranscript(ticket);
  }

  /** The markdown transcript, for `/tickets transcript`. */
  async transcript(
    guildId: string,
    ticketId: string,
  ): Promise<{ readonly name: string; readonly content: string } | null> {
    const ticket = await this.ticketIn(guildId, ticketId);
    if (ticket === null) return null;
    const messages = await this.d.archive.messages(ticket.id);
    return {
      name: transcriptFilename(ticket, "md"),
      content: toMarkdown(await this.header(ticket), messages),
    };
  }

  /**
   * The transcript header.
   *
   * The opener's tag is resolved rather than left as a raw snowflake: a
   * transcript is read outside Discord, where `<@1234…>` renders as nothing at
   * all. An unreadable account falls back to the id, which is still an answer.
   */
  private async header(ticket: TicketDTO): Promise<TranscriptHeader> {
    const [guildName, tag] = await Promise.all([
      this.d.guildName(ticket.guildId).catch(() => "this server"),
      this.d.discord.userTag(ticket.openerDiscordId).catch(() => null),
    ]);
    return {
      ticket,
      guildName,
      categoryName: ticket.categoryName,
      openerTag: tag ?? ticket.openerDiscordId,
    };
  }

  // ── capture ───────────────────────────────────────────────────────────────

  /**
   * Record a message if its channel is a ticket.
   *
   * Called for every message in the server, so the cheap check comes first: one
   * indexed lookup by channel id, and nothing else happens for the 99.9% of
   * messages that are not in a ticket. `fromStaff` is what stamps
   * `firstStaffReplyAt`, so a bot's own greeting must never count — otherwise
   * every ticket would show a response time of zero.
   */
  async capture(message: CapturedMessage): Promise<boolean> {
    const found = await this.d.community.getTicketByChannel(message.channelId);
    const ticket = found.ok ? found.value : null;
    if (ticket === null) return false;

    const fromStaff = !message.fromBot && message.authorDiscordId !== ticket.openerDiscordId;
    await this.d.archive.record(
      {
        ticketId: ticket.id,
        discordMessageId: message.discordMessageId,
        authorDiscordId: message.authorDiscordId,
        authorTag: message.authorTag,
        content: message.content,
        attachments: message.attachments,
        createdAt: message.createdAt,
      },
      fromStaff,
    );
    return true;
  }

  async captureEdit(discordMessageId: string, content: string): Promise<void> {
    await this.d.archive.markEdited(discordMessageId, content, this.now());
  }

  async captureDelete(discordMessageId: string): Promise<void> {
    await this.d.archive.markDeleted(discordMessageId, this.now());
  }

  // ── sweep ─────────────────────────────────────────────────────────────────

  /**
   * What the sweep should do with one ticket, and doing it.
   *
   * The decision is `sweep()` in `@sbr/tickets`; this only supplies the inputs
   * and carries out the answer. `staleWarned` is the caller's to remember —
   * the worker keeps it in Redis with a TTL, because a warning that repeats
   * every five minutes is worse than one that occasionally repeats after a
   * restart.
   */
  async sweepOne(ticket: TicketDTO, staleWarned: boolean): Promise<SweepAction> {
    const settings = await this.d.tickets.settings(ticket.guildId);
    const since =
      ticket.closeRequestedAt === null
        ? 0
        : await this.d.archive.countSince(ticket.id, new Date(ticket.closeRequestedAt));

    const action = sweep({
      ticket,
      settings,
      messagesSinceCloseRequest: since,
      staleWarned,
      now: this.now(),
    });

    if (action === "NONE" || ticket.channelId === null) return action;

    if (action === "WARN_STALE") {
      const minutes = settings.autoCloseAfterMinutes;
      await this.d.discord.post(ticket.channelId, {
        embeds: [
          {
            title: "Still need this?",
            description:
              since >= RESUME_MESSAGE_COUNT
                ? "This ticket has been quiet for a while. Say something to keep it open."
                : `This ticket has been quiet for a while and will close on its own in about ${Math.round(minutes / 60)}h if nothing else is said.`,
            color: settings.primaryColor,
          },
        ],
        mentionUsers: [ticket.openerDiscordId],
        content: `<@${ticket.openerDiscordId}>`,
      });
      return action;
    }

    // AUTO_CLOSE. The actor is the platform, not a person: `isStaff` is true
    // because nobody pressed anything and the close must not be refused for
    // want of a permission.
    const closed = await this.d.community.closeTicket(
      ticket.id,
      { discordId: "SYSTEM", isStaff: true },
      "Closed automatically after a period of inactivity.",
    );
    if (!closed.ok) return "NONE";
    await this.deliverTranscript(closed.value, settings);
    await this.logNotice(ticket.guildId, settings, {
      title: `Ticket #${ticket.number} closed automatically`,
      description: "No reply within the inactivity window.",
      color: settings.primaryColor,
    });
    await this.d.discord.disposeChannel(ticket.channelId, settings.archiveEnabled);
    return action;
  }

  /**
   * Sweep one ticket by id, for the worker.
   *
   * The row is re-read here rather than accepted from the caller: the worker
   * listed these ids a moment ago and a ticket can close in between, and a
   * sweep acting on a caller's copy of a ticket is a sweep acting on whatever
   * the caller says is true. Null means there is no such ticket in that guild.
   */
  async sweepById(guildId: string, ticketId: string, staleWarned: boolean): Promise<SweepAction | null> {
    const found = await this.d.community.getTicket(ticketId);
    const ticket = found.ok ? found.value : null;
    if (ticket === null || ticket.guildId !== guildId) return null;
    return this.sweepOne(ticket, staleWarned);
  }

  // ── log channel ───────────────────────────────────────────────────────────

  /**
   * Post to the guild's ticket log, if it has one.
   *
   * Never throws and never blocks the thing it is reporting: a guild with no
   * log channel, or one the bot cannot post in, still gets working tickets.
   */
  private async logNotice(guildId: string, settings: TicketSettingsDTO, embed: EmbedView): Promise<void> {
    if (settings.logChannelId === null) return;
    await this.d.discord.post(settings.logChannelId, { embeds: [embed] }).catch((error: unknown) => {
      this.log.warn("could not post to the ticket log", { guildId, error: String(error) });
      return null;
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** The three `{avg*}` inputs, over a window of recent tickets. */
export function statsFrom(tickets: readonly TicketDTO[]): {
  readonly avgRating: number | null;
  readonly avgResponseTimeMs: number | null;
  readonly avgResolutionTimeMs: number | null;
} {
  return {
    avgRating: averageRating(tickets),
    avgResponseTimeMs: averageResponseTimeMs(tickets),
    avgResolutionTimeMs: averageResolutionTimeMs(tickets),
  };
}

/**
 * When this member last opened one of these, for the cooldown.
 *
 * Read from the same recent-ticket window as the averages rather than with its
 * own query: one read per open, not two, and a member whose last ticket in this
 * category has fallen out of a hundred-ticket window is well past any cooldown
 * a guild would sensibly set.
 */
export function lastOpenedIn(
  tickets: readonly TicketDTO[],
  discordId: string,
  categoryId: string,
): Date | null {
  let newest: number | null = null;
  for (const ticket of tickets) {
    if (ticket.openerDiscordId !== discordId || ticket.categoryId !== categoryId) continue;
    const at = Date.parse(ticket.createdAt);
    if (Number.isNaN(at)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest === null ? null : new Date(newest);
}

/** One message as it arrived, on its way into the transcript. */
export interface CapturedMessage {
  readonly channelId: string;
  readonly discordMessageId: string;
  readonly authorDiscordId: string;
  readonly authorTag: string;
  readonly content: string;
  readonly attachments: readonly TicketAttachmentDTO[];
  readonly createdAt: Date;
  /** Bot messages are captured but never count as a staff reply. */
  readonly fromBot: boolean;
}
