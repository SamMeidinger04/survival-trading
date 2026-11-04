/**
 * Polymarket read-only / paper-trading client.
 *
 * Official docs (verified Sep 2026):
 * - Gamma API (discovery): https://gamma-api.polymarket.com
 * - CLOB API (books/prices): https://clob.polymarket.com
 * - TS SDK: `@polymarket/client` (createPublicClient) — optional; we use public REST
 *   directly so v1 has zero credential / signing surface.
 * Docs: https://docs.polymarket.com/getting-started/api
 *
 * v1: PAPER TRADING ONLY. No SecureClient, no order placement, no live execution.
 */

import type { PolymarketClient, PolymarketMarketSnapshot } from "../types.js";
import { POLYMARKET_FIXTURES } from "./fixtures.js";

const GAMMA = process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com";
const CLOB = process.env.POLYMARKET_CLOB_URL ?? "https://clob.polymarket.com";

function parsePrices(raw: unknown): number[] | undefined {
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map(Number).filter(Number.isFinite);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseOutcomes(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return [raw];
    }
  }
  return undefined;
}

function mapMarket(raw: Record<string, unknown>, source: "live" | "fixture"): PolymarketMarketSnapshot {
  const clobRaw = raw.clobTokenIds ?? raw.clob_token_ids;
  let clobTokenIds: string[] | undefined;
  if (Array.isArray(clobRaw)) clobTokenIds = clobRaw.map(String);
  else if (typeof clobRaw === "string") {
    try {
      const p = JSON.parse(clobRaw) as unknown;
      if (Array.isArray(p)) clobTokenIds = p.map(String);
    } catch {
      clobTokenIds = undefined;
    }
  }

  return {
    id: String(raw.id ?? raw.conditionId ?? raw.condition_id ?? ""),
    question: String(raw.question ?? raw.title ?? "unknown"),
    slug: raw.slug ? String(raw.slug) : undefined,
    outcomePrices: parsePrices(raw.outcomePrices ?? raw.outcome_prices),
    outcomes: parseOutcomes(raw.outcomes),
    volume: num(raw.volume ?? raw.volumeNum),
    liquidity: num(raw.liquidity ?? raw.liquidityNum),
    endDate: raw.endDate ? String(raw.endDate) : raw.end_date_iso ? String(raw.end_date_iso) : undefined,
    active: raw.active === undefined ? true : Boolean(raw.active),
    closed: Boolean(raw.closed),
    clobTokenIds,
    source,
  };
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export class HttpPolymarketClient implements PolymarketClient {
  constructor(
    private readonly gammaUrl = GAMMA,
    private readonly clobUrl = CLOB,
    private readonly timeoutMs = 10_000,
  ) {}

  async listActiveMarkets(limit = 20): Promise<PolymarketMarketSnapshot[]> {
    const url = new URL(`${this.gammaUrl}/markets`);
    url.searchParams.set("closed", "false");
    url.searchParams.set("active", "true");
    url.searchParams.set("limit", String(limit));

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Polymarket Gamma ${res.status}: ${res.statusText}`);
    const data = (await res.json()) as unknown;
    const arr = Array.isArray(data) ? data : [];
    return (arr as Record<string, unknown>[]).map((m) => mapMarket(m, "live")).filter((m) => m.id);
  }

  async getMarket(id: string): Promise<PolymarketMarketSnapshot | null> {
    const url = `${this.gammaUrl}/markets/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Polymarket Gamma ${res.status}: ${res.statusText}`);
    const data = (await res.json()) as Record<string, unknown>;
    return mapMarket(data, "live");
  }

  async getMidpoint(tokenId: string): Promise<number | null> {
    const url = new URL(`${this.clobUrl}/midpoint`);
    url.searchParams.set("token_id", tokenId);
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { mid?: string | number };
    const mid = Number(data.mid);
    return Number.isFinite(mid) ? mid : null;
  }
}

export class FixturePolymarketClient implements PolymarketClient {
  async listActiveMarkets(limit = 20): Promise<PolymarketMarketSnapshot[]> {
    return POLYMARKET_FIXTURES.slice(0, limit);
  }
  async getMarket(id: string): Promise<PolymarketMarketSnapshot | null> {
    return POLYMARKET_FIXTURES.find((m) => m.id === id) ?? null;
  }
  async getMidpoint(_tokenId?: string): Promise<number | null> {
    return 0.62;
  }
}

export class ResilientPolymarketClient implements PolymarketClient {
  private live = new HttpPolymarketClient();
  private fixtures = new FixturePolymarketClient();
  lastSource: "live" | "fixture" = "fixture";

  async listActiveMarkets(limit = 20): Promise<PolymarketMarketSnapshot[]> {
    if (process.env.SURVIVAL_FORCE_FIXTURES === "1") {
      this.lastSource = "fixture";
      return this.fixtures.listActiveMarkets(limit);
    }
    try {
      const markets = await this.live.listActiveMarkets(limit);
      if (markets.length === 0) throw new Error("empty");
      this.lastSource = "live";
      return markets;
    } catch {
      this.lastSource = "fixture";
      return this.fixtures.listActiveMarkets(limit);
    }
  }

  async getMarket(id: string): Promise<PolymarketMarketSnapshot | null> {
    if (process.env.SURVIVAL_FORCE_FIXTURES === "1") {
      this.lastSource = "fixture";
      return this.fixtures.getMarket(id);
    }
    try {
      const m = await this.live.getMarket(id);
      this.lastSource = "live";
      return m;
    } catch {
      this.lastSource = "fixture";
      return this.fixtures.getMarket(id);
    }
  }

  async getMidpoint(tokenId: string): Promise<number | null> {
    if (process.env.SURVIVAL_FORCE_FIXTURES === "1") return this.fixtures.getMidpoint!(tokenId);
    try {
      return await this.live.getMidpoint!(tokenId);
    } catch {
      return this.fixtures.getMidpoint!(tokenId);
    }
  }
}
