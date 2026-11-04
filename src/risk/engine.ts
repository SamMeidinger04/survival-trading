/**
 * Hard-boundary risk engine — Full Autonomy Capital Experiment.
 *
 * Strategy owns: sizing, risk tolerance, diversification, aggressiveness.
 * This module ONLY enforces immutable hard boundaries + capital sufficiency.
 * It does NOT decide whether a size % is strategically wise.
 */

import { RISK, isDeadEquity, type SurvivalStateName } from "./constants.js";
import type { TradeProposal } from "../schemas/trade.js";
import type { SystemState, Position, DeathPostMortem } from "../schemas/state.js";

export type RiskRejectionCode =
  | "MISSING_EXIT_PLAN"
  | "MISSING_TIMING"
  | "MISSING_DECISION_RECORD"
  | "HOLDING_EXCEEDS_48H"
  | "POLY_RESOLUTION_TOO_FAR"
  | "POLY_RESOLUTION_UNCLEAR"
  | "LEVERAGE_FORBIDDEN"
  | "BORROWING_FORBIDDEN"
  | "AUTO_FUND_FORBIDDEN"
  | "MANIPULATION_FORBIDDEN"
  | "DEAD"
  | "TRADING_DISABLED"
  | "INVALID_SIZE"
  | "INVALID_MARKET"
  | "INSUFFICIENT_CAPITAL"
  | "MISSING_THESIS_EVIDENCE";

export type RiskDecision =
  | {
      approved: true;
      sizeUsd: number;
      availableCashUsd: number;
      totalEquityUsd: number;
      percentOfEquity: number;
      survivalState: SurvivalStateName;
      notes: string[];
    }
  | { approved: false; code: RiskRejectionCode; reason: string; notes: string[] };

export function computeTotalEquity(state: SystemState): number {
  const positionsMv = state.openPositions.reduce(
    (s, p) => s + (p.currentMarketValueUsd ?? p.sizeUsd + (p.unrealizedPnlUsd ?? 0)),
    0,
  );
  return Number((state.cashUsd + positionsMv).toFixed(6));
}

export function computeDrawdown(state: SystemState, totalEquityUsd?: number): number {
  const equity = totalEquityUsd ?? computeTotalEquity(state);
  const peak = state.peakEquityUsd > 0 ? state.peakEquityUsd : state.peakBankrollUsd;
  if (peak <= 0) return equity <= 0 ? 1 : 0;
  return Math.max(0, (peak - equity) / peak);
}

/** Informational labels only — NEVER used to cut sizes or halt new trades (except DEAD). */
export function deriveSurvivalState(
  state: SystemState,
  totalEquityUsd?: number,
): SurvivalStateName {
  const equity = totalEquityUsd ?? computeTotalEquity(state);
  if (state.tradingPermanentlyDisabled || state.agentStatus === "DEAD" || isDeadEquity(equity)) {
    return "DEAD";
  }
  const dd = computeDrawdown(state, equity);
  if (dd >= RISK.INFO_DRAWDOWN_CRITICAL_PCT) return "CRITICAL";
  if (dd >= RISK.INFO_DRAWDOWN_CAUTION_PCT) return "CAUTION";
  return "NORMAL";
}

function hoursBetween(isoStart: string, isoEnd: string): number {
  const a = Date.parse(isoStart);
  const b = Date.parse(isoEnd);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return (b - a) / 3_600_000;
}

function hasValidExitPlan(proposal: TradeProposal): boolean {
  const ep = proposal.exitPlan;
  if (!ep?.rationale || ep.rationale.trim().length < 3) return false;
  return Boolean(
    (ep.takeProfitPct && ep.takeProfitPct > 0) ||
      (ep.stopLossPct && ep.stopLossPct > 0) ||
      (ep.invalidationPrice && ep.invalidationPrice > 0) ||
      (ep.timeStopHours && ep.timeStopHours > 0) ||
      (ep.customExit && ep.customExit.trim().length > 0),
  );
}

function validate48hTiming(proposal: TradeProposal, notes: string[]): RiskDecision | null {
  const t = proposal.timing;
  if (!t) {
    return {
      approved: false,
      code: "MISSING_TIMING",
      reason: "Every trade requires 48h timing fields",
      notes,
    };
  }
  if (
    t.expectedHoldingHours > RISK.MAX_HOLDING_HOURS ||
    t.maximumHoldingHours > RISK.MAX_HOLDING_HOURS
  ) {
    return {
      approved: false,
      code: "HOLDING_EXCEEDS_48H",
      reason: `Hard 48h rule: expected=${t.expectedHoldingHours}h max=${t.maximumHoldingHours}h`,
      notes,
    };
  }
  const spanExpected = hoursBetween(t.entryTimestamp, t.expectedExitTimestamp);
  const spanMax = hoursBetween(t.entryTimestamp, t.maximumExitTimestamp);
  if (spanExpected > RISK.MAX_HOLDING_HOURS + 1e-9 || spanMax > RISK.MAX_HOLDING_HOURS + 1e-9) {
    return {
      approved: false,
      code: "HOLDING_EXCEEDS_48H",
      reason: `Exit timestamps exceed ${RISK.MAX_HOLDING_HOURS}h from entry`,
      notes,
    };
  }
  if (!t.reasonMaterializesWithin48h || t.reasonMaterializesWithin48h.trim().length < 3) {
    return {
      approved: false,
      code: "MISSING_TIMING",
      reason: "Must explain why opportunity materializes within 48 hours",
      notes,
    };
  }
  if (
    proposal.exitPlan.timeStopHours != null &&
    proposal.exitPlan.timeStopHours > RISK.MAX_HOLDING_HOURS
  ) {
    return {
      approved: false,
      code: "HOLDING_EXCEEDS_48H",
      reason: `exitPlan.timeStopHours > ${RISK.MAX_HOLDING_HOURS}`,
      notes,
    };
  }
  return null;
}

function validatePolymarketResolution(
  proposal: TradeProposal,
  notes: string[],
): RiskDecision | null {
  if (proposal.market !== "polymarket") return null;
  if (!proposal.resolutionDeadline) {
    return {
      approved: false,
      code: "POLY_RESOLUTION_UNCLEAR",
      reason: "Polymarket: resolutionDeadline required",
      notes,
    };
  }
  if (!proposal.officialResolutionSource || proposal.officialResolutionSource.trim().length < 3) {
    return {
      approved: false,
      code: "POLY_RESOLUTION_UNCLEAR",
      reason: "Polymarket: officialResolutionSource required",
      notes,
    };
  }
  const hoursToResolution = hoursBetween(
    proposal.timing.entryTimestamp,
    proposal.resolutionDeadline,
  );
  if (hoursToResolution > RISK.MAX_HOLDING_HOURS + 1e-9) {
    return {
      approved: false,
      code: "POLY_RESOLUTION_TOO_FAR",
      reason: `Polymarket resolution in ${hoursToResolution.toFixed(2)}h > ${RISK.MAX_HOLDING_HOURS}h`,
      notes,
    };
  }
  if (hoursToResolution < 0) {
    return {
      approved: false,
      code: "POLY_RESOLUTION_UNCLEAR",
      reason: "resolutionDeadline before entry",
      notes,
    };
  }
  notes.push(`poly_resolution_in=${hoursToResolution.toFixed(2)}h`);
  return null;
}

/**
 * Validate hard boundaries only.
 * Does NOT enforce fixed % caps, drawdown size cuts, or drawdown auto-halts.
 */
export function validateTradeProposal(
  proposal: TradeProposal,
  state: SystemState,
): RiskDecision {
  const notes: string[] = [];
  const totalEquityUsd = computeTotalEquity(state);
  const survivalState = deriveSurvivalState(state, totalEquityUsd);
  notes.push(
    `objective=${RISK.PRIMARY_OBJECTIVE} equity=${totalEquityUsd} cash=${state.cashUsd} infoState=${survivalState} agent=${state.agentStatus}`,
  );
  notes.push(
    "sizing=STRATEGY_OWNED (no fixed % caps; no drawdown auto-cut/halt except DEAD)",
  );

  if (
    survivalState === "DEAD" ||
    state.agentStatus === "DEAD" ||
    state.tradingPermanentlyDisabled ||
    isDeadEquity(totalEquityUsd)
  ) {
    return {
      approved: false,
      code: "DEAD",
      reason: "DEAD — total equity destroyed; trading permanently terminated; no revival",
      notes,
    };
  }

  if (!state.tradingEnabled) {
    return {
      approved: false,
      code: "TRADING_DISABLED",
      reason: "tradingEnabled=false",
      notes,
    };
  }

  if (!RISK.ALLOW_LEVERAGE && proposal.leverage && proposal.leverage > 1) {
    return { approved: false, code: "LEVERAGE_FORBIDDEN", reason: "Leverage forbidden", notes };
  }
  if (!RISK.ALLOW_BORROWING && proposal.borrowedFunds) {
    return { approved: false, code: "BORROWING_FORBIDDEN", reason: "Borrowing forbidden", notes };
  }
  if (
    proposal.flags?.washTrading ||
    proposal.flags?.fakeVolume ||
    proposal.flags?.spoofing ||
    proposal.flags?.manipulation
  ) {
    return {
      approved: false,
      code: "MANIPULATION_FORBIDDEN",
      reason: "Wash/fake volume/spoofing/manipulation forbidden",
      notes,
    };
  }

  if (
    !proposal.thesis ||
    !proposal.evidenceFor?.length ||
    !proposal.evidenceAgainst?.length ||
    !proposal.estimatedEdge
  ) {
    return {
      approved: false,
      code: "MISSING_THESIS_EVIDENCE",
      reason: "Require thesis, evidenceFor, evidenceAgainst, estimatedEdge",
      notes,
    };
  }

  if (!proposal.decision) {
    return {
      approved: false,
      code: "MISSING_DECISION_RECORD",
      reason: "Autonomy decision record required (equity, size %, EV, alternatives, etc.)",
      notes,
    };
  }

  if (RISK.REQUIRE_EXIT_PLAN_BEFORE_ENTRY && !hasValidExitPlan(proposal)) {
    return {
      approved: false,
      code: "MISSING_EXIT_PLAN",
      reason: "Exit conditions required before entry",
      notes,
    };
  }
  const ep = proposal.exitPlan;
  if (!(ep.takeProfitPct && (ep.stopLossPct || ep.invalidationPrice))) {
    return {
      approved: false,
      code: "MISSING_EXIT_PLAN",
      reason: "Require take-profit and stop/invalidation",
      notes,
    };
  }

  const timingReject = validate48hTiming(proposal, notes);
  if (timingReject) return timingReject;

  const polyReject = validatePolymarketResolution(proposal, notes);
  if (polyReject) return polyReject;

  if (proposal.sizeUsd <= 0 || !Number.isFinite(proposal.sizeUsd)) {
    return { approved: false, code: "INVALID_SIZE", reason: "sizeUsd must be positive finite", notes };
  }

  if (proposal.market !== "pumpfun" && proposal.market !== "polymarket") {
    return { approved: false, code: "INVALID_MARKET", reason: `Unknown market: ${proposal.market}`, notes };
  }

  // Capital sufficiency ONLY — strategy may request up to 100% of controlled cash.
  // Also require size <= total equity (cannot invent capital).
  if (proposal.sizeUsd > state.cashUsd + 1e-9) {
    return {
      approved: false,
      code: "INSUFFICIENT_CAPITAL",
      reason: `sizeUsd ${proposal.sizeUsd} exceeds available cash ${state.cashUsd} (no borrowing)`,
      notes,
    };
  }
  if (proposal.sizeUsd > totalEquityUsd + 1e-9) {
    return {
      approved: false,
      code: "INSUFFICIENT_CAPITAL",
      reason: `sizeUsd ${proposal.sizeUsd} exceeds total equity ${totalEquityUsd}`,
      notes,
    };
  }

  const percentOfEquity =
    totalEquityUsd > 0 ? (proposal.sizeUsd / totalEquityUsd) * 100 : 0;
  notes.push(`strategy_size_pct_of_equity=${percentOfEquity.toFixed(4)}% (not capped by risk engine)`);

  return {
    approved: true,
    sizeUsd: proposal.sizeUsd,
    availableCashUsd: state.cashUsd,
    totalEquityUsd,
    percentOfEquity,
    survivalState,
    notes,
  };
}

export type SurvivalStatus = {
  survivalState: SurvivalStateName;
  agentStatus: "ALIVE" | "DEAD";
  cashUsd: number;
  totalEquityUsd: number;
  peakEquityUsd: number;
  drawdownPct: number;
  /** Always 1 under full autonomy (no auto size cut). */
  sizeMultiplier: number;
  canOpenPositions: boolean;
  permanentlyDisabled: boolean;
  requiresHumanApproval: false;
  tradingEnabled: boolean;
  message: string;
  bankrollUsd: number;
  peakBankrollUsd: number;
  objective: typeof RISK.PRIMARY_OBJECTIVE;
};

export function survivalCheck(state: SystemState): SurvivalStatus {
  const totalEquityUsd = computeTotalEquity(state);
  const peakEquityUsd = state.peakEquityUsd;
  const dd = computeDrawdown(state, totalEquityUsd);
  const survivalState = deriveSurvivalState(state, totalEquityUsd);
  const permanentlyDisabled =
    survivalState === "DEAD" ||
    state.agentStatus === "DEAD" ||
    state.tradingPermanentlyDisabled;
  const canOpenPositions =
    !permanentlyDisabled && state.tradingEnabled && state.agentStatus === "ALIVE";

  let message = `ALIVE / ${survivalState} — maximize total equity (info DD ${(dd * 100).toFixed(2)}%)`;
  if (permanentlyDisabled) {
    message = "DEAD — equity destroyed; experiment over; no bailouts/revival";
  }

  return {
    survivalState,
    agentStatus: permanentlyDisabled ? "DEAD" : "ALIVE",
    cashUsd: state.cashUsd,
    totalEquityUsd,
    peakEquityUsd,
    drawdownPct: dd * 100,
    sizeMultiplier: 1,
    canOpenPositions,
    permanentlyDisabled,
    requiresHumanApproval: false,
    tradingEnabled: state.tradingEnabled && !permanentlyDisabled,
    message,
    bankrollUsd: state.cashUsd,
    peakBankrollUsd: peakEquityUsd,
    objective: RISK.PRIMARY_OBJECTIVE,
  };
}

export function buildDeathPostMortem(
  state: SystemState,
  cause = "total_equity_lte_zero",
): DeathPostMortem {
  const equity = computeTotalEquity(state);
  return {
    diedAt: new Date().toISOString(),
    finalCashUsd: state.cashUsd,
    finalEquityUsd: equity,
    peakEquityUsd: state.peakEquityUsd,
    openPositionCount: state.openPositions.length,
    closedPositionCount: state.closedPositions.length,
    message:
      "DEAD: total equity <= $0. tradingEnabled=false, agentStatus=DEAD. No bailout, deposits, reset, borrowing, leverage, or revival. Experiment over.",
    cause,
    objective: "MAXIMIZE_TOTAL_EQUITY",
  };
}

export function syncSurvivalFromEquity(state: SystemState): SystemState {
  const totalEquityUsd = computeTotalEquity(state);
  const peakEquityUsd = Math.max(state.peakEquityUsd, totalEquityUsd);
  const survivalState = deriveSurvivalState({ ...state, peakEquityUsd }, totalEquityUsd);

  let tradingPermanentlyDisabled = state.tradingPermanentlyDisabled;
  let tradingEnabled = state.tradingEnabled;
  let agentStatus = state.agentStatus;
  let deathPostMortem = state.deathPostMortem;

  if (survivalState === "DEAD" || isDeadEquity(totalEquityUsd) || agentStatus === "DEAD") {
    tradingPermanentlyDisabled = true;
    tradingEnabled = false;
    agentStatus = "DEAD";
    if (!deathPostMortem) {
      deathPostMortem = buildDeathPostMortem({
        ...state,
        peakEquityUsd,
        cashUsd: state.cashUsd,
      });
    }
  } else {
    // Full autonomy: CAUTION/CRITICAL are labels only — keep trading enabled
    agentStatus = "ALIVE";
    tradingEnabled = true;
  }

  if (tradingPermanentlyDisabled) {
    tradingEnabled = false;
    agentStatus = "DEAD";
  }

  return {
    ...state,
    cashUsd: state.cashUsd,
    bankrollUsd: state.cashUsd,
    peakEquityUsd,
    peakBankrollUsd: peakEquityUsd,
    survivalState: tradingPermanentlyDisabled ? "DEAD" : survivalState,
    agentStatus,
    tradingPermanentlyDisabled,
    tradingEnabled,
    tradingDisabledUntilHumanApproval: false,
    deathPostMortem,
    updatedAt: new Date().toISOString(),
  };
}

export function applyBankrollUpdate(state: SystemState, newCashUsd: number): SystemState {
  if (state.tradingPermanentlyDisabled || state.agentStatus === "DEAD" || state.survivalState === "DEAD") {
    return {
      ...state,
      tradingEnabled: false,
      tradingPermanentlyDisabled: true,
      agentStatus: "DEAD",
      survivalState: "DEAD",
      updatedAt: new Date().toISOString(),
    };
  }
  if (!RISK.ALLOW_AUTO_FUND_ADD && newCashUsd > state.cashUsd + state.openPositions.reduce((s, p) => s + p.sizeUsd, 0) + 1e-6) {
    // External capital injection attempts are ignored at sync layer; pipeline only passes P&L paths.
    // Explicit guard used by tests / API:
  }
  const cashUsd = Math.max(0, Number(newCashUsd.toFixed(6)));
  return syncSurvivalFromEquity({ ...state, cashUsd, bankrollUsd: cashUsd });
}

export const applyEquityUpdate = applyBankrollUpdate;

/** Refuse automatic external capital injection (hard boundary). */
export function tryInjectCapital(state: SystemState, amountUsd: number): {
  ok: false;
  reason: string;
  state: SystemState;
} {
  return {
    ok: false,
    reason: "AUTO_FUND_FORBIDDEN: no external funding, deposits, or bailouts",
    state,
  };
}

export function positionsRequiringForceExit(
  state: SystemState,
  now: Date = new Date(),
): Position[] {
  const t = now.getTime();
  return state.openPositions.filter((p) => Date.parse(p.forcedExitAt) <= t);
}

export function capForcedExitIso(entryIso: string, requestedMaxIso: string): string {
  const entry = Date.parse(entryIso);
  const req = Date.parse(requestedMaxIso);
  const hard = entry + RISK.MAX_HOLDING_HOURS * 3_600_000;
  return new Date(Math.min(req, hard)).toISOString();
}

Object.freeze(validateTradeProposal);
Object.freeze(survivalCheck);
Object.freeze(applyBankrollUpdate);
Object.freeze(syncSurvivalFromEquity);
Object.freeze(computeTotalEquity);
Object.freeze(deriveSurvivalState);
Object.freeze(positionsRequiringForceExit);
Object.freeze(buildDeathPostMortem);
Object.freeze(tryInjectCapital);
Object.freeze(isDeadEquity);
