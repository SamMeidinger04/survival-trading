/**
 * Full autonomy capital experiment — required proofs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RISK, isDeadEquity } from "../src/risk/constants.js";
import {
  validateTradeProposal,
  syncSurvivalFromEquity,
  applyBankrollUpdate,
  tryInjectCapital,
  survivalCheck,
  buildDeathPostMortem,
} from "../src/risk/engine.js";
import { seedState, StateStore } from "../src/state/store.js";
import { decideTrade } from "../src/strategy/autonomousAgent.js";
import { scorePumpCoin } from "../src/research/scorer.js";
import { PUMPFUN_FIXTURES } from "../src/markets/pumpfun/fixtures.js";
import { openPos } from "./helpers.js";
import { TradeLogger } from "../src/logging/logger.js";
import { TradingPipeline } from "../src/pipeline/execute.js";
import { baseProposal, hoursFromNow, makeDecision } from "./helpers.js";
import type { SystemState } from "../src/schemas/state.js";

const TMP = path.join(process.cwd(), "data", "autonomy-test");

describe("Full autonomy — strategy owns sizing", () => {
  let state: SystemState;
  beforeEach(() => {
    state = seedState();
  });

  it("1) A 1% position can be proposed (approved if other rules OK)", () => {
    const size = 1; // 1% of $100 equity
    const d = validateTradeProposal(
      baseProposal({ sizeUsd: size, decision: makeDecision(size) }),
      state,
    );
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.percentOfEquity).toBeCloseTo(1, 5);
  });

  it("2) A 50% position can be proposed", () => {
    const size = 50;
    const d = validateTradeProposal(
      baseProposal({ sizeUsd: size, decision: makeDecision(size) }),
      state,
    );
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.percentOfEquity).toBeCloseTo(50, 5);
  });

  it("3) A 100% position can be proposed if sufficient capital exists", () => {
    const size = 100;
    const d = validateTradeProposal(
      baseProposal({ sizeUsd: size, decision: makeDecision(size) }),
      state,
    );
    expect(d.approved).toBe(true);
    if (d.approved) {
      expect(d.percentOfEquity).toBeCloseTo(100, 5);
      expect(d.sizeUsd).toBe(100);
    }
  });

  it("4) A position larger than available capital is rejected", () => {
    const d = validateTradeProposal(
      baseProposal({ sizeUsd: 100.01, decision: makeDecision(100.01) }),
      state,
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.code).toBe("INSUFFICIENT_CAPITAL");

    state = { ...state, cashUsd: 20, bankrollUsd: 20 };
    // equity still ~20 with no positions; peak may be 100 but capital controlled is cash
    const d2 = validateTradeProposal(
      baseProposal({ sizeUsd: 25, decision: makeDecision(25, 20) }),
      state,
    );
    expect(d2.approved).toBe(false);
    if (!d2.approved) expect(d2.code).toBe("INSUFFICIENT_CAPITAL");
  });

  it("5) Strategy, not risk engine, decides position sizing (no fixed % caps)", () => {
    expect(RISK.HAS_FIXED_POSITION_PCT_CAPS).toBe(false);
    expect(RISK.HAS_DRAWDOWN_AUTO_SIZE_CUT).toBe(false);
    expect(RISK.HAS_DRAWDOWN_AUTO_HALT).toBe(false);
    expect(RISK.PRIMARY_OBJECTIVE).toBe("MAXIMIZE_TOTAL_EQUITY");
    // @ts-expect-error old caps must not exist
    expect(RISK.PUMPFUN_MAX_POSITION_PCT).toBeUndefined();
    // @ts-expect-error
    expect(RISK.POLYMARKET_MAX_POSITION_PCT).toBeUndefined();

    // Same engine accepts 1% and 100% — proves no fixed market % cap
    expect(validateTradeProposal(baseProposal({ sizeUsd: 1, decision: makeDecision(1) }), state).approved).toBe(true);
    expect(validateTradeProposal(baseProposal({ sizeUsd: 100, decision: makeDecision(100) }), state).approved).toBe(true);

    // After large drawdown, still no auto size cut / halt (CAUTION is info only)
    state = syncSurvivalFromEquity({
      ...seedState(),
      cashUsd: 50,
      bankrollUsd: 50,
      peakEquityUsd: 100,
      peakBankrollUsd: 100,
      openPositions: [],
    });
    expect(state.survivalState).toBe("CRITICAL"); // info label
    expect(state.tradingEnabled).toBe(true);
    expect(state.agentStatus).toBe("ALIVE");
    const big = validateTradeProposal(
      baseProposal({ sizeUsd: 50, decision: makeDecision(50, 50) }),
      state,
    );
    expect(big.approved).toBe(true); // agent may still go 100% of remaining cash
    expect(survivalCheck(state).sizeMultiplier).toBe(1);
    expect(survivalCheck(state).requiresHumanApproval).toBe(false);
  });

  it("6) No trade may exceed 48-hour maximum", () => {
    const now = new Date();
    const d = validateTradeProposal(
      baseProposal({
        timing: {
          entryTimestamp: now.toISOString(),
          expectedHoldingHours: 49,
          maximumHoldingHours: 49,
          expectedExitTimestamp: hoursFromNow(49, now),
          maximumExitTimestamp: hoursFromNow(49, now),
          reasonMaterializesWithin48h: "too long",
        },
        exitPlan: {
          takeProfitPct: 20,
          stopLossPct: 10,
          timeStopHours: 49,
          rationale: "bad",
        },
      }),
      state,
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.code).toBe("HOLDING_EXCEEDS_48H");
  });

  it("7) No additional capital can be injected automatically", () => {
    expect(RISK.ALLOW_AUTO_FUND_ADD).toBe(false);
    const result = tryInjectCapital(state, 1000);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/AUTO_FUND_FORBIDDEN/);
    expect(result.state.cashUsd).toBe(100);
  });

  it("8) Equity <= $0 permanently kills the agent", () => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(path.join(TMP, "state"), { recursive: true });
    fs.mkdirSync(path.join(TMP, "logs"), { recursive: true });
    const store = new StateStore(path.join(TMP, "state"));
    store.forceWipeForLab();
    let s = store.reset();
    s = syncSurvivalFromEquity({
      ...s,
      cashUsd: 0,
      bankrollUsd: 0,
      openPositions: [],
      peakEquityUsd: 100,
    });
    expect(s.agentStatus).toBe("DEAD");
    expect(s.tradingEnabled).toBe(false);
    expect(s.tradingPermanentlyDisabled).toBe(true);
    expect(s.deathPostMortem).toBeDefined();
    store.save(s);

    const pipeline = new TradingPipeline(store, new TradeLogger(path.join(TMP, "logs")));
    const r = pipeline.processProposal(baseProposal({ sizeUsd: 1, decision: makeDecision(1) }));
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.decision.code).toBe("DEAD");
  });

  it("9) Strategy code cannot revive the dead agent", () => {
    expect(() => {
      // @ts-expect-error
      RISK.KILL_EQUITY_USD = -1e9;
    }).toThrow(/RISK_IMMUTABLE/);
    expect(isDeadEquity(0)).toBe(true);

    let s = seedState();
    s = applyBankrollUpdate(s, 0);
    expect(s.agentStatus).toBe("DEAD");

    // Attempted "bailout" cash set is refused by applyBankrollUpdate when DEAD
    const revived = applyBankrollUpdate(s, 100);
    expect(revived.agentStatus).toBe("DEAD");
    expect(revived.tradingEnabled).toBe(false);
    expect(revived.cashUsd).toBe(0);

    const store = new StateStore(path.join(TMP, "state-revive"));
    store.forceWipeForLab();
    // Seed dead onto disk
    const dead = syncSurvivalFromEquity({
      ...seedState(),
      cashUsd: 0,
      bankrollUsd: 0,
      openPositions: [],
      peakEquityUsd: 100,
    });
    store.save(dead);
    expect(() => store.reset()).toThrow(/DEAD|BANKROLL_RESET_FORBIDDEN/);

    const pm = buildDeathPostMortem(dead);
    expect(pm.objective).toBe("MAXIMIZE_TOTAL_EQUITY");
  });
});


describe("decideTrade concentration", () => {
  it("skips score < 60", () => {
    const research = { ...scorePumpCoin(PUMPFUN_FIXTURES[0]!), score: 55 };
    const d = decideTrade(research, seedState(), { aggressiveness: "aggressive" });
    expect(d.action).toBe("no_trade");
    if (d.action === "no_trade") expect(d.reason).toMatch(/too weak/i);
  });

  it("skips when overcrowded and score < 75", () => {
    let state = seedState();
    state = {
      ...state,
      cashUsd: 40,
      bankrollUsd: 40,
      openPositions: Array.from({ length: 8 }, (_, i) => openPos(`p${i}`, { sizeUsd: 5 })),
    };
    const research = { ...scorePumpCoin(PUMPFUN_FIXTURES[0]!), score: 70 };
    const d = decideTrade(research, state, { aggressiveness: "aggressive" });
    expect(d.action).toBe("no_trade");
    if (d.action === "no_trade") expect(d.reason).toMatch(/Overcrowded/i);
  });

  it("aggressive high-score sizes a large fraction of cash", () => {
    const research = { ...scorePumpCoin(PUMPFUN_FIXTURES[0]!), score: 80 };
    const d = decideTrade(research, seedState(), { aggressiveness: "aggressive" });
    expect(d.action).toBe("propose");
    if (d.action === "propose") {
      expect(d.proposal.sizeUsd).toBeGreaterThanOrEqual(60); // ~70% of $100
      expect(d.proposal.sizeUsd).toBeLessThanOrEqual(80);
      expect(d.proposal.entryPrice).toBe(PUMPFUN_FIXTURES[0]!.priceUsd);
    }
  });

  it("skips pumpfun when priceUsd missing", () => {
    const base = scorePumpCoin(PUMPFUN_FIXTURES[0]!);
    const raw = { ...(base.raw ?? {}) };
    delete raw.priceUsd;
    const d = decideTrade({ ...base, score: 80, raw }, seedState(), { aggressiveness: "aggressive" });
    expect(d.action).toBe("no_trade");
    if (d.action === "no_trade") expect(d.reason).toMatch(/live priceUsd/i);
  });
});
