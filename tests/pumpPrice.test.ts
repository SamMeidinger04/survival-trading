import { describe, it, expect } from "vitest";
import { derivePriceUsd } from "../src/markets/pumpfun/client.js";

describe("derivePriceUsd", () => {
  it("uses direct price_usd when present", () => {
    expect(derivePriceUsd({ price_usd: 0.000042 })).toBeCloseTo(0.000042, 12);
  });

  it("derives from usd_market_cap / UI supply", () => {
    // Maggie-like: $3316 mcap, 1e15 raw / 6 decimals => 1e9 UI
    const px = derivePriceUsd({
      usd_market_cap: 3316.109849495439,
      total_supply: 1_000_000_000_000_000,
      base_decimals: 6,
    });
    expect(px).toBeCloseTo(3316.109849495439 / 1_000_000_000, 12);
  });

  it("falls back to 1B supply when total_supply missing", () => {
    expect(derivePriceUsd({ usd_market_cap: 5000 })).toBeCloseTo(0.000005, 12);
  });
});
