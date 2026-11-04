import type { TradeProposal, AutonomyDecision } from "../src/schemas/trade.js";
import type { Position } from "../src/schemas/state.js";
import { RISK } from "../src/risk/constants.js";

export function hoursFromNow(hours: number, base = new Date()): string {
  return new Date(base.getTime() + hours * 3_600_000).toISOString();
}

export function makeDecision(
  sizeUsd: number,
  equity = 100,
  over: Partial<AutonomyDecision> = {},
): AutonomyDecision {
  const forced = over.forcedExitTime ?? hoursFromNow(24);
  return {
    currentTotalEquityUsd: equity,
    amountRiskedUsd: sizeUsd,
    percentOfEquityRisked: equity > 0 ? (sizeUsd / equity) * 100 : 100,
    maximumPossibleLossUsd: sizeUsd,
    expectedReturnUsd: sizeUsd * 0.2,
    estimatedProbabilityOfSuccess: 0.55,
    expectedValueUsd: sizeUsd * 0.55 * 0.2 - sizeUsd * 0.45,
    reasonForPositionSize: over.reasonForPositionSize ?? `Strategy chose $${sizeUsd} (${((sizeUsd / equity) * 100).toFixed(2)}% equity)`,
    alternativesConsidered: over.alternativesConsidered ?? ["no trade", "half size", "double size"],
    evidenceSupporting: over.evidenceSupporting ?? ["edge signal"],
    evidenceAgainst: over.evidenceAgainst ?? ["uncertainty"],
    exitConditions: over.exitConditions ?? "TP/SL + 48h force exit",
    forcedExitTime: forced,
    ...over,
  };
}

export function baseProposal(over: Partial<TradeProposal> = {}): TradeProposal {
  const now = new Date();
  const entryTimestamp = over.timing?.entryTimestamp ?? now.toISOString();
  const expectedH = over.timing?.expectedHoldingHours ?? 6;
  const maxH = over.timing?.maximumHoldingHours ?? 24;
  const entryDate = new Date(entryTimestamp);

  const timing = {
    entryTimestamp,
    expectedExitTimestamp: hoursFromNow(expectedH, entryDate),
    maximumExitTimestamp: hoursFromNow(maxH, entryDate),
    expectedHoldingHours: expectedH,
    maximumHoldingHours: maxH,
    reasonMaterializesWithin48h: "Test edge within 48h",
    ...over.timing,
  };
  if (over.timing?.expectedHoldingHours != null && !over.timing.expectedExitTimestamp) {
    timing.expectedExitTimestamp = hoursFromNow(timing.expectedHoldingHours, entryDate);
  }
  if (over.timing?.maximumHoldingHours != null && !over.timing.maximumExitTimestamp) {
    timing.maximumExitTimestamp = hoursFromNow(timing.maximumHoldingHours, entryDate);
  }

  const sizeUsd = over.sizeUsd ?? 1.5;
  const { timing: _t, exitPlan: exitPlanOver, decision: decisionOver, ...rest } = over;

  return {
    id: "test-1",
    createdAt: entryTimestamp,
    market: "pumpfun",
    strategy: "test",
    side: "buy",
    instrument: "mint1",
    sizeUsd,
    entryPrice: 0.001,
    thesis: "unit test thesis",
    evidenceFor: ["fixture momentum"],
    evidenceAgainst: ["thin liquidity"],
    estimatedEdge: "sim edge",
    score: 70,
    exitPlan: exitPlanOver ?? {
      takeProfitPct: 30,
      stopLossPct: 15,
      timeStopHours: timing.maximumHoldingHours,
      rationale: "TP/SL with hard time stop ≤48h",
    },
    decision: decisionOver ?? makeDecision(sizeUsd, 100, { forcedExitTime: timing.maximumExitTimestamp }),
    leverage: 1,
    borrowedFunds: false,
    flags: {
      washTrading: false,
      fakeVolume: false,
      spoofing: false,
      manipulation: false,
    },
    ...rest,
    timing,
  };
}

export function openPos(id: string, over: Partial<Position> = {}): Position {
  const openedAt = over.openedAt ?? new Date().toISOString();
  const maxH = over.maximumHoldingHours ?? 24;
  const forcedExitAt =
    over.forcedExitAt ?? new Date(Date.parse(openedAt) + maxH * 3_600_000).toISOString();
  return {
    id,
    proposalId: `p-${id}`,
    market: "pumpfun",
    strategy: "test",
    side: "buy",
    instrument: `m-${id}`,
    sizeUsd: 1,
    entryPrice: 1,
    currentMarketValueUsd: 1,
    openedAt,
    forcedExitAt,
    maximumHoldingHours: maxH,
    timing: {
      entryTimestamp: openedAt,
      expectedExitTimestamp: forcedExitAt,
      maximumExitTimestamp: forcedExitAt,
      expectedHoldingHours: maxH,
      maximumHoldingHours: maxH,
      reasonMaterializesWithin48h: "test",
    },
    thesis: "test thesis",
    evidenceFor: ["a"],
    evidenceAgainst: ["b"],
    estimatedEdge: "edge",
    exitPlan: { takeProfitPct: 20, stopLossPct: 10, rationale: "test exit" },
    unrealizedPnlUsd: 0,
    status: "open",
    ...over,
  };
}

export { RISK };
