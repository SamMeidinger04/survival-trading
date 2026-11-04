import { describe, it, expect, beforeEach } from "vitest";
import { RISK } from "../src/risk/constants.js";
import {
  validateTradeProposal,
  survivalCheck,
  applyBankrollUpdate,
  syncSurvivalFromEquity,
  computeTotalEquity,
} from "../src/risk/engine.js";
import { seedState } from "../src/state/store.js";
import type { SystemState } from "../src/schemas/state.js";
import { baseProposal, makeDecision, hoursFromNow, openPos } from "./helpers.js";

describe("RISK immutability (hard boundaries)", () => {
  it("refuses mutation", () => {
    expect(() => {
      // @ts-expect-error
      RISK.STARTING_CASH_USD = 999;
    }).toThrow(/RISK_IMMUTABLE/);
    expect(() => {
      // @ts-expect-error
      RISK.KILL_EQUITY_USD = -1;
    }).toThrow(/RISK_IMMUTABLE/);
    expect(() => {
      // @ts-expect-error
      RISK.MAX_HOLDING_HOURS = 999;
    }).toThrow(/RISK_IMMUTABLE/);
  });

  it("has full-autonomy hard boundaries only", () => {
    expect(RISK.STARTING_CASH_USD).toBe(100);
    expect(RISK.MAX_HOLDING_HOURS).toBe(48);
    expect(RISK.KILL_EQUITY_USD).toBe(0);
    expect(RISK.ALLOW_LEVERAGE).toBe(false);
    expect(RISK.ALLOW_BORROWING).toBe(false);
    expect(RISK.ALLOW_AUTO_FUND_ADD).toBe(false);
    expect(RISK.HAS_FIXED_POSITION_PCT_CAPS).toBe(false);
    expect(RISK.PRIMARY_OBJECTIVE).toBe("MAXIMIZE_TOTAL_EQUITY");
  });
});

describe("validateTradeProposal (hard boundaries)", () => {
  let state: SystemState;
  beforeEach(() => {
    state = seedState();
  });

  it("approves any fundable size including large concentration", () => {
    expect(validateTradeProposal(baseProposal({ sizeUsd: 2, decision: makeDecision(2) }), state).approved).toBe(true);
    expect(validateTradeProposal(baseProposal({ sizeUsd: 80, decision: makeDecision(80) }), state).approved).toBe(true);
  });

  it("rejects insufficient capital", () => {
    const d = validateTradeProposal(baseProposal({ sizeUsd: 101, decision: makeDecision(101) }), state);
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.code).toBe("INSUFFICIENT_CAPITAL");
  });

  it("allows polymarket when resolution ≤48h at any fundable size", () => {
    const now = new Date();
    const d = validateTradeProposal(
      baseProposal({
        market: "polymarket",
        side: "yes",
        sizeUsd: 40,
        decision: makeDecision(40),
        resolutionDeadline: hoursFromNow(24, now),
        officialResolutionSource: "Polymarket official",
        timing: {
          entryTimestamp: now.toISOString(),
          expectedHoldingHours: 12,
          maximumHoldingHours: 24,
          expectedExitTimestamp: hoursFromNow(12, now),
          maximumExitTimestamp: hoursFromNow(24, now),
          reasonMaterializesWithin48h: "Resolves in 24h",
        },
      }),
      state,
    );
    expect(d.approved).toBe(true);
  });

  it("rejects missing exit plan / manipulation / leverage / borrowing", () => {
    expect(
      validateTradeProposal(baseProposal({ exitPlan: { rationale: "none" } }), state).approved,
    ).toBe(false);
    expect(validateTradeProposal(baseProposal({ leverage: 2 }), state).approved).toBe(false);
    expect(validateTradeProposal(baseProposal({ borrowedFunds: true }), state).approved).toBe(false);
    expect(
      validateTradeProposal(baseProposal({ flags: { washTrading: true } }), state).approved,
    ).toBe(false);
  });

  it("opening a position is not treated as equity loss beyond fees", () => {
    const withPos = syncSurvivalFromEquity({
      ...state,
      cashUsd: 98,
      bankrollUsd: 98,
      openPositions: [openPos("1", { sizeUsd: 2, currentMarketValueUsd: 2 })],
      peakEquityUsd: 100,
      peakBankrollUsd: 100,
    });
    expect(computeTotalEquity(withPos)).toBeCloseTo(100, 5);
    expect(withPos.agentStatus).toBe("ALIVE");
  });

  it("info CRITICAL label does not halt trading", () => {
    state = syncSurvivalFromEquity({
      ...state,
      cashUsd: 55,
      bankrollUsd: 55,
      peakEquityUsd: 100,
      openPositions: [],
    });
    expect(state.survivalState).toBe("CRITICAL");
    expect(state.tradingEnabled).toBe(true);
    expect(
      validateTradeProposal(baseProposal({ sizeUsd: 20, decision: makeDecision(20, 55) }), state)
        .approved,
    ).toBe(true);
  });
});

describe("death / survivalCheck", () => {
  it("DEAD at $0; no revival", () => {
    let state = applyBankrollUpdate(seedState(), 0);
    expect(state.agentStatus).toBe("DEAD");
    expect(survivalCheck(state).permanentlyDisabled).toBe(true);
    expect(applyBankrollUpdate(state, 50).agentStatus).toBe("DEAD");
  });

  it("sizeMultiplier stays 1 under drawdown (no auto cut)", () => {
    let state = applyBankrollUpdate(seedState(), 70);
    expect(state.survivalState).toBe("CAUTION");
    expect(survivalCheck(state).sizeMultiplier).toBe(1);
    expect(survivalCheck(state).requiresHumanApproval).toBe(false);
  });
});
