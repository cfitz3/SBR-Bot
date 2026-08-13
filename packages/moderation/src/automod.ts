/**
 * Automod: the rules that act on a message with nobody in the loop.
 *
 * Two things shape everything below.
 *
 * **It spans both surfaces.** A member who is muted in Discord and carries on in
 * guild chat has not been moderated, they have been redirected. So a rule names
 * the surfaces it applies to, and the same evaluator runs at the Discord
 * message choke-point and inside the relay. There is no second implementation
 * for the game side to drift away from.
 *
 * **It is pure.** Everything time-dependent — how many messages this author has
 * sent in the last ten seconds, how many times they have repeated themselves —
 * arrives as a number the caller has already read. That keeps Redis, the clock
 * and the message source out of the decision, which is what makes the whole
 * table unit-testable and, more importantly, what makes the panel's "test a
 * message" box run *this* code rather than an approximation of it.
 *
 * Automod issues no punishment of its own. A decision is handed back to the
 * caller, which routes it through `ModerationServiceImpl.applyAction` like any
 * other action, so escalation, the audit trail and the in-game relay sync all
 * apply without automod knowing they exist.
 */
import type { BridgeCapability, ModerationSurface, WordlistRuleDTO } from "@sbr/shared-types";
import { evaluateText } from "./wordlist.js";

/** The `GuildSetting` key the policy is stored under. */
export const AUTOMOD_SETTING_KEY = "moderation.automod";

/** What a rule watches for. */
export type AutomodTrigger =
  /** Delegates to the guild's chat filter, so one wordlist backs both features. */
  | { readonly kind: "wordlist" }
  | { readonly kind: "regex"; readonly pattern: string; readonly flags: string }
  /** More than `messages` messages from one author inside the window. */
  | { readonly kind: "spam"; readonly messages: number; readonly windowSeconds: number }
  /** The same text repeated `times` times inside the window. */
  | { readonly kind: "repeat"; readonly times: number; readonly windowSeconds: number }
  | { readonly kind: "mentions"; readonly max: number }
  | { readonly kind: "caps"; readonly percent: number; readonly minLength: number }
  /** Any link whose host is not on the allowlist. An empty allowlist blocks all links. */
  | { readonly kind: "links"; readonly allowlist: readonly string[] }
  | { readonly kind: "invites" };

export type AutomodTriggerKind = AutomodTrigger["kind"];

export const AUTOMOD_TRIGGER_KINDS: readonly AutomodTriggerKind[] = [
  "wordlist",
  "regex",
  "spam",
  "repeat",
  "mentions",
  "caps",
  "links",
  "invites",
];

/**
 * What a rule does when it fires.
 *
 * `FLAG` records and notifies without touching the member — the setting an
 * operator should start a new rule on, and the reason the type exists at all.
 */
export type AutomodActionType = "FLAG" | "WARN" | "MUTE";

export const AUTOMOD_ACTION_TYPES: readonly AutomodActionType[] = ["FLAG", "WARN", "MUTE"];

export interface AutomodAction {
  readonly type: AutomodActionType;
  /**
   * Whether the message itself comes down. Separate from `type` on purpose:
   * "delete it and say nothing" and "warn them but leave the message up" are
   * both things staff ask for, and folding them together would make one of them
   * unexpressible.
   */
  readonly deleteMessage: boolean;
  /** Mute length. Null is an unbounded mute, which only `MUTE` can carry. */
  readonly durationSeconds: number | null;
}

export interface AutomodExemption {
  /** Discord role ids that skip the rule. Meaningless on the guild-chat side. */
  readonly roleIds: readonly string[];
  /** A bridge capability that skips the rule — this is the guild-chat side's staff check. */
  readonly capability: BridgeCapability | null;
}

export interface AutomodRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly surfaces: readonly ModerationSurface[];
  readonly trigger: AutomodTrigger;
  readonly exempt: AutomodExemption;
  readonly action: AutomodAction;
}

export interface AutomodPolicy {
  /** The master switch, so a guild can stop automod without unpicking its rules. */
  readonly enabled: boolean;
  readonly rules: readonly AutomodRule[];
}

/**
 * Counter readings, keyed by rule id.
 *
 * Windowed triggers each get their own key because their windows differ: two
 * spam rules, one at 5-in-10s and one at 20-in-60s, are two independent counts
 * of the same messages. `counterRequestsFor` tells the caller which to read.
 */
export type AutomodCounters = Readonly<Record<string, number>>;

export interface AutomodContext {
  readonly text: string;
  readonly surface: ModerationSurface;
  /** Empty on the guild-chat side, where there are no Discord roles. */
  readonly authorRoleIds: readonly string[];
  readonly authorCapabilities: readonly BridgeCapability[];
  /** Supplied by the caller, which knows how its own platform marks a mention. */
  readonly mentionCount: number;
  readonly counters: AutomodCounters;
  /** The guild's chat-filter rules, for `wordlist` triggers. */
  readonly wordlist: readonly WordlistRuleDTO[];
}

export interface AutomodMatch {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly trigger: AutomodTriggerKind;
  /** A sentence a staffer can read in an audit row, naming what tripped. */
  readonly detail: string;
}

export interface AutomodDecision {
  /** Every rule that fired, in policy order — the test box shows all of them. */
  readonly matched: readonly AutomodMatch[];
  /** The strongest action across all matches; `ALLOW` when nothing fired. */
  readonly action: AutomodActionType | "ALLOW";
  readonly deleteMessage: boolean;
  readonly durationSeconds: number | null;
  /** The reason string handed to `applyAction`. Empty when nothing fired. */
  readonly reason: string;
}

export const ALLOW_DECISION: AutomodDecision = {
  matched: [],
  action: "ALLOW",
  deleteMessage: false,
  durationSeconds: null,
  reason: "",
};

/** A windowed counter the caller must read before evaluating. */
export interface AutomodCounterRequest {
  readonly ruleId: string;
  readonly kind: "spam" | "repeat";
  readonly windowSeconds: number;
}

/**
 * Which counters this policy needs for a message on `surface`.
 *
 * Returned rather than read here so the evaluator stays pure, and scoped to the
 * surface so a Discord message never pays for a guild-chat-only spam rule.
 */
export function counterRequestsFor(
  policy: AutomodPolicy,
  surface: ModerationSurface,
): readonly AutomodCounterRequest[] {
  if (!policy.enabled) return [];
  const out: AutomodCounterRequest[] = [];
  for (const rule of policy.rules) {
    if (!rule.enabled || !rule.surfaces.includes(surface)) continue;
    if (rule.trigger.kind === "spam") {
      out.push({ ruleId: rule.id, kind: "spam", windowSeconds: rule.trigger.windowSeconds });
    } else if (rule.trigger.kind === "repeat") {
      out.push({ ruleId: rule.id, kind: "repeat", windowSeconds: rule.trigger.windowSeconds });
    }
  }
  return out;
}

const SEVERITY: Readonly<Record<AutomodActionType, number>> = { FLAG: 1, WARN: 2, MUTE: 3 };

/**
 * Hosts are compared by suffix so `cdn.example.com` is covered by an
 * `example.com` entry, with the dot boundary checked so `notexample.com` is not.
 */
function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const lower = host.toLowerCase().replace(/^www\./, "");
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^www\./, "");
    if (entry.length === 0) return false;
    return lower === entry || lower.endsWith(`.${entry}`);
  });
}

/** Bare-domain links are common enough in chat that a scheme cannot be required. */
const LINK_RE = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/?#]\S*)?/gi;
const INVITE_RE = /\b(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.me|dsc\.gg)\/[\w-]+/i;

function linksIn(text: string): readonly string[] {
  const hosts: string[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const host = m[1];
    if (host !== undefined) hosts.push(host);
  }
  return hosts;
}

/** The fraction of *letters* that are capitals — digits and punctuation don't shout. */
function capsFraction(text: string): number {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length === 0) return 0;
  const upper = letters.replace(/[^\p{Lu}]/gu, "").length;
  return upper / letters.length;
}

/**
 * Is this author outside the rule?
 *
 * Role and capability are checked independently and either one is enough: on
 * Discord staff are a role, in guild chat they are a capability, and a rule
 * written once has to exempt the same people on both.
 */
function isExempt(rule: AutomodRule, ctx: AutomodContext): boolean {
  if (rule.exempt.roleIds.some((id) => ctx.authorRoleIds.includes(id))) return true;
  if (rule.exempt.capability !== null && ctx.authorCapabilities.includes(rule.exempt.capability)) return true;
  return false;
}

/** Evaluate one trigger, returning the detail line if it fired. */
function fires(rule: AutomodRule, ctx: AutomodContext): string | null {
  const trigger = rule.trigger;
  switch (trigger.kind) {
    case "wordlist": {
      const verdict = evaluateText(ctx.wordlist, ctx.text);
      if (verdict.action === "ALLOW") return null;
      const names = verdict.matched.map((r) => r.id).join(", ");
      return `chat filter matched ${verdict.matched.length} rule(s): ${names}`;
    }
    case "regex": {
      // A malformed pattern never fires, exactly as `compileRule` does: a rule
      // somebody typed wrong months ago must not take down the relay.
      let re: RegExp;
      try {
        re = new RegExp(trigger.pattern, trigger.flags.includes("i") ? trigger.flags : `${trigger.flags}i`);
      } catch {
        return null;
      }
      return re.test(ctx.text) ? `matched pattern (${trigger.pattern.length} chars)` : null;
    }
    case "spam": {
      const count = ctx.counters[rule.id] ?? 0;
      return count >= trigger.messages
        ? `${count} messages in ${trigger.windowSeconds}s (limit ${trigger.messages})`
        : null;
    }
    case "repeat": {
      const count = ctx.counters[rule.id] ?? 0;
      return count >= trigger.times
        ? `same message ${count} times in ${trigger.windowSeconds}s (limit ${trigger.times})`
        : null;
    }
    case "mentions":
      return ctx.mentionCount > trigger.max
        ? `${ctx.mentionCount} mentions (limit ${trigger.max})`
        : null;
    case "caps": {
      if (ctx.text.length < trigger.minLength) return null;
      const fraction = capsFraction(ctx.text);
      return fraction * 100 >= trigger.percent
        ? `${Math.round(fraction * 100)}% capitals (limit ${trigger.percent}%)`
        : null;
    }
    case "links": {
      const hosts = linksIn(ctx.text).filter((h) => !hostAllowed(h, trigger.allowlist));
      return hosts.length > 0 ? `link to ${hosts[0]}` : null;
    }
    case "invites":
      return INVITE_RE.test(ctx.text) ? "server invite link" : null;
  }
}

/**
 * The verdict for one message.
 *
 * Every applicable rule is evaluated rather than stopping at the first match,
 * because the strongest action must win regardless of the order rules happen to
 * sit in the policy — the same reason `evaluateText` does not stop early. The
 * full match list is returned so the panel's test box can show an operator
 * everything their message tripped, not just the one that decided it.
 *
 * A delete stands on its own: any matched rule asking for one gets it, even if a
 * harsher rule that leaves the message up is what sets `action`.
 */
export function evaluateAutomod(policy: AutomodPolicy, ctx: AutomodContext): AutomodDecision {
  if (!policy.enabled) return ALLOW_DECISION;

  const matched: AutomodMatch[] = [];
  let action: AutomodActionType | null = null;
  let deleteMessage = false;
  let durationSeconds: number | null = null;

  for (const rule of policy.rules) {
    if (!rule.enabled) continue;
    if (!rule.surfaces.includes(ctx.surface)) continue;
    if (isExempt(rule, ctx)) continue;

    const detail = fires(rule, ctx);
    if (detail === null) continue;

    matched.push({ ruleId: rule.id, ruleName: rule.name, trigger: rule.trigger.kind, detail });
    if (rule.action.deleteMessage) deleteMessage = true;

    if (action === null || SEVERITY[rule.action.type] > SEVERITY[action]) {
      action = rule.action.type;
      durationSeconds = rule.action.type === "MUTE" ? rule.action.durationSeconds : null;
    } else if (action === "MUTE" && rule.action.type === "MUTE") {
      // Two mutes: the longer one holds. An unbounded mute (null) outranks any
      // finite one — it is the harsher punishment, not a missing value.
      if (durationSeconds !== null) {
        durationSeconds =
          rule.action.durationSeconds === null
            ? null
            : Math.max(durationSeconds, rule.action.durationSeconds);
      }
    }
  }

  if (action === null) return ALLOW_DECISION;

  return {
    matched,
    action,
    deleteMessage,
    durationSeconds,
    reason: `Automod: ${matched.map((m) => m.ruleName).join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function parseSurfaces(value: unknown): readonly ModerationSurface[] {
  const raw = stringList(value).filter((v): v is ModerationSurface => v === "DISCORD" || v === "GUILD_CHAT");
  // A rule with no surfaces would silently never fire; a rule an operator saved
  // without picking one is far more likely to mean "everywhere".
  return raw.length > 0 ? raw : ["DISCORD", "GUILD_CHAT"];
}

/** Null for anything that is not a trigger we can evaluate — the rule is then dropped. */
export function parseTrigger(value: unknown): AutomodTrigger | null {
  if (!isRecord(value)) return null;
  switch (value["kind"]) {
    case "wordlist":
      return { kind: "wordlist" };
    case "invites":
      return { kind: "invites" };
    case "regex": {
      const pattern = value["pattern"];
      if (typeof pattern !== "string" || pattern.trim().length === 0) return null;
      const flags = typeof value["flags"] === "string" ? value["flags"] : "";
      // Checked here rather than at match time so a bad pattern is refused at
      // the point somebody can still fix it.
      try {
        new RegExp(pattern, flags.includes("i") ? flags : `${flags}i`);
      } catch {
        return null;
      }
      return { kind: "regex", pattern, flags };
    }
    case "spam":
      return {
        kind: "spam",
        messages: positiveInt(value["messages"], 5),
        windowSeconds: positiveInt(value["windowSeconds"], 10),
      };
    case "repeat":
      return {
        kind: "repeat",
        times: positiveInt(value["times"], 3),
        windowSeconds: positiveInt(value["windowSeconds"], 30),
      };
    case "mentions":
      return { kind: "mentions", max: positiveInt(value["max"], 5) };
    case "caps":
      return {
        kind: "caps",
        percent: Math.min(positiveInt(value["percent"], 70), 100),
        minLength: positiveInt(value["minLength"], 12),
      };
    case "links":
      return { kind: "links", allowlist: stringList(value["allowlist"]) };
    default:
      return null;
  }
}

function parseAction(value: unknown): AutomodAction {
  const raw = isRecord(value) ? value : {};
  const type = AUTOMOD_ACTION_TYPES.includes(raw["type"] as AutomodActionType)
    ? (raw["type"] as AutomodActionType)
    : "FLAG";
  const durationRaw = raw["durationSeconds"];
  return {
    type,
    deleteMessage: raw["deleteMessage"] === true,
    durationSeconds:
      type === "MUTE" && typeof durationRaw === "number" && Number.isFinite(durationRaw) && durationRaw > 0
        ? Math.floor(durationRaw)
        : null,
  };
}

export function parseRule(value: unknown): AutomodRule | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  if (typeof id !== "string" || id.trim().length === 0) return null;
  const trigger = parseTrigger(value["trigger"]);
  if (trigger === null) return null;

  const exemptRaw = isRecord(value["exempt"]) ? (value["exempt"] as Record<string, unknown>) : {};
  const capability = exemptRaw["capability"];

  return {
    id: id.trim(),
    name: typeof value["name"] === "string" && value["name"].trim().length > 0 ? value["name"].trim() : id.trim(),
    enabled: value["enabled"] !== false,
    surfaces: parseSurfaces(value["surfaces"]),
    trigger,
    exempt: {
      roleIds: stringList(exemptRaw["roleIds"]),
      capability: typeof capability === "string" ? (capability as BridgeCapability) : null,
    },
    action: parseAction(value["action"]),
  };
}

/**
 * The starting policy: off, with nothing in it.
 *
 * Deliberately not a set of switched-on defaults. Automod deletes messages and
 * mutes members, and a guild that installs the platform should not discover
 * after the fact that something started policing its chat on rules it never
 * read. The panel ships suggested rules an operator adds deliberately.
 */
export const DEFAULT_AUTOMOD: AutomodPolicy = { enabled: false, rules: [] };

/**
 * Read the stored policy. Unreadable rules are dropped rather than failing the
 * whole policy, matching the escalation ladder and relay sync: one mangled row
 * should cost that row, not every rule behind it.
 */
export function parseAutomod(raw: unknown): AutomodPolicy {
  if (!isRecord(raw)) return DEFAULT_AUTOMOD;
  const rulesRaw = raw["rules"];
  const rules = Array.isArray(rulesRaw)
    ? rulesRaw.map(parseRule).filter((r): r is AutomodRule => r !== null)
    : [];
  // Ids are the counter keys and the panel's row identity; a duplicate would
  // make two rules share one spam count.
  const seen = new Set<string>();
  const unique = rules.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  return { enabled: raw["enabled"] === true, rules: unique };
}
