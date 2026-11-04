import type { PolymarketMarketSnapshot } from "../types.js";

/** Resolves within ~24h — valid for 48h survival rule demos. */
const resolveInHours = (h: number) =>
  new Date(Date.now() + h * 3_600_000).toISOString();

export const POLYMARKET_FIXTURES: PolymarketMarketSnapshot[] = [
  {
    id: "demo-poly-btc-1h-move",
    question: "Will BTC be above current price in 24 hours? (demo)",
    slug: "btc-24h-demo",
    outcomePrices: [0.55, 0.45],
    outcomes: ["Yes", "No"],
    volume: 250_000,
    liquidity: 45_000,
    endDate: resolveInHours(24),
    active: true,
    closed: false,
    clobTokenIds: ["demo-yes-token", "demo-no-token"],
    officialResolutionSource: "Polymarket official resolution (demo BTC 24h market)",
    source: "fixture",
  },
  {
    id: "demo-poly-eth-gas-spike",
    question: "Will ETH gas spike above 50 gwei in the next 12 hours? (demo)",
    slug: "eth-gas-12h-demo",
    outcomePrices: [0.42, 0.58],
    outcomes: ["Yes", "No"],
    volume: 80_000,
    liquidity: 22_000,
    endDate: resolveInHours(12),
    active: true,
    closed: false,
    clobTokenIds: ["demo-gas-yes", "demo-gas-no"],
    officialResolutionSource: "Polymarket official resolution (demo ETH gas 12h)",
    source: "fixture",
  },
  /** Intentionally far — risk engine / scorer should reject for live proposals. */
  {
    id: "demo-poly-btc-100k-far",
    question: "Will Bitcoin reach $100,000 by December 31, 2026?",
    slug: "btc-100k-2026-demo",
    outcomePrices: [0.62, 0.38],
    outcomes: ["Yes", "No"],
    volume: 1_250_000,
    liquidity: 85_000,
    endDate: "2026-12-31T23:59:59.000Z",
    active: true,
    closed: false,
    clobTokenIds: ["demo-far-yes", "demo-far-no"],
    source: "fixture",
  },
];
