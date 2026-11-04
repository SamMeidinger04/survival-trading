export { RISK, isDeadEquity } from "./risk/constants.js";
export {
  validateTradeProposal,
  survivalCheck,
  applyBankrollUpdate,
  applyEquityUpdate,
  syncSurvivalFromEquity,
  computeTotalEquity,
  computeDrawdown,
  deriveSurvivalState,
  positionsRequiringForceExit,
  buildDeathPostMortem,
  capForcedExitIso,
  tryInjectCapital,
} from "./risk/engine.js";
export * from "./schemas/index.js";
export { StateStore, seedState } from "./state/store.js";
export { TradeLogger, computePerformance } from "./logging/logger.js";
export { writeDeathPostMortem } from "./logging/postmortem.js";
export { TradingPipeline } from "./pipeline/execute.js";
export { proposeFromResearch } from "./pipeline/propose.js";
export {
  scanPumpFun,
  scanPolymarket,
  runOpportunityPipeline,
} from "./pipeline/run.js";
export { decideTrade } from "./strategy/autonomousAgent.js";
export { ResilientPumpFunClient, HttpPumpFunClient, FixturePumpFunClient } from "./markets/pumpfun/client.js";
export {
  ResilientPolymarketClient,
  HttpPolymarketClient,
  FixturePolymarketClient,
} from "./markets/polymarket/client.js";
export {
  gatherXTrend,
  gatherXTrendsForCandidates,
  applyXTrendToResearch,
} from "./research/xTrends.js";
