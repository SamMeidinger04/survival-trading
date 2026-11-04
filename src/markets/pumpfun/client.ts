/**
 * Pump.fun read-only market client.
 *
 * Official tooling (verified Sep 2026):
 * - Program SDK: `@pump-fun/pump-sdk` (npm) — builds Solana buy/sell/create instructions.
 *   Docs: https://github.com/pump-fun/pump-public-docs
 * - There is no official public market-data REST API. Community/frontend endpoints
 *   (e.g. https://frontend-api-v3.pump.fun/coins) are used for READ-ONLY scanning
 *   when reachable; otherwise fixtures are used.
 *
 * v1 constraints: NO wallet, NO signing, NO live execution. Simulation only.
 */

import type { PumpCoinSnapshot, PumpFunClient } from "../types.js";
import { PUMPFUN_FIXTURES } from "./fixtures.js";

const FRONTEND_API = process.env.PUMPFUN_API_BASE ?? "https://frontend-api-v3.pump.fun";

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pump frontend API often omits price_usd. Derive from usd_market_cap / UI supply
 * (total_supply / 10^decimals). Standard pump supply is 1e9 UI tokens.
 */
export function derivePriceUsd(raw: Record<string, unknown>): number | undefined {
  const direct = num(raw.price_usd ?? raw.priceUsd);
  if (direct != null && direct > 0) return direct;

  const usdMcap = num(raw.usd_market_cap ?? raw.usdMarketCap);
  const totalSupply = num(raw.total_supply ?? raw.totalSupply);
  const decimals = num(raw.base_decimals ?? raw.baseDecimals) ?? 6;
  if (usdMcap != null && usdMcap > 0 && totalSupply != null && totalSupply > 0) {
    const uiSupply = totalSupply / 10 ** decimals;
    if (uiSupply > 0) return usdMcap / uiSupply;
  }
  // Fallback: classic pump.fun 1B token supply
  if (usdMcap != null && usdMcap > 0) return usdMcap / 1_000_000_000;
  return undefined;
}

function mapCoin(raw: Record<string, unknown>, source: "live" | "fixture"): PumpCoinSnapshot {
  const usdMarketCap = num(raw.usd_market_cap ?? raw.usdMarketCap);
  return {
    mint: String(raw.mint ?? raw.address ?? ""),
    name: String(raw.name ?? "unknown"),
    symbol: String(raw.symbol ?? "?"),
    description: raw.description ? String(raw.description) : undefined,
    // Prefer USD mcap; raw.market_cap from API is often SOL not USD
    marketCapUsd: usdMarketCap ?? num(raw.market_cap ?? raw.marketCap),
    usdMarketCap,
    priceUsd: derivePriceUsd(raw),
    volume24h: num(raw.volume_24h ?? raw.volume24h ?? raw.volume),
    createdTimestamp: num(raw.created_timestamp ?? raw.createdTimestamp),
    complete: Boolean(raw.complete),
    bondingCurve: raw.bonding_curve ? String(raw.bonding_curve) : undefined,
    source,
  };
}

async function fetchJsonWithRetry(
  url: string,
  timeoutMs: number,
  retries = 3,
): Promise<{ status: number; json: unknown | null; textStatus: string }> {
  let lastStatus = 0;
  let lastStatusText = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "survival-trading-paper/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    lastStatus = res.status;
    lastStatusText = res.statusText;
    if (res.status === 429 || res.status === 503) {
      const wait = 800 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 404) return { status: 404, json: null, textStatus: res.statusText };
    if (!res.ok) throw new Error(`Pump.fun API ${res.status}: ${res.statusText}`);
    return { status: res.status, json: await res.json(), textStatus: res.statusText };
  }
  throw new Error(`Pump.fun API ${lastStatus}: ${lastStatusText}`);
}

export class HttpPumpFunClient implements PumpFunClient {
  constructor(
    private readonly baseUrl: string = FRONTEND_API,
    private readonly timeoutMs = 8_000,
  ) {}

  async listRecentCoins(limit = 20): Promise<PumpCoinSnapshot[]> {
    const url = new URL(`${this.baseUrl}/coins`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", "0");
    url.searchParams.set("sort", "created_timestamp");
    url.searchParams.set("order", "DESC");
    url.searchParams.set("includeNsfw", "false");

    const { json: data } = await fetchJsonWithRetry(url.toString(), this.timeoutMs);
    const arr = Array.isArray(data) ? data : (data as { coins?: unknown[] })?.coins ?? [];
    return (arr as Record<string, unknown>[]).map((c) => mapCoin(c, "live")).filter((c) => c.mint);
  }

  async getCoin(mint: string): Promise<PumpCoinSnapshot | null> {
    const url = `${this.baseUrl}/coins/${encodeURIComponent(mint)}?sync=false`;
    const { status, json: data } = await fetchJsonWithRetry(url, this.timeoutMs);
    if (status === 404 || data == null) return null;
    return mapCoin(data as Record<string, unknown>, "live");
  }
}

export class FixturePumpFunClient implements PumpFunClient {
  async listRecentCoins(limit = 20): Promise<PumpCoinSnapshot[]> {
    return PUMPFUN_FIXTURES.slice(0, limit);
  }
  async getCoin(mint: string): Promise<PumpCoinSnapshot | null> {
    return PUMPFUN_FIXTURES.find((c) => c.mint === mint) ?? null;
  }
}

/**
 * Tries live frontend API; falls back to fixtures on failure.
 * Set SURVIVAL_FORCE_FIXTURES=1 to always use fixtures.
 */
export class ResilientPumpFunClient implements PumpFunClient {
  private live = new HttpPumpFunClient();
  private fixtures = new FixturePumpFunClient();
  lastSource: "live" | "fixture" = "fixture";

  async listRecentCoins(limit = 20): Promise<PumpCoinSnapshot[]> {
    if (process.env.SURVIVAL_FORCE_FIXTURES === "1") {
      this.lastSource = "fixture";
      return this.fixtures.listRecentCoins(limit);
    }
    try {
      const coins = await this.live.listRecentCoins(limit);
      this.lastSource = "live";
      return coins;
    } catch {
      this.lastSource = "fixture";
      return this.fixtures.listRecentCoins(limit);
    }
  }

  async getCoin(mint: string): Promise<PumpCoinSnapshot | null> {
    if (process.env.SURVIVAL_FORCE_FIXTURES === "1") {
      this.lastSource = "fixture";
      return this.fixtures.getCoin(mint);
    }
    try {
      const coin = await this.live.getCoin(mint);
      this.lastSource = "live";
      return coin;
    } catch {
      this.lastSource = "fixture";
      return this.fixtures.getCoin(mint);
    }
  }
}
