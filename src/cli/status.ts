#!/usr/bin/env node
import { StateStore } from "../state/store.js";
import { survivalCheck, computeTotalEquity } from "../risk/engine.js";
import { computePerformance } from "../logging/logger.js";
import { RISK } from "../risk/constants.js";

const store = new StateStore();
const state = store.load();
const survival = survivalCheck(state);
const perf = computePerformance(state);

console.log("=== Autonomy Capital Experiment Status ===");
console.log(
  JSON.stringify(
    {
      objective: RISK.PRIMARY_OBJECTIVE,
      hardBoundaries: {
        startingCash: RISK.STARTING_CASH_USD,
        maxHoldingHours: RISK.MAX_HOLDING_HOURS,
        killEquity: RISK.KILL_EQUITY_USD,
        noLeverage: !RISK.ALLOW_LEVERAGE,
        noBorrowing: !RISK.ALLOW_BORROWING,
        noAutoFund: !RISK.ALLOW_AUTO_FUND_ADD,
        noFixedSizeCaps: !RISK.HAS_FIXED_POSITION_PCT_CAPS,
      },
      cashUsd: state.cashUsd,
      totalEquityUsd: computeTotalEquity(state),
      peakEquityUsd: state.peakEquityUsd,
      agentStatus: state.agentStatus,
      survivalStateInfoOnly: state.survivalState,
      tradingEnabled: state.tradingEnabled,
      survival,
      performance: perf,
      openPositions: state.openPositions.length,
      deathPostMortem: state.deathPostMortem ?? null,
    },
    null,
    2,
  ),
);
