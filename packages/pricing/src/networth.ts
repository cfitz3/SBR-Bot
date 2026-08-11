/**
 * Networth valuation with the honesty rule (HYPIXEL_DATA_LAYER.md):
 * a total is only `exact` when every required section was readable. If any
 * value-bearing section is missing/API-disabled, the total is a lower-bound
 * estimate and `exact` is false — partial networth is never presented as exact.
 */
import { ok, type NetworthDTO, type NetworthItemDTO, type Result } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { NetworthEngine, NetworthEngineInput, NetworthItem } from "./ports.js";

export interface NetworthRequest {
  readonly engineInput: NetworthEngineInput;
  /** Sections we were actually able to read from the profile. */
  readonly readableSections: readonly string[];
  /** Sections required for an exact valuation (e.g. inventory, armor, museum, bank). */
  readonly requiredSections: readonly string[];
}

export interface NetworthService {
  getNetworth(req: NetworthRequest): Promise<Result<NetworthDTO>>;
}

/**
 * How many items each category shows. Enough to name what is actually carrying
 * a category's value, few enough that a wardrobe doesn't fill the embed.
 */
const TOP_ITEMS_PER_CATEGORY = 3;

/** Most valuable first, worthless entries dropped — an item costed at 0 says nothing. */
function topItems(
  items: Readonly<Record<string, readonly NetworthItem[]>> | undefined,
): Readonly<Record<string, readonly NetworthItemDTO[]>> {
  if (!items) return {};
  const out: Record<string, readonly NetworthItemDTO[]> = {};
  for (const [category, list] of Object.entries(items)) {
    const ranked = list
      .filter((i) => Number.isFinite(i.price) && i.price > 0)
      .sort((a, b) => b.price - a.price)
      .slice(0, TOP_ITEMS_PER_CATEGORY)
      .map((i) => ({ name: i.name, price: i.price }));
    if (ranked.length > 0) out[category] = ranked;
  }
  return out;
}

/** Pure honesty rule — exported for direct unit testing. */
export function buildNetworth(
  total: number | null,
  breakdown: Readonly<Record<string, number>>,
  readableSections: readonly string[],
  requiredSections: readonly string[],
  items?: Readonly<Record<string, readonly NetworthItem[]>>,
): NetworthDTO {
  const readable = new Set(readableSections);
  const missing = requiredSections.filter((s) => !readable.has(s));
  return {
    total,
    exact: total !== null && missing.length === 0,
    missing,
    breakdown,
    topItems: topItems(items),
  };
}

export interface NetworthServiceDeps {
  readonly engine: NetworthEngine;
  readonly logger: Logger;
}

export class NetworthServiceImpl implements NetworthService {
  private readonly engine: NetworthEngine;
  private readonly log: Logger;

  constructor(deps: NetworthServiceDeps) {
    this.engine = deps.engine;
    this.log = deps.logger.child({ service: "networth" });
  }

  async getNetworth(req: NetworthRequest): Promise<Result<NetworthDTO>> {
    try {
      const { total, breakdown, items } = await this.engine.compute(req.engineInput);
      const dto = buildNetworth(total, breakdown, req.readableSections, req.requiredSections, items);
      if (!dto.exact) {
        this.log.info("networth is an estimate (partial data)", { missing: dto.missing });
      }
      return ok(dto);
    } catch (error) {
      this.log.warn("networth engine failed; returning unknown total", {
        error: error instanceof Error ? error.message : "unknown",
      });
      return ok(buildNetworth(null, {}, [], req.requiredSections));
    }
  }
}
