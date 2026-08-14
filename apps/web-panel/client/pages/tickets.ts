/**
 * Tickets — the queue, then the five things that shape it.
 *
 * The queue leads because it is the part with a clock on it: a ticket nobody
 * answered is a member waiting, while a category nobody edited is fine. What a
 * member *wrote* in one stays in the ticket channel where the people in it are;
 * what this page offers is working the queue, and the menu behind it.
 *
 * Sections, in the order a guild actually sets them up: Queue · Categories ·
 * Panels · Tags · Settings. Categories come before panels because a panel is a
 * list of categories — building the panel first means picking from nothing.
 *
 * Every control saves a whole object rather than a patch, because every ticket
 * mutation upserts a whole row. A partial write would need the server to merge
 * against what it has, and two writers merging blind is how a half-saved
 * category gets a name from one operator and a limit from another.
 */
import type { TicketsVM } from "@sbr/panel-core";
import type {
  TicketCategoryDTO,
  TicketDTO,
  TicketPanelDTO,
  TicketSettingsDTO,
  TicketTagDTO,
} from "@sbr/shared-types";
import { loadPage, postAction, type WriteResult } from "../api.js";
import { badge, card, deniedState, emptyState, errorState, pageTitle, spinner } from "../components.js";
import { scope } from "../copy.js";
import {
  actionButton,
  channelPicker,
  fieldGroup,
  memberPicker,
  multiPickerField,
  reasonBox,
  selectField,
  statusSlot,
  textField,
  toggleField,
} from "../forms.js";
import { h, replace } from "../dom.js";
import { relativeTime } from "../format.js";

/** Mirrors the mutation layer's bounds; see forms.ts on why both exist. */
const KEY_SHAPE = /^[a-z0-9]+(?:[.:-][a-z0-9]+)*$/;
const MAX_ROLES = 25;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 100;
const TEMPLATE_MAX = 100;
const OPENING_MAX = 2_000;
const PANEL_TITLE_MAX = 120;
const TAG_NAME_MAX = 40;
const TAG_CONTENT_MAX = 2_000;
const FOOTER_MAX = 2_048;
/** Discord's own ceiling on a channel's slow mode. */
const MAX_SLOWMODE = 21_600;

const t = scope("tickets");

const statusLabel = (value: string): string => {
  const table = t("status") as Readonly<Record<string, string>>;
  return table[value] ?? value.toLowerCase();
};

/** Absent is a dash, never a zero and never a stale guess. */
const DASH = "—";

export async function renderTickets(host: HTMLElement, guildId: string): Promise<void> {
  replace(host, spinner("tickets"));

  const result = await loadPage<TicketsVM>(`/api/guilds/${encodeURIComponent(guildId)}/tickets`);
  if (result.kind === "denied") return replace(host, deniedState(result.reason));
  if (result.kind === "error") {
    return replace(host, errorState(result.message, () => void renderTickets(host, guildId)));
  }

  const { installed, settings, categories, panels, tags, open, canConfigure } = result.data;
  const reload = (): void => void renderTickets(host, guildId);
  const queue = card(t("cardQueue"), queueBody(guildId, open, reload));

  // The queue is the part everyone who reaches this page can act on. The rest
  // needs Admin, and a deployment without the ticket service has no menu at all
  // — either way the queue still renders, because those tickets are open
  // regardless of who is reading and what is configured.
  if (!canConfigure) {
    return replace(
      host,
      h("div", {}, pageTitle(t("title"), t("subtitle").replace("{count}", String(open.length))), queue),
    );
  }
  if (!installed || settings === null) {
    return replace(
      host,
      h(
        "div",
        {},
        pageTitle(t("title"), t("subtitle").replace("{count}", String(open.length))),
        queue,
        emptyState("ticketsDisabled"),
      ),
    );
  }

  const offered = categories.filter((c) => c.enabled).length;

  replace(
    host,
    h(
      "div",
      {},
      pageTitle(
        t("title"),
        t("subtitleConfigured")
          .replace("{count}", String(open.length))
          .replace("{offered}", String(offered))
          .replace("{total}", String(categories.length)),
      ),
      queue,
      h("p", { class: "page-note" }, t("intro")),
      card(t("cardCategories"), categoriesBody(guildId, categories, reload)),
      card(t("cardPanels"), panelsBody(guildId, panels, categories, reload)),
      card(t("cardTags"), tagsBody(guildId, tags, reload)),
      card(t("cardSettings"), settingsBody(guildId, settings)),
    ),
  );
}

// ─────────────────────────────── Queue ───────────────────────────────

function queueBody(guildId: string, tickets: readonly TicketDTO[], reload: () => void): HTMLElement {
  if (tickets.length === 0) return emptyState("ticketsQueue");
  return h("div", { class: "queue" }, ...tickets.map((ticket) => queueRow(guildId, ticket, reload)));
}

/**
 * One open ticket, with its own reason box and status line so a refused close
 * says which ticket it was about.
 */
function queueRow(guildId: string, ticket: TicketDTO, reload: () => void): HTMLElement {
  const status = statusSlot();
  const reason = reasonBox(t("closeReason"), 2);
  const category = ticket.categoryName ?? DASH;
  const topic = ticket.topic ?? ticket.subject;

  let transferTo: string | null = null;

  return h(
    "article",
    { class: "queue-item" },
    h(
      "header",
      { class: "queue-head" },
      h("strong", {}, `#${ticket.number} `, topic ?? t("untitled").replace("{category}", category)),
      badge(category, "neutral"),
      badge(statusLabel(ticket.status), ticket.status === "OPEN" ? "warn" : "neutral"),
      ticket.transcriptReady ? badge(t("transcriptReady"), "ok") : null,
      h("span", { class: "muted" }, t("openedAt").replace("{when}", relativeTime(ticket.createdAt))),
    ),
    h(
      "p",
      { class: "muted" },
      t("by"),
      h("code", {}, ticket.openerDiscordId),
      ticket.claimedByDiscordId === null
        ? ticket.assigneeDiscordId
          ? t("assigned")
          : t("unassigned")
        : t("claimedBy"),
      ticket.claimedByDiscordId ?? ticket.assigneeDiscordId
        ? h("code", {}, ticket.claimedByDiscordId ?? ticket.assigneeDiscordId ?? "")
        : null,
    ),
    // "No staff reply yet" rather than a zero: a ticket nobody has answered has
    // no response time, and printing 0 would read as an instant answer.
    h(
      "p",
      { class: "muted" },
      ticket.firstStaffReplyAt === null
        ? t("noReply")
        : t("firstReply").replace("{when}", relativeTime(ticket.firstStaffReplyAt)),
    ),
    h("div", { class: "field-row" }, reason),
    h(
      "div",
      { class: "field-row" },
      actionButton({
        label: t("close"),
        confirm: t("closeConfirm"),
        status,
        run: () => postAction(guildId, "ticket.close", { ticketId: ticket.id, reason: reason.value.trim() }),
        onDone: reload,
      }),
      ticket.claimedByDiscordId === null
        ? actionButton({
            label: t("claim"),
            status,
            run: () => postAction(guildId, "ticket.claim", { ticketId: ticket.id }),
            onDone: reload,
          })
        : null,
      ticket.transcriptReady
        ? actionButton({
            label: t("resendTranscript"),
            status,
            run: () => postAction(guildId, "ticket.transcript.resend", { ticketId: ticket.id }),
          })
        : null,
    ),
    memberPicker({
      label: t("transferLabel"),
      guildId,
      value: "",
      placeholder: t("transferPlaceholder"),
      save: (raw) => {
        transferTo = raw;
        return postAction(guildId, "ticket.transfer", { ticketId: ticket.id, toDiscordId: transferTo });
      },
    }),
    status.el,
  );
}

// ───────────────────────────── Categories ─────────────────────────────

function categoriesBody(
  guildId: string,
  categories: readonly TicketCategoryDTO[],
  reload: () => void,
): HTMLElement {
  return h(
    "div",
    {},
    h("p", { class: "field-hint" }, t("categoriesNote")),
    categories.length === 0
      ? h("p", { class: "muted" }, t("noCategories"))
      : h("div", {}, ...categories.map((c) => categoryEditor(guildId, c, reload))),
    createCategoryForm(guildId, reload),
  );
}

/** One category's rules. Every control writes the whole row; see the file note. */
function categoryEditor(guildId: string, category: TicketCategoryDTO, reload: () => void): HTMLElement {
  const current: { -readonly [K in keyof TicketCategoryDTO]: TicketCategoryDTO[K] } = { ...category };

  const write = (patch: Partial<TicketCategoryDTO>): Promise<WriteResult> => {
    Object.assign(current, patch);
    return postAction(guildId, "ticket.category.upsert", {
      key: current.key,
      name: current.name,
      description: current.description,
      emoji: current.emoji,
      position: current.position,
      enabled: current.enabled,
      channelNameTemplate: current.channelNameTemplate,
      parentChannelId: current.parentChannelId,
      staffRoleIds: [...current.staffRoleIds],
      requiredRoleIds: [...current.requiredRoleIds],
      pingRoleIds: [...current.pingRoleIds],
      openingMessage: current.openingMessage,
      image: current.image,
      claiming: current.claiming,
      cooldownSeconds: current.cooldownSeconds,
      memberLimit: current.memberLimit,
      totalLimit: current.totalLimit,
      slowModeSeconds: current.slowModeSeconds,
      requireTopic: current.requireTopic,
      questions: current.questions.map((q) => ({ ...q })),
    });
  };

  const status = statusSlot();

  return h(
    "details",
    { class: "collapse" },
    h(
      "summary",
      {},
      h("strong", {}, category.name),
      badge(category.key, "neutral"),
      badge(category.enabled ? t("offeredLabel") : DASH, category.enabled ? "ok" : "warn"),
    ),
    fieldGroup(
      toggleField({
        label: t("offeredLabel"),
        hint: t("offeredHint"),
        checked: category.enabled,
        save: (enabled) => write({ enabled }),
      }),
      textField({
        label: t("nameLabel"),
        hint: t("nameHint"),
        value: category.name,
        validate: (raw) => (raw.trim().length === 0 || raw.length > NAME_MAX ? t("errName") : null),
        save: (raw) => write({ name: raw.trim() }),
      }),
      textField({
        label: t("descriptionLabel"),
        hint: t("descriptionHint"),
        value: category.description,
        validate: (raw) => (raw.length > DESCRIPTION_MAX ? t("errDescription") : null),
        save: (raw) => write({ description: raw.trim() }),
      }),
      textField({
        label: t("emojiLabel"),
        hint: t("emojiHint"),
        value: category.emoji ?? "",
        save: (raw) => write({ emoji: raw.trim() === "" ? null : raw.trim() }),
      }),
      textField({
        label: t("openingLabel"),
        hint: t("openingHint"),
        value: category.openingMessage,
        validate: (raw) => (raw.length > OPENING_MAX ? t("errOpening") : null),
        save: (raw) => write({ openingMessage: raw }),
      }),
      textField({
        label: t("templateLabel"),
        hint: t("templateHint"),
        value: category.channelNameTemplate,
        validate: (raw) =>
          raw.trim().length === 0 || raw.length > TEMPLATE_MAX ? t("errTemplate") : null,
        save: (raw) => write({ channelNameTemplate: raw.trim() }),
      }),
      channelPicker({
        label: t("parentLabel"),
        hint: t("parentHint"),
        guildId,
        value: category.parentChannelId ?? "",
        placeholder: t("parentPlaceholder"),
        save: (raw) => write({ parentChannelId: raw }),
        clear: () => write({ parentChannelId: null }),
      }),
      roleList(guildId, t("staffLabel"), t("staffHint"), category.staffRoleIds, (staffRoleIds) =>
        write({ staffRoleIds }),
      ),
      roleList(guildId, t("requiredLabel"), t("requiredHint"), category.requiredRoleIds, (requiredRoleIds) =>
        write({ requiredRoleIds }),
      ),
      roleList(guildId, t("pingLabel"), t("pingHint"), category.pingRoleIds, (pingRoleIds) =>
        write({ pingRoleIds }),
      ),
      toggleField({
        label: t("claimingLabel"),
        hint: t("claimingHint"),
        checked: category.claiming,
        save: (claiming) => write({ claiming }),
      }),
      toggleField({
        label: t("requireTopicLabel"),
        hint: t("requireTopicHint"),
        checked: category.requireTopic,
        save: (requireTopic) => write({ requireTopic }),
      }),
      countField(t("positionLabel"), t("positionHint"), category.position, 0, 999, (position) =>
        write({ position }),
      ),
      countField(t("memberLimitLabel"), t("memberLimitHint"), category.memberLimit, 1, 25, (memberLimit) =>
        write({ memberLimit }),
      ),
      countField(t("totalLimitLabel"), t("totalLimitHint"), category.totalLimit, 1, 50, (totalLimit) =>
        write({ totalLimit }),
      ),
      // Blank is null, not zero: "no cooldown" and "a zero-second cooldown" are
      // the same policy here, but a stale clock and no clock are not, and the
      // settings card below relies on the same distinction.
      nullableCountField(
        t("cooldownLabel"),
        t("cooldownHint"),
        category.cooldownSeconds,
        0,
        7 * 24 * 60 * 60,
        (cooldownSeconds) => write({ cooldownSeconds }),
      ),
      nullableCountField(
        t("slowModeLabel"),
        t("slowModeHint"),
        category.slowModeSeconds,
        0,
        MAX_SLOWMODE,
        (slowModeSeconds) => write({ slowModeSeconds }),
      ),
    ),
    h(
      "div",
      { class: "field-row" },
      actionButton({
        label: t("remove"),
        tone: "danger",
        confirm: t("removeConfirm"),
        status,
        run: () => postAction(guildId, "ticket.category.remove", { key: category.key }),
        onDone: reload,
      }),
    ),
    status.el,
  );
}

/**
 * The create form.
 *
 * The key is entered rather than derived from the name, because it is what a
 * member types into `/ticket type:` and what a panel stores: a name is display
 * text somebody will want to reword, and a key that moved with it would break
 * every panel pointing at it.
 */
function createCategoryForm(guildId: string, reload: () => void): HTMLElement {
  const status = statusSlot();
  const key = plainField(t("createKeyPlaceholder"), t("createKeyLabel"));
  const name = plainField(t("createNamePlaceholder"), t("createNameLabel"));

  return h(
    "div",
    { class: "field" },
    h("p", { class: "field-hint" }, t("createNote")),
    h("div", { class: "field-row" }, key, name),
    h(
      "div",
      { class: "field-row" },
      actionButton({
        label: t("create"),
        tone: "primary",
        status,
        run: async () => {
          const keyText = key.value.trim().toLowerCase();
          if (!KEY_SHAPE.test(keyText)) return { kind: "error", message: t("errKey") };
          if (name.value.trim().length === 0) return { kind: "error", message: t("errNoName") };
          // Created with the platform's own defaults; everything else is edited
          // in the row that appears, so the create form stays two fields wide.
          return postAction(guildId, "ticket.category.upsert", {
            key: keyText,
            name: name.value.trim(),
            description: "",
            emoji: null,
            position: 0,
            enabled: true,
            channelNameTemplate: "ticket-{num}",
            parentChannelId: null,
            staffRoleIds: [],
            requiredRoleIds: [],
            pingRoleIds: [],
            openingMessage: "",
            image: null,
            claiming: true,
            cooldownSeconds: null,
            memberLimit: 1,
            totalLimit: 50,
            slowModeSeconds: null,
            requireTopic: false,
            questions: [],
          });
        },
        // A reload rather than clearing the inputs: the new category has to
        // appear above, and an existing key is an edit, not a second row.
        onDone: reload,
      }),
    ),
    status.el,
  );
}

// ─────────────────────────────── Panels ───────────────────────────────

function panelsBody(
  guildId: string,
  panels: readonly TicketPanelDTO[],
  categories: readonly TicketCategoryDTO[],
  reload: () => void,
): HTMLElement {
  return h(
    "div",
    {},
    h("p", { class: "field-hint" }, t("panelsNote")),
    panels.length === 0
      ? h("p", { class: "muted" }, t("noPanels"))
      : h("div", {}, ...panels.map((p) => panelEditor(guildId, p, categories, reload))),
    createPanelForm(guildId, reload),
  );
}

function panelEditor(
  guildId: string,
  panel: TicketPanelDTO,
  categories: readonly TicketCategoryDTO[],
  reload: () => void,
): HTMLElement {
  const current: { -readonly [K in keyof TicketPanelDTO]: TicketPanelDTO[K] } = { ...panel };

  const write = (patch: Partial<TicketPanelDTO>): Promise<WriteResult> => {
    Object.assign(current, patch);
    return postAction(guildId, "ticket.panel.upsert", {
      id: current.id,
      name: current.name,
      channelId: current.channelId,
      title: current.title,
      description: current.description,
      image: current.image,
      thumbnail: current.thumbnail,
      style: current.style,
      categoryKeys: [...current.categoryKeys],
    });
  };

  const status = statusSlot();

  return h(
    "details",
    { class: "collapse" },
    h(
      "summary",
      {},
      h("strong", {}, panel.name),
      badge(panel.style === "BUTTONS" ? t("styleButtons") : t("styleSelect"), "neutral"),
      panel.messageId === null ? badge(t("panelUnposted"), "warn") : badge(DASH, "ok"),
    ),
    h(
      "p",
      { class: "field-hint" },
      panel.messageId === null
        ? t("panelUnposted")
        : t("panelPosted").replace("{channel}", panel.channelId ?? t("panelSomeChannel")),
    ),
    fieldGroup(
      textField({
        label: t("panelNameLabel"),
        hint: t("panelNameHint"),
        value: panel.name,
        validate: (raw) => (raw.trim().length === 0 || raw.length > NAME_MAX ? t("errPanelName") : null),
        save: (raw) => write({ name: raw.trim() }),
      }),
      channelPicker({
        label: t("panelChannelLabel"),
        hint: t("panelChannelHint"),
        guildId,
        value: panel.channelId ?? "",
        placeholder: t("panelChannelPlaceholder"),
        save: (raw) => write({ channelId: raw }),
        clear: () => write({ channelId: null }),
      }),
      textField({
        label: t("panelTitleLabel"),
        hint: t("panelTitleHint"),
        value: panel.title,
        validate: (raw) =>
          raw.trim().length === 0 || raw.length > PANEL_TITLE_MAX ? t("errPanelTitle") : null,
        save: (raw) => write({ title: raw.trim() }),
      }),
      textField({
        label: t("panelDescriptionLabel"),
        hint: t("panelDescriptionHint"),
        value: panel.description ?? "",
        validate: (raw) => (raw.length > OPENING_MAX ? t("errPanelDescription") : null),
        save: (raw) => write({ description: raw.trim() === "" ? null : raw.trim() }),
      }),
      selectField({
        label: t("panelStyleLabel"),
        hint: t("panelStyleHint"),
        value: panel.style,
        options: [
          ["BUTTONS", t("styleButtons")],
          ["SELECT", t("styleSelect")],
        ],
        save: (next) => write({ style: next as TicketPanelDTO["style"] }),
      }),
      // Keys, not ids: a panel points at categories by key so renaming one
      // never orphans the panel. The mutation refuses a key that is not a
      // category, and refuses more than the style can render.
      multiPickerField({
        label: t("panelCategoriesLabel"),
        hint: t("panelCategoriesHint"),
        guildId,
        kind: "role",
        values: panel.categoryKeys,
        save: async (keys) => {
          const known = new Set(categories.map((c) => c.key));
          const unknown = keys.filter((k) => !known.has(k));
          if (unknown.length > 0) {
            return { kind: "error", message: `${unknown.join(", ")}: no such category` };
          }
          return write({ categoryKeys: [...keys] });
        },
      }),
    ),
    h(
      "div",
      { class: "field-row" },
      actionButton({
        label: t("publish"),
        tone: "primary",
        confirm: t("publishConfirm"),
        status,
        run: () => postAction(guildId, "ticket.panel.publish", { id: panel.id }),
        onDone: reload,
      }),
      actionButton({
        label: t("remove"),
        tone: "danger",
        confirm: t("removeConfirm"),
        status,
        run: () => postAction(guildId, "ticket.panel.remove", { id: panel.id }),
        onDone: reload,
      }),
    ),
    status.el,
  );
}

function createPanelForm(guildId: string, reload: () => void): HTMLElement {
  const status = statusSlot();
  const name = plainField(t("createPanelNamePlaceholder"), t("panelNameLabel"));
  const title = plainField(t("createPanelTitlePlaceholder"), t("panelTitleLabel"));

  return h(
    "div",
    { class: "field" },
    h("div", { class: "field-row" }, name, title),
    h(
      "div",
      { class: "field-row" },
      actionButton({
        label: t("createPanel"),
        tone: "primary",
        status,
        run: async () => {
          if (name.value.trim().length === 0) return { kind: "error", message: t("errPanelName") };
          if (title.value.trim().length === 0) return { kind: "error", message: t("errPanelTitle") };
          return postAction(guildId, "ticket.panel.upsert", {
            id: null,
            name: name.value.trim(),
            channelId: null,
            title: title.value.trim(),
            description: null,
            image: null,
            thumbnail: null,
            style: "BUTTONS",
            categoryKeys: [],
          });
        },
        onDone: reload,
      }),
    ),
    status.el,
  );
}

// ──────────────────────────────── Tags ────────────────────────────────

function tagsBody(guildId: string, tags: readonly TicketTagDTO[], reload: () => void): HTMLElement {
  return h(
    "div",
    {},
    h("p", { class: "field-hint" }, t("tagsNote")),
    tags.length === 0
      ? h("p", { class: "muted" }, t("noTags"))
      : h("div", {}, ...tags.map((tag) => tagEditor(guildId, tag, reload))),
    createTagForm(guildId, reload),
  );
}

function tagEditor(guildId: string, tag: TicketTagDTO, reload: () => void): HTMLElement {
  const current = { ...tag };

  const write = (patch: Partial<TicketTagDTO>): Promise<WriteResult> => {
    Object.assign(current, patch);
    return postAction(guildId, "ticket.tag.upsert", {
      name: current.name,
      content: current.content,
      autoPattern: current.autoPattern,
      enabled: current.enabled,
    });
  };

  const status = statusSlot();

  return h(
    "details",
    { class: "collapse" },
    h(
      "summary",
      {},
      h("strong", {}, tag.name),
      tag.autoPattern === null ? null : badge(tag.autoPattern, "neutral"),
      badge(tag.enabled ? t("tagEnabledLabel") : DASH, tag.enabled ? "ok" : "warn"),
    ),
    fieldGroup(
      toggleField({
        label: t("tagEnabledLabel"),
        hint: t("tagEnabledHint"),
        checked: tag.enabled,
        save: (enabled) => write({ enabled }),
      }),
      textField({
        label: t("tagContentLabel"),
        hint: t("tagContentHint"),
        value: tag.content,
        validate: (raw) =>
          raw.trim().length === 0 || raw.length > TAG_CONTENT_MAX ? t("errTagContent") : null,
        save: (raw) => write({ content: raw.trim() }),
      }),
      textField({
        label: t("tagPatternLabel"),
        hint: t("tagPatternHint"),
        value: tag.autoPattern ?? "",
        // Compiled here as well as server-side: a bad pattern should be refused
        // while the operator is still looking at the box, not after a round trip.
        validate: (raw) => {
          if (raw.trim() === "") return null;
          try {
            new RegExp(raw, "mi");
            return null;
          } catch {
            return t("errTagPattern");
          }
        },
        save: (raw) => write({ autoPattern: raw.trim() === "" ? null : raw.trim() }),
      }),
    ),
    h(
      "div",
      { class: "field-row" },
      actionButton({
        label: t("remove"),
        tone: "danger",
        confirm: t("removeConfirm"),
        status,
        run: () => postAction(guildId, "ticket.tag.remove", { name: tag.name }),
        onDone: reload,
      }),
    ),
    status.el,
  );
}

function createTagForm(guildId: string, reload: () => void): HTMLElement {
  const status = statusSlot();
  const name = plainField(t("createTagNamePlaceholder"), t("tagNameLabel"));
  const content = plainField(t("createTagContentPlaceholder"), t("tagContentLabel"));

  return h(
    "div",
    { class: "field" },
    h("div", { class: "field-row" }, name, content),
    h(
      "div",
      { class: "field-row" },
      actionButton({
        label: t("createTag"),
        tone: "primary",
        status,
        run: async () => {
          const nameText = name.value.trim();
          if (nameText.length === 0 || nameText.length > TAG_NAME_MAX) {
            return { kind: "error", message: t("errTagName") };
          }
          if (content.value.trim().length === 0) return { kind: "error", message: t("errTagContent") };
          return postAction(guildId, "ticket.tag.upsert", {
            name: nameText,
            content: content.value.trim(),
            autoPattern: null,
            enabled: true,
          });
        },
        onDone: reload,
      }),
    ),
    status.el,
  );
}

// ────────────────────────────── Settings ──────────────────────────────

function settingsBody(guildId: string, settings: TicketSettingsDTO): HTMLElement {
  const current: { -readonly [K in keyof TicketSettingsDTO]: TicketSettingsDTO[K] } = { ...settings };

  const write = (patch: Partial<TicketSettingsDTO>): Promise<WriteResult> => {
    Object.assign(current, patch);
    return postAction(guildId, "ticket.settings.save", {
      archiveEnabled: current.archiveEnabled,
      logChannelId: current.logChannelId,
      blocklistRoleIds: [...current.blocklistRoleIds],
      primaryColor: current.primaryColor,
      successColor: current.successColor,
      errorColor: current.errorColor,
      footer: current.footer,
      staleAfterMinutes: current.staleAfterMinutes,
      autoCloseAfterMinutes: current.autoCloseAfterMinutes,
      closeButton: current.closeButton,
      claimButton: current.claimButton,
      workingHours: { ...current.workingHours },
    });
  };

  return h(
    "div",
    {},
    h("p", { class: "field-hint" }, t("settingsNote")),
    fieldGroup(
      toggleField({
        label: t("archiveLabel"),
        hint: t("archiveHint"),
        checked: settings.archiveEnabled,
        save: (archiveEnabled) => write({ archiveEnabled }),
      }),
      channelPicker({
        label: t("logChannelLabel"),
        hint: t("logChannelHint"),
        guildId,
        value: settings.logChannelId ?? "",
        placeholder: t("logChannelPlaceholder"),
        save: (raw) => write({ logChannelId: raw }),
        clear: () => write({ logChannelId: null }),
      }),
      roleList(guildId, t("blocklistLabel"), t("blocklistHint"), settings.blocklistRoleIds, (ids) =>
        write({ blocklistRoleIds: ids }),
      ),
      textField({
        label: t("footerLabel"),
        hint: t("footerHint"),
        value: settings.footer ?? "",
        validate: (raw) => (raw.length > FOOTER_MAX ? t("errFooter") : null),
        save: (raw) => write({ footer: raw.trim() === "" ? null : raw.trim() }),
      }),
      // Blank is null, and null means "no staleness clock at all". Zero would
      // mark every ticket stale the moment it opened, which is why this field
      // must never coerce a blank to 0.
      nullableCountField(
        t("staleLabel"),
        t("staleHint"),
        settings.staleAfterMinutes,
        1,
        60 * 24 * 30,
        (staleAfterMinutes) => write({ staleAfterMinutes }),
      ),
      countField(
        t("autoCloseLabel"),
        t("autoCloseHint"),
        settings.autoCloseAfterMinutes,
        1,
        60 * 24 * 30,
        (autoCloseAfterMinutes) => write({ autoCloseAfterMinutes }),
      ),
      toggleField({
        label: t("closeButtonLabel"),
        hint: t("closeButtonHint"),
        checked: settings.closeButton,
        save: (closeButton) => write({ closeButton }),
      }),
      toggleField({
        label: t("claimButtonLabel"),
        hint: t("claimButtonHint"),
        checked: settings.claimButton,
        save: (claimButton) => write({ claimButton }),
      }),
    ),
  );
}

// ─────────────────────────────── Helpers ───────────────────────────────

function plainField(placeholder: string, ariaLabel: string): HTMLInputElement {
  return h("input", {
    class: "control control-text",
    type: "text",
    placeholder,
    "aria-label": ariaLabel,
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
}

function roleList(
  guildId: string,
  label: string,
  hint: string,
  values: readonly string[],
  save: (ids: readonly string[]) => Promise<WriteResult>,
): HTMLElement {
  return multiPickerField({
    label,
    hint,
    guildId,
    kind: "role",
    values,
    placeholder: t("staffPlaceholder"),
    save: async (ids) =>
      ids.length > MAX_ROLES
        ? { kind: "error", message: t("errRoles").replace("{max}", String(MAX_ROLES)) }
        : save(ids),
  });
}

/** A whole number that must be present. */
function countField(
  label: string,
  hint: string,
  value: number,
  min: number,
  max: number,
  save: (n: number) => Promise<WriteResult>,
): HTMLElement {
  return textField({
    label,
    hint,
    value: String(value),
    validate: (raw) => (parseCount(raw, min, max) === null ? t("errNumber") : null),
    save: (raw) => save(parseCount(raw, min, max) as number),
  });
}

/** A whole number, or blank for "none" — which is null, never zero. */
function nullableCountField(
  label: string,
  hint: string,
  value: number | null,
  min: number,
  max: number,
  save: (n: number | null) => Promise<WriteResult>,
): HTMLElement {
  return textField({
    label,
    hint,
    value: value === null ? "" : String(value),
    validate: (raw) => (raw.trim() === "" || parseCount(raw, min, max) !== null ? null : t("errNumber")),
    save: (raw) => save(raw.trim() === "" ? null : (parseCount(raw, min, max) as number)),
  });
}

function parseCount(raw: string, min: number, max: number): number | null {
  const value = Number(raw.trim());
  if (raw.trim() === "" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}
