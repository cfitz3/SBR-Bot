/**
 * The Discord directory — a guild's channels, roles and members as the gateway
 * sees them, so the panel can offer a picker instead of asking an operator to
 * paste a snowflake they copied out of Discord's developer mode.
 *
 * This is a *port*, not an implementation: the panel process holds no gateway
 * connection, so the only source of truth is the admin bot's internal API
 * (`apps/admin-bot/src/internal-api.ts`), reached over loopback by the adapter in
 * `apps/web-panel/src/directory.ts`.
 *
 * Every row shape carries an `available` flag beside it rather than throwing when
 * the bot is down. A picker whose source is unreachable degrades to the raw-id
 * text field the panel had before — which is a worse experience, not an outage,
 * and that distinction is the whole reason this read never fails hard.
 */

export type DirectoryKind = "channels" | "roles" | "members";

export interface DirectoryChannel {
  readonly id: string;
  readonly name: string;
  /** Coarse kind, not Discord's numeric enum: the picker filters on intent. */
  readonly type: "text" | "voice" | "forum" | "announcement" | "stage" | "category" | "other";
  /** Category name, so a picker can group rows the way Discord's sidebar does. */
  readonly parentName: string | null;
}

export interface DirectoryRole {
  readonly id: string;
  readonly name: string;
  /** Discord's packed RGB integer; 0 means "no colour", not black. */
  readonly color: number;
  readonly position: number;
  /** Bot- and integration-owned roles, which a guild cannot assign by hand. */
  readonly managed: boolean;
}

export interface DirectoryMember {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly nick: string | null;
  readonly avatarHash: string | null;
  readonly roleIds: readonly string[];
  readonly joinedAt: string | null;
  readonly bot: boolean;
}

/**
 * One directory answer. Discriminated on `kind` so the client narrows to a single
 * row type rather than reading three arrays of which two are always empty.
 *
 * `available: false` with an empty list is the "bot unreachable" state and is
 * deliberately not an error — see the file header.
 */
export type DirectoryVM =
  | { readonly kind: "channels"; readonly available: boolean; readonly rows: readonly DirectoryChannel[] }
  | { readonly kind: "roles"; readonly available: boolean; readonly rows: readonly DirectoryRole[] }
  | { readonly kind: "members"; readonly available: boolean; readonly rows: readonly DirectoryMember[] };

/**
 * The port the panel composition fills in.
 *
 * `q` is passed through to the source rather than filtered here: the member list
 * of a large guild is thousands of rows, and shipping all of them to the browser
 * on every keystroke is the cost this endpoint exists to avoid.
 */
export interface DirectorySource {
  channels(guildId: string, q: string): Promise<{ available: boolean; rows: readonly DirectoryChannel[] }>;
  roles(guildId: string, q: string): Promise<{ available: boolean; rows: readonly DirectoryRole[] }>;
  members(guildId: string, q: string): Promise<{ available: boolean; rows: readonly DirectoryMember[] }>;
}
