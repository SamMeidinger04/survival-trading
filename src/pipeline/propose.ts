import { randomUUID } from "node:crypto";
import { RISK } from "../risk/constants.js";
import { computeTotalEquity } from "../risk/engine.js";
import type { ResearchNote } from "../schemas/research.js";
import { TradeProposalSchema, type TradeProposal, type AutonomyDecision } from "../schemas/trade.js";
import type { SystemState } from "../schemas/state.js";

export type ProposeOptions = {
  strategy: string;
  /** Strategy-chosen size in USD — risk engine does not cap % of equity. */
  sizeUsd: number;
  expectedHoldingHours?: number;
  maximumHoldingHours?: number;
  now?: Date;
  estimatedProbabilityOfSuccess?: number;
  expectedReturnPct?: number;
  reasonForPositionSize?: string;
  alternativesConsidered?: string[];
};

function addHours(d: Date, hours: number): string {
  return new Date(d.getTime() + hours * 3_600_000).toISOString();
}

/**
 * Build proposal from research. Strategy MUST pass explicit sizeUsd.
 * Risk engine will only check capital sufficiency + hard boundaries.
 */
export function proposeFromResearch(
  research: ResearchNote,
  state: SystemState,
  opts: ProposeOptions,
): TradeProposal {
  const equity = computeTotalEquity(state);
  const sizeUsd = opts.sizeUsd;
  const raw = research.raw ?? {};
  const now = opts.now ?? new Date();
  const entryTimestamp = now.toISOString();

  let side: TradeProposal["side"] = "buy";
  let entryPrice: number | undefined;
  let resolutionDeadline: string | undefined;
  let officialResolutionSource: string | undefined;

  if (research.market === "pumpfun") {
    side = "buy";
    // Use live snapshot price only — never invent a fake entry that breaks MTM
    if (typeof raw.priceUsd === "number" && raw.priceUsd > 0) {
      entryPrice = raw.priceUsd;
    }
  } else {
    const yes = Array.isArray(raw.outcomePrices) ? Number(raw.outcomePrices[0]) : 0.5;
    const modelProb = typeof raw.modelProb === "number" ? raw.modelProb : yes;
    side = modelProb >= yes ? "yes" : "no";
    entryPrice = side === "yes" ? yes : 1 - yes;
    if (typeof raw.endDate === "string") resolutionDeadline = new Date(raw.endDate).toISOString();
    officialResolutionSource =
      typeof raw.officialResolutionSource === "string"
        ? raw.officialResolutionSource
        : `Polymarket official market resolution: ${research.instrument}`;
  }

  let expectedHoldingHours = opts.expectedHoldingHours ?? (research.market === "pumpfun" ? 6 : 12);
  let maximumHoldingHours = opts.maximumHoldingHours ?? (research.market === "pumpfun" ? 24 : 36);

  if (research.market === "polymarket" && resolutionDeadline) {
    const hoursToRes = (Date.parse(resolutionDeadline) - now.getTime()) / 3_600_000;
    if (Number.isFinite(hoursToRes) && hoursToRes > 0) {
      maximumHoldingHours = Number(
        Math.min(maximumHoldingHours, hoursToRes, RISK.MAX_HOLDING_HOURS).toFixed(4),
      );
      expectedHoldingHours = Number(Math.min(expectedHoldingHours, maximumHoldingHours).toFixed(4));
    }
  }
  expectedHoldingHours = Math.min(expectedHoldingHours, RISK.MAX_HOLDING_HOURS);
  maximumHoldingHours = Math.min(maximumHoldingHours, RISK.MAX_HOLDING_HOURS);

  const expectedExitTimestamp = addHours(now, expectedHoldingHours);
  const maximumExitTimestamp = addHours(now, maximumHoldingHours);
  const forcedExitTime = maximumExitTimestamp;

  const pSuccess = opts.estimatedProbabilityOfSuccess ?? Math.min(0.9, Math.max(0.05, research.score / 100));
  const expectedReturnPct = opts.expectedReturnPct ?? (research.market === "pumpfun" ? 0.25 : 0.15);
  const expectedReturnUsd = Number((sizeUsd * expectedReturnPct).toFixed(4));
  // Max loss ≈ full size (binary / memecoin can go to ~0)
  const maximumPossibleLossUsd = sizeUsd;
  const expectedValueUsd = Number(
    (pSuccess * expectedReturnUsd - (1 - pSuccess) * maximumPossibleLossUsd).toFixed(4),
  );
  const percentOfEquityRisked = equity > 0 ? Number(((sizeUsd / equity) * 100).toFixed(4)) : 100;

  const decision: AutonomyDecision = {
    currentTotalEquityUsd: equity,
    amountRiskedUsd: sizeUsd,
    percentOfEquityRisked,
    maximumPossibleLossUsd,
    expectedReturnUsd,
    estimatedProbabilityOfSuccess: pSuccess,
    expectedValueUsd,
    reasonForPositionSize:
      opts.reasonForPositionSize ??
      `Autonomous size ${percentOfEquityRisked.toFixed(2)}% of equity to maximize EV toward total equity growth`,
    alternativesConsidered: opts.alternativesConsidered ?? [
      "no trade (preserve capital)",
      "smaller size (lower variance)",
      "larger size (higher EV if edge holds)",
    ],
    evidenceSupporting:
      research.signals.length > 0 ? research.signals : ["scanner score positive"],
    evidenceAgainst: research.risks.length > 0 ? research.risks : ["model uncertainty"],
    exitConditions:
      research.market === "pumpfun"
        ? `TP +40% / SL -25% / hard exit by ${forcedExitTime}`
        : `TP +25% / SL -20% / hard exit by resolution or ${forcedExitTime}`,
    forcedExitTime,
  };

  return TradeProposalSchema.parse({
    id: randomUUID(),
    createdAt: entryTimestamp,
    market: research.market,
    strategy: opts.strategy,
    side,
    instrument: research.instrument,
    instrumentName: research.instrumentName,
    sizeUsd,
    entryPrice,
    thesis: research.summary,
    evidenceFor: decision.evidenceSupporting,
    evidenceAgainst: decision.evidenceAgainst,
    estimatedEdge: `EV≈$${expectedValueUsd} p=${pSuccess} score=${research.score}`,
    score: research.score,
    exitPlan: {
      takeProfitPct: research.market === "pumpfun" ? 40 : 25,
      stopLossPct: research.market === "pumpfun" ? 25 : 20,
      timeStopHours: maximumHoldingHours,
      rationale: decision.exitConditions,
    },
    timing: {
      entryTimestamp,
      expectedExitTimestamp,
      maximumExitTimestamp,
      expectedHoldingHours,
      maximumHoldingHours,
      reasonMaterializesWithin48h:
        research.market === "pumpfun"
          ? "Short-horizon bonding-curve move expected within ≤48h; forced exit enforced."
          : `Resolution by ${resolutionDeadline ?? maximumExitTimestamp} within 48h.`,
    },
    decision,
    resolutionDeadline,
    officialResolutionSource,
    leverage: 1,
    borrowedFunds: false,
    flags: {
      washTrading: false,
      fakeVolume: false,
      spoofing: false,
      manipulation: false,
    },
    researchRef: research.id,
    metadata: { signals: research.signals, risks: research.risks, dataSource: raw.source },
  });
}
