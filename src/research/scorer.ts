import type { PumpCoinSnapshot, PolymarketMarketSnapshot } from "../markets/types.js";
import type { ResearchNote } from "../schemas/research.js";
import { randomUUID } from "node:crypto";

/** Simple deterministic opportunity scoring for v1 (0–100). */
export function scorePumpCoin(coin: PumpCoinSnapshot): ResearchNote {
  const signals: string[] = [];
  const risks: string[] = [];
  let score = 40;

  const ageMin =
    coin.createdTimestamp != null
      ? (Date.now() - coin.createdTimestamp) / 60_000
      : undefined;

  if (ageMin != null && ageMin < 120) {
    score += 15;
    signals.push("fresh launch (<2h)");
  } else if (ageMin != null && ageMin > 24 * 60) {
    score -= 10;
    risks.push("older than 24h — momentum may be stale");
  }

  const mcap = coin.usdMarketCap ?? coin.marketCapUsd ?? 0;
  if (mcap > 10_000 && mcap < 200_000) {
    score += 15;
    signals.push("market cap in early-stage band");
  } else if (mcap >= 200_000) {
    score -= 5;
    risks.push("higher mcap — less asymmetric upside");
  }

  const vol = coin.volume24h ?? 0;
  if (vol > 5_000) {
    score += 10;
    signals.push("meaningful 24h volume");
  } else {
    risks.push("thin volume — slippage risk in live markets");
  }

  if (coin.complete) {
    score -= 20;
    risks.push("already graduated / complete bonding curve");
  }

  score = clamp(score, 0, 100);

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    market: "pumpfun",
    instrument: coin.mint,
    instrumentName: `${coin.symbol} (${coin.name})`,
    summary: `Pump.fun scan of ${coin.symbol}: mcap≈$${mcap}, vol≈$${vol}, source=${coin.source}`,
    signals,
    risks,
    score,
    raw: { ...coin },
  };
}

/**
 * Naive probability edge model:
 * if market Yes price differs from a simple "fair" prior, score the edge.
 * v1 uses liquidity/volume + distance from 0.5 as heuristics — NOT a production model.
 */
export function scorePolymarket(market: PolymarketMarketSnapshot): ResearchNote {
  const signals: string[] = [];
  const risks: string[] = [];
  let score = 35;

  const yes = market.outcomePrices?.[0] ?? 0.5;
  const distanceFromCoinFlip = Math.abs(yes - 0.5);
  // Prefer markets that aren't fully decided
  if (distanceFromCoinFlip < 0.35) {
    score += 15;
    signals.push("not fully decided (price away from extremes)");
  } else {
    score -= 10;
    risks.push("price near extreme — limited edge / asymmetric risk");
  }

  const vol = market.volume ?? 0;
  if (vol > 100_000) {
    score += 15;
    signals.push("strong volume");
  } else if (vol < 10_000) {
    score -= 5;
    risks.push("low volume");
  }

  const liq = market.liquidity ?? 0;
  if (liq > 20_000) {
    score += 10;
    signals.push("adequate liquidity for paper size");
  } else {
    risks.push("thin liquidity");
  }

  // Tiny heuristic "model": regress slightly toward 0.5
  const modelProb = yes * 0.7 + 0.5 * 0.3;
  const edge = modelProb - yes;
  if (Math.abs(edge) > 0.03) {
    score += 10;
    signals.push(`model edge ≈ ${(edge * 100).toFixed(1)}pp vs market`);
  } else {
    risks.push("no clear model edge");
  }

  if (market.closed) {
    score = 0;
    risks.push("market closed");
  }

  score = clamp(score, 0, 100);

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    market: "polymarket",
    instrument: market.id,
    instrumentName: market.question,
    summary: `Polymarket "${market.question}" yes=${yes.toFixed(3)} model=${modelProb.toFixed(3)} source=${market.source}`,
    signals,
    risks,
    score,
    raw: { ...market, modelProb, edge },
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
