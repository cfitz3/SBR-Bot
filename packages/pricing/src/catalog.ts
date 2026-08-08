/**
 * Item catalog — the name↔id index behind `/price`, `/bazaar` and `/lowestbin`
 * autocomplete.
 *
 * Built from `resources/skyblock/items`, which changes on game updates rather
 * than player activity, so it is loaded once and refreshed on a long timer. A
 * cold or failed load yields an empty catalog: autocomplete showing nothing is
 * a better failure than autocomplete showing wrong ids.
 */
import type { ItemMatchDTO } from "@sbr/shared-types";
import type { ItemResourceProvider } from "./ports.js";

/** Game updates land far less often than this; an hour keeps the memory fresh enough. */
const REFRESH_MS = 60 * 60_000;

interface CatalogEntry {
  readonly itemId: string;
  readonly displayName: string;
  /** Lower-cased display name, precomputed because search runs per keystroke. */
  readonly needle: string;
}

export interface ItemCatalogDeps {
  readonly resources: ItemResourceProvider;
  readonly now?: () => number;
}

export class ItemCatalog {
  private readonly resources: ItemResourceProvider;
  private readonly now: () => number;
  private entries: readonly CatalogEntry[] = [];
  private byId = new Map<string, CatalogEntry>();
  private loadedAt = 0;
  /** In-flight load, so a burst of autocomplete keystrokes triggers one fetch. */
  private inflight: Promise<void> | null = null;

  constructor(deps: ItemCatalogDeps) {
    this.resources = deps.resources;
    this.now = deps.now ?? (() => Date.now());
  }

  private async ensure(): Promise<void> {
    if (this.entries.length > 0 && this.now() - this.loadedAt < REFRESH_MS) return;
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private async load(): Promise<void> {
    const result = await this.resources.getResources("items");
    if (!result.ok) return;

    const raw = result.value.data.data["items"];
    if (!Array.isArray(raw)) return;

    const entries: CatalogEntry[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      const itemId = typeof record["id"] === "string" ? record["id"] : null;
      if (!itemId) continue;
      // Fall back to the id when a name is missing — an entry with no label is
      // still resolvable by id, which is what power users type anyway.
      const displayName = typeof record["name"] === "string" ? record["name"] : itemId;
      entries.push({ itemId, displayName, needle: displayName.toLowerCase() });
    }
    if (entries.length === 0) return;

    entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.entries = entries;
    this.byId = new Map(entries.map((e) => [e.itemId, e]));
    this.loadedAt = this.now();
  }

  /** The display name for an id, or null when the catalog doesn't know it. */
  async displayName(itemId: string): Promise<string | null> {
    await this.ensure();
    return this.byId.get(itemId)?.displayName ?? null;
  }

  /**
   * Suggestions for a partial name. Prefix matches rank above substring ones:
   * typing "hyp" should offer Hyperion before Hyper Catalyst Upgrade.
   */
  async search(query: string, limit = 25): Promise<readonly ItemMatchDTO[]> {
    await this.ensure();
    const q = query.trim().toLowerCase();
    if (q === "") {
      return this.entries.slice(0, limit).map(toMatch);
    }
    const prefix: CatalogEntry[] = [];
    const contains: CatalogEntry[] = [];
    for (const e of this.entries) {
      if (e.needle.startsWith(q)) prefix.push(e);
      else if (e.needle.includes(q)) contains.push(e);
      if (prefix.length >= limit) break;
    }
    return [...prefix, ...contains].slice(0, limit).map(toMatch);
  }

  /**
   * A typed value → canonical id. Accepts an exact id first (autocomplete sends
   * the display name, but a user may paste `HYPERION`), then an exact name,
   * then the single best search hit.
   */
  async resolve(query: string): Promise<string | null> {
    await this.ensure();
    const trimmed = query.trim();
    if (trimmed === "") return null;

    const upper = trimmed.toUpperCase().replace(/\s+/g, "_");
    if (this.byId.has(upper)) return upper;
    if (this.byId.has(trimmed)) return trimmed;

    const lower = trimmed.toLowerCase();
    const exact = this.entries.find((e) => e.needle === lower);
    if (exact) return exact.itemId;

    // With no catalog loaded at all, trust the caller's id rather than refusing
    // outright — the bazaar lookup will report an unknown item honestly.
    if (this.entries.length === 0) return upper;

    return this.entries.find((e) => e.needle.startsWith(lower))?.itemId ?? null;
  }
}

function toMatch(e: CatalogEntry): ItemMatchDTO {
  return { itemId: e.itemId, displayName: e.displayName };
}
