import type { PumpCoinSnapshot } from "../types.js";

/** Deterministic fixture coins for offline demo / flaky-API fallback. */
export const PUMPFUN_FIXTURES: PumpCoinSnapshot[] = [
  {
    mint: "DemoPumpMint11111111111111111111111111111",
    name: "Survival Demo Cat",
    symbol: "SDCAT",
    description: "Fixture meme coin for survival-trading simulation",
    marketCapUsd: 42_000,
    usdMarketCap: 42_000,
    priceUsd: 0.000042,
    volume24h: 8_500,
    createdTimestamp: Date.now() - 1000 * 60 * 45,
    complete: false,
    bondingCurve: "DemoBondingCurve1111111111111111111111",
    source: "fixture",
  },
  {
    mint: "DemoPumpMint22222222222222222222222222222",
    name: "Quiet Launch Frog",
    symbol: "QLFROG",
    description: "Lower volume fixture — should score lower",
    marketCapUsd: 120_000,
    usdMarketCap: 120_000,
    priceUsd: 0.00012,
    volume24h: 900,
    createdTimestamp: Date.now() - 1000 * 60 * 60 * 6,
    complete: false,
    source: "fixture",
  },
];
