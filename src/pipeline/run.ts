import { ResilientPumpFunClient } from "../markets/pumpfun/client.js";
import { ResilientPolymarketClient } from "../markets/polymarket/client.js";
import { scorePumpCoin, scorePolymarket } from "../research/scorer.js";
import { TradingPipeline } from "./execute.js";
import { StateStore } from "../state/store.js";
import { TradeLogger } from "../logging/logger.js";
import { decideTrade } from "../strategy/autonomousAgent.js";
import type { ResearchNote } from "../schemas/research.js";
import type { PipelineResult } from "./execute.js";

export type ScanResult = {
  market: "pumpfun" | "polymarket";
  source: "live" | "fixture";
  research: ResearchNote[];
  best: ResearchNote | null;
};

export async function scanPumpFun(limit = 10): Promise<ScanResult> {
  const client = new ResilientPumpFunClient();
  const coins = await client.listRecentCoins(limit);
  const research = coins.map(scorePumpCoin).sort((a, b) => b.score - a.score);
  const logger = new TradeLogger();
  for (const r of research) logger.logResearch(r);
  return {
    market: "pumpfun",
    source: client.lastSource,
    research,
    best: research[0] ?? null,
  };
}

export async function scanPolymarket(limit = 10): Promise<ScanResult> {
  const client = new ResilientPolymarketClient();
  const markets = await client.listActiveMarkets(limit);
  const research = markets.map(scorePolymarket).sort((a, b) => b.score - a.score);
  const logger = new TradeLogger();
  for (const r of research) logger.logResearch(r);
  return {
    market: "polymarket",
    source: client.lastSource,
    research,
    best: research[0] ?? null,
  };
}

export async function runOpportunityPipeline(opts: {
  market: "pumpfun" | "polymarket";
  strategy?: string;
  minScore?: number;
  dataDir?: string;
  aggressiveness?: "conservative" | "balanced" | "aggressive";
}): Promise<{ scan: ScanResult; result: PipelineResult | null; agentAction?: string }> {
  const store = new StateStore(opts.dataDir ? `${opts.dataDir}/state` : undefined);
  const logger = new TradeLogger(opts.dataDir ? `${opts.dataDir}/logs` : undefined);
  const pipeline = new TradingPipeline(store, logger);

  const scan = opts.market === "pumpfun" ? await scanPumpFun() : await scanPolymarket();
  const minScore = opts.minScore ?? 45;
  if (!scan.best || scan.best.score < minScore) {
    return { scan, result: null, agentAction: "no_trade_low_score" };
  }

  const state = store.load();
  const decision = decideTrade(scan.best, state, {
    aggressiveness: opts.aggressiveness ?? "balanced",
  });
  if (decision.action === "no_trade") {
    return { scan, result: null, agentAction: decision.reason };
  }
  const result = pipeline.processProposal(decision.proposal);
  return { scan, result, agentAction: decision.reason };
}
