/**
 * Honest live marks for paper copy positions.
 * SOL/USD: Coinbase / Kraken / OKX / KuCoin (DexScreener often Cloudflare-blocked).
 * Token marks: DexScreener → Pump.fun mcap/supply. Never invent placeholder prices.
 */

import { SOL_MINT } from "./config.js";
import { sleep } from "./rpc.js";

export interface PriceQuote {
  priceUsd: number;
  source: string;
  symbol?: string;
  /** Venue token name (used to skip tokenized equities) */
  name?: string;
  /** Learning features (best effort; null/undefined when venue does not expose) */
  mcapUsd?: number | null;
  liquidityUsd?: number | null;
  /** Pair or coin creation time (ms epoch) */
  createdAtMs?: number | null;
}

let cachedSolUsd: { at: number; price: number; source: string } | null = null;

async function fetchJson(
  url: string,
  timeoutMs = 12_000,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "survival-trading-paper-copy/1.0",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, json: null };
    }
    return { ok: true, status: res.status, json: await res.json() };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchSolFromExchanges(): Promise<PriceQuote | null> {
  // Coinbase
  {
    const r = await fetchJson("https://api.coinbase.com/v2/prices/SOL-USD/spot");
    if (r.ok && r.json && typeof r.json === "object") {
      const amount = num(
        (r.json as { data?: { amount?: string } }).data?.amount,
      );
      if (amount) return { priceUsd: amount, source: "coinbase:SOL-USD" };
    }
  }
  // Kraken
  {
    const r = await fetchJson(
      "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",
    );
    if (r.ok && r.json && typeof r.json === "object") {
      const last = (r.json as { result?: { SOLUSD?: { c?: string[] } } })
        .result?.SOLUSD?.c?.[0];
      const amount = num(last);
      if (amount) return { priceUsd: amount, source: "kraken:SOLUSD" };
    }
  }
  // OKX
  {
    const r = await fetchJson(
      "https://www.okx.com/api/v5/market/ticker?instId=SOL-USDT",
    );
    if (r.ok && r.json && typeof r.json === "object") {
      const last = (r.json as { data?: Array<{ last?: string }> }).data?.[0]
        ?.last;
      const amount = num(last);
      if (amount) return { priceUsd: amount, source: "okx:SOL-USDT" };
    }
  }
  // KuCoin
  {
    const r = await fetchJson(
      "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=SOL-USDT",
    );
    if (r.ok && r.json && typeof r.json === "object") {
      const price = (r.json as { data?: { price?: string } }).data?.price;
      const amount = num(price);
      if (amount) return { priceUsd: amount, source: "kucoin:SOL-USDT" };
    }
  }
  // DexScreener last resort
  {
    const r = await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`,
    );
    if (r.ok && r.json && typeof r.json === "object") {
      const pairs = (r.json as { pairs?: Array<{ priceUsd?: string }> }).pairs;
      const amount = num(pairs?.[0]?.priceUsd);
      if (amount) return { priceUsd: amount, source: "dexscreener:SOL" };
    }
  }
  return null;
}

export async function getSolUsd(): Promise<PriceQuote> {
  const now = Date.now();
  if (cachedSolUsd && now - cachedSolUsd.at < 60_000) {
    return { priceUsd: cachedSolUsd.price, source: cachedSolUsd.source };
  }
  // Env override for offline / blocked environments
  const env = num(process.env.COPYTRADE_SOL_USD);
  if (env) {
    cachedSolUsd = { at: now, price: env, source: "env:COPYTRADE_SOL_USD" };
    return { priceUsd: env, source: "env:COPYTRADE_SOL_USD" };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const q = await fetchSolFromExchanges();
    if (q) {
      cachedSolUsd = { at: now, price: q.priceUsd, source: q.source };
      return q;
    }
    await sleep(400 * (attempt + 1));
  }

  if (cachedSolUsd) {
    return {
      priceUsd: cachedSolUsd.price,
      source: `${cachedSolUsd.source}:stale_cache`,
    };
  }
  throw new Error(
    "Unable to fetch SOL/USD from Coinbase/Kraken/OKX/KuCoin/DexScreener",
  );
}

export async function getTokenPriceUsd(
  mint: string,
): Promise<PriceQuote | null> {
  if (mint === SOL_MINT) {
    return getSolUsd();
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const dex = await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
    );
    if (dex.ok && dex.json && typeof dex.json === "object") {
      const pairs = (
        dex.json as {
          pairs?: Array<{
            priceUsd?: string;
            baseToken?: { symbol?: string; name?: string };
            liquidity?: { usd?: number };
            marketCap?: number;
            fdv?: number;
            pairCreatedAt?: number;
          }>;
        }
      ).pairs;
      if (pairs && pairs.length > 0) {
        const sorted = [...pairs].sort(
          (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
        );
        const best = sorted[0];
        const p = num(best.priceUsd);
        if (p) {
          return {
            priceUsd: p,
            source: "dexscreener",
            symbol: best.baseToken?.symbol,
            name: best.baseToken?.name,
            mcapUsd: num(best.marketCap) ?? num(best.fdv),
            liquidityUsd: num(best.liquidity?.usd),
            createdAtMs: num(best.pairCreatedAt),
          };
        }
      }
    }
    await sleep(300 * (attempt + 1));
  }

  await sleep(250);
  const pump = await fetchJson(
    `https://frontend-api-v3.pump.fun/coins/${mint}`,
  );
  if (pump.ok && pump.json && typeof pump.json === "object") {
    const raw = pump.json as Record<string, unknown>;
    const pumpMcap = num(raw.usd_market_cap ?? raw.usdMarketCap);
    const createdRaw = num(raw.created_timestamp ?? raw.createdTimestamp);
    const createdAtMs =
      createdRaw == null ? null : createdRaw < 1e12 ? createdRaw * 1000 : createdRaw;
    // Bonding-curve liquidity ≈ 2 × real SOL reserves × SOL/USD (best effort).
    let liquidityUsd: number | null = null;
    const realSol = num(raw.real_sol_reserves ?? raw.realSolReserves);
    if (realSol) {
      try {
        const sol = await getSolUsd();
        liquidityUsd = ((realSol / 1e9) * sol.priceUsd) * 2;
      } catch {
        liquidityUsd = null;
      }
    }
    const extra = {
      mcapUsd: pumpMcap,
      liquidityUsd,
      createdAtMs,
      name: raw.name ? String(raw.name) : undefined,
    };
    const direct = num(raw.price_usd ?? raw.priceUsd);
    if (direct) {
      return {
        priceUsd: direct,
        source: "pumpfun_price_usd",
        symbol: raw.symbol ? String(raw.symbol) : undefined,
        ...extra,
      };
    }
    const mcap = num(raw.usd_market_cap ?? raw.usdMarketCap);
    const supply = Number(raw.total_supply ?? raw.totalSupply);
    const decimals = Number(raw.base_decimals ?? raw.baseDecimals ?? 6);
    if (mcap) {
      const uiSupply =
        Number.isFinite(supply) && supply > 0
          ? supply / 10 ** (Number.isFinite(decimals) ? decimals : 6)
          : 1_000_000_000;
      const price = mcap / uiSupply;
      if (Number.isFinite(price) && price > 0) {
        return {
          priceUsd: price,
          source: "pumpfun_mcap",
          symbol: raw.symbol ? String(raw.symbol) : undefined,
          ...extra,
        };
      }
    }
  }

  return null;
}

/**
 * Holder concentration (2026-09-28): top-10 token-account share of supply.
 * NOT cheap on the default public RPC — publicnode rejects getTokenLargestAccounts /
 * getTokenSupply without a personal token, and api.mainnet-beta 429s them. So this is
 * OPT-IN: only runs when COPYTRADE_HOLDER_STATS_RPC is set (e.g. a keyed RPC URL);
 * otherwise features record null. Holder COUNT has no cheap source at all
 * (DexScreener / pump.fun coin APIs don't expose it; exact count needs
 * getProgramAccounts) and is always null.
 */
export function top10PctFrom(
  largestUiAmounts: Array<number | null | undefined>,
  supplyUi: number | null | undefined,
): number | null {
  if (supplyUi == null || !(supplyUi > 0)) return null;
  const top = [...largestUiAmounts]
    .map((x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0))
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((s, x) => s + x, 0);
  return Math.min(1, top / supplyUi);
}

export async function getTop10HolderPct(
  mint: string,
  rpcUrl: string | undefined = process.env.COPYTRADE_HOLDER_STATS_RPC?.trim() || undefined,
): Promise<number | null> {
  if (!rpcUrl) return null;
  const call = async (method: string): Promise<unknown> => {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [mint] }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { result?: unknown; error?: unknown };
      return body.error ? null : body.result ?? null;
    } catch {
      return null;
    }
  };
  const largest = (await call("getTokenLargestAccounts")) as
    | { value?: Array<{ uiAmount?: number | null }> }
    | null;
  const supply = (await call("getTokenSupply")) as { value?: { uiAmount?: number | null } } | null;
  if (!largest?.value || !supply?.value) return null;
  return top10PctFrom(largest.value.map((v) => v.uiAmount), supply.value.uiAmount);
}
