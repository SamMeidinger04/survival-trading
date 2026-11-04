export type PumpCoinSnapshot = {
  mint: string;
  name: string;
  symbol: string;
  description?: string;
  marketCapUsd?: number;
  usdMarketCap?: number;
  priceUsd?: number;
  volume24h?: number;
  createdTimestamp?: number;
  complete?: boolean;
  bondingCurve?: string;
  source: "live" | "fixture";
  officialResolutionSource?: string;
};

export type PolymarketMarketSnapshot = {
  id: string;
  question: string;
  slug?: string;
  outcomePrices?: number[];
  outcomes?: string[];
  volume?: number;
  liquidity?: number;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  clobTokenIds?: string[];
  officialResolutionSource?: string;
  source: "live" | "fixture";
};

export interface PumpFunClient {
  listRecentCoins(limit?: number): Promise<PumpCoinSnapshot[]>;
  getCoin(mint: string): Promise<PumpCoinSnapshot | null>;
}

export interface PolymarketClient {
  listActiveMarkets(limit?: number): Promise<PolymarketMarketSnapshot[]>;
  getMarket(id: string): Promise<PolymarketMarketSnapshot | null>;
  getMidpoint?(tokenId: string): Promise<number | null>;
}
