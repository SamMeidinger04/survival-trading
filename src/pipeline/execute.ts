import { randomUUID } from "node:crypto";
import {
  validateTradeProposal,
  syncSurvivalFromEquity,
  survivalCheck,
  computeTotalEquity,
  positionsRequiringForceExit,
  buildDeathPostMortem,
  capForcedExitIso,
  type RiskDecision,
} from "../risk/engine.js";
import { RISK } from "../risk/constants.js";
import type { TradeProposal, SimulatedFill } from "../schemas/trade.js";
import type { Position, SystemState, ClosedPosition } from "../schemas/state.js";
import { TradeLogger, computePerformance } from "../logging/logger.js";
import { writeDeathPostMortem } from "../logging/postmortem.js";
import { StateStore } from "../state/store.js";

export type PipelineResult =
  | {
      status: "approved";
      proposal: TradeProposal;
      decision: Extract<RiskDecision, { approved: true }>;
      fill: SimulatedFill;
      position: Position;
      state: SystemState;
    }
  | {
      status: "rejected";
      proposal: TradeProposal;
      decision: Extract<RiskDecision, { approved: false }>;
      state: SystemState;
    };

export class TradingPipeline {
  constructor(
    private readonly store: StateStore,
    private readonly logger: TradeLogger,
  ) {}

  /** Full path: propose → validate → sim fill → log → equity sync → survival. */
  processProposal(proposal: TradeProposal): PipelineResult {
    let state = this.store.load();
    this.logger.logProposed(proposal);

    if (state.tradingPermanentlyDisabled || state.survivalState === "DEAD" || state.agentStatus === "DEAD") {
      const decision: Extract<RiskDecision, { approved: false }> = {
        approved: false,
        code: "DEAD",
        reason: "DEAD — no new proposals; agentStatus=DEAD",
        notes: [],
      };
      this.logger.logRejected({ proposal, decision });
      return { status: "rejected", proposal, decision, state };
    }

    const decision = validateTradeProposal(proposal, state);
    if (!decision.approved) {
      this.logger.logRejected({ proposal, decision });
      this.persistMetrics(state);
      return { status: "rejected", proposal, decision, state };
    }

    const fillAt = proposal.timing.entryTimestamp;
    const fill: SimulatedFill = {
      proposalId: proposal.id,
      fillId: randomUUID(),
      filledAt: fillAt,
      fillPrice: proposal.entryPrice ?? 0,
      sizeUsd: proposal.sizeUsd,
      feesUsd: Number((proposal.sizeUsd * 0.001).toFixed(6)),
      simulated: true,
      notes: "Paper/sim fill — no on-chain or CLOB order sent",
    };

    const forcedExitAt = capForcedExitIso(
      fillAt,
      proposal.timing.maximumExitTimestamp,
    );

    const position: Position = {
      id: randomUUID(),
      proposalId: proposal.id,
      market: proposal.market,
      strategy: proposal.strategy,
      side: proposal.side,
      instrument: proposal.instrument,
      instrumentName: proposal.instrumentName,
      sizeUsd: proposal.sizeUsd,
      entryPrice: fill.fillPrice,
      // Opening is NOT a loss: MV starts at size (fees reduce equity separately)
      currentMarketValueUsd: proposal.sizeUsd,
      openedAt: fill.filledAt,
      forcedExitAt,
      maximumHoldingHours: Math.min(
        proposal.timing.maximumHoldingHours,
        RISK.MAX_HOLDING_HOURS,
      ),
      timing: proposal.timing,
      thesis: proposal.thesis,
      evidenceFor: proposal.evidenceFor,
      evidenceAgainst: proposal.evidenceAgainst,
      estimatedEdge: proposal.estimatedEdge,
      decision: proposal.decision,
      exitPlan: proposal.exitPlan,
      unrealizedPnlUsd: 0,
      status: "open",
      resolutionDeadline: proposal.resolutionDeadline,
      officialResolutionSource: proposal.officialResolutionSource,
      metadata: { fillId: fill.fillId, feesUsd: fill.feesUsd, ...(proposal.metadata ?? {}) },
    };

    // Cash ↓ by size+fees; position MV = size → equity ↓ by fees only
    const newCash = Number((state.cashUsd - proposal.sizeUsd - fill.feesUsd).toFixed(6));
    let next = syncSurvivalFromEquity({
      ...state,
      cashUsd: Math.max(0, newCash),
      bankrollUsd: Math.max(0, newCash),
      openPositions: [...state.openPositions, position],
    });

    if (next.survivalState === "DEAD" && next.deathPostMortem) {
      writeDeathPostMortem(next.deathPostMortem, next, this.logger.logDir);
    }

    this.logger.logApproved({ proposal, decision, fill, position });
    this.logger.logOpenPositions(next.openPositions);
    this.persistMetrics(next);
    this.store.save(next);

    return {
      status: "approved",
      proposal,
      decision,
      fill,
      position,
      state: next,
    };
  }

  closePosition(
    positionId: string,
    exitPrice: number,
    closeReason: string,
    closedAt?: string,
  ): { state: SystemState; closed: ClosedPosition } {
    const state = this.store.load();
    const idx = state.openPositions.findIndex((p) => p.id === positionId);
    if (idx < 0) throw new Error(`Position not found: ${positionId}`);

    const open = state.openPositions[idx]!;
    const pnlPct =
      open.entryPrice > 0 ? (exitPrice - open.entryPrice) / open.entryPrice : 0;
    let realizedPnlUsd: number;
    if (open.market === "polymarket") {
      realizedPnlUsd = Number(
        (
          open.sizeUsd *
          ((exitPrice - open.entryPrice) / Math.max(open.entryPrice, 0.01))
        ).toFixed(4),
      );
    } else {
      realizedPnlUsd = Number((open.sizeUsd * pnlPct).toFixed(4));
    }

    const closed: ClosedPosition = {
      ...open,
      status: "closed",
      closedAt: closedAt ?? new Date().toISOString(),
      exitPrice,
      realizedPnlUsd,
      closeReason,
      unrealizedPnlUsd: 0,
      currentMarketValueUsd: 0,
    };

    const openPositions = state.openPositions.filter((p) => p.id !== positionId);
    // Return cost basis + realized PnL to cash
    const returnedCapital = open.sizeUsd + realizedPnlUsd;
    const newCash = Number((state.cashUsd + returnedCapital).toFixed(6));

    let next = syncSurvivalFromEquity({
      ...state,
      cashUsd: Math.max(0, newCash),
      bankrollUsd: Math.max(0, newCash),
      openPositions,
      closedPositions: [...state.closedPositions, closed],
      lastLossSizeUsd: realizedPnlUsd < 0 ? open.sizeUsd : state.lastLossSizeUsd,
    });

    if (next.survivalState === "DEAD") {
      if (!next.deathPostMortem) {
        next = {
          ...next,
          deathPostMortem: buildDeathPostMortem(next),
          tradingEnabled: false,
          tradingPermanentlyDisabled: true,
          agentStatus: "DEAD",
          survivalState: "DEAD",
        };
      }
      writeDeathPostMortem(next.deathPostMortem!, next, this.logger.logDir);
    }

    this.logger.logClosedPosition(closed);
    this.logger.logRealizedPnl({
      positionId: closed.id,
      market: closed.market,
      strategy: closed.strategy,
      realizedPnlUsd,
      closeReason,
    });
    this.logger.logOpenPositions(openPositions);
    this.persistMetrics(next);
    this.store.save(next);
    return { state: next, closed };
  }

  /**
   * Force-close any open position at/past forcedExitAt (hard ≤48h rule).
   * Exit price defaults to entry (flat) unless marks provided.
   */
  forceExitExpired(
    now: Date = new Date(),
    marks: Record<string, number> = {},
  ): { closed: ClosedPosition[]; state: SystemState } {
    let state = this.store.load();
    const due = positionsRequiringForceExit(state, now);
    const closed: ClosedPosition[] = [];
    for (const p of due) {
      // reload each time
      state = this.store.load();
      if (!state.openPositions.some((x) => x.id === p.id)) continue;
      const px = marks[p.instrument] ?? p.entryPrice;
      const result = this.closePosition(
        p.id,
        px,
        `FORCE_EXIT_48H: forcedExitAt=${p.forcedExitAt}`,
        now.toISOString(),
      );
      closed.push(result.closed);
      state = result.state;
    }
    return { closed, state };
  }

  markUnrealized(marks: Record<string, number>): SystemState {
    const state = this.store.load();
    const openPositions = state.openPositions.map((p) => {
      const px = marks[p.instrument];
      if (px === undefined) return p;
      const pnlPct = p.entryPrice > 0 ? (px - p.entryPrice) / p.entryPrice : 0;
      const unrealizedPnlUsd = Number((p.sizeUsd * pnlPct).toFixed(4));
      const currentMarketValueUsd = Number((p.sizeUsd + unrealizedPnlUsd).toFixed(6));
      return { ...p, unrealizedPnlUsd, currentMarketValueUsd };
    });
    let next = syncSurvivalFromEquity({
      ...state,
      openPositions,
    });

    if (next.survivalState === "DEAD" && next.deathPostMortem) {
      writeDeathPostMortem(next.deathPostMortem, next, this.logger.logDir);
    }

    this.logger.logUnrealizedPnl({
      at: next.updatedAt,
      positions: openPositions.map((p) => ({
        id: p.id,
        instrument: p.instrument,
        unrealizedPnlUsd: p.unrealizedPnlUsd,
        currentMarketValueUsd: p.currentMarketValueUsd,
      })),
    });
    this.logger.logOpenPositions(openPositions);
    this.persistMetrics(next);
    this.store.save(next);
    return next;
  }

  private persistMetrics(state: SystemState): void {
    const survival = survivalCheck(state);
    const perf = computePerformance(state);
    const equity = computeTotalEquity(state);
    this.logger.logBankroll({
      cashUsd: state.cashUsd,
      bankrollUsd: state.cashUsd,
      totalEquityUsd: equity,
      peakEquityUsd: state.peakEquityUsd,
      peakBankrollUsd: state.peakEquityUsd,
      drawdownPct: survival.drawdownPct,
      survivalState: state.survivalState,
    });
    this.logger.logSurvival(survival);
    this.logger.logPerformance({
      ...perf,
      cashUsd: state.cashUsd,
      totalEquityUsd: equity,
      peakEquityUsd: state.peakEquityUsd,
      openCount: state.openPositions.length,
      survivalState: state.survivalState,
    });
  }
}
