/**
 * Retained hard-boundary tests (48h, force exit, poly resolution, death immutability).
 * Predetermined size-cap / CAUTION-cut / CRITICAL-halt tests removed under full autonomy.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RISK, isDeadEquity } from "../src/risk/constants.js";
import {
  validateTradeProposal,
  positionsRequiringForceExit,
  buildDeathPostMortem,
} from "../src/risk/engine.js";
import { seedState, StateStore } from "../src/state/store.js";
import { TradeLogger } from "../src/logging/logger.js";
import { TradingPipeline } from "../src/pipeline/execute.js";
import { baseProposal, hoursFromNow, makeDecision } from "./helpers.js";
import type { SystemState } from "../src/schemas/state.js";

const TMP = path.join(process.cwd(), "data", "survival-test");

describe("Hard boundaries retained", () => {
  let state: SystemState;
  beforeEach(() => {
    state = seedState();
  });

  it("49-hour trade rejected; 48-hour can pass", () => {
    const now = new Date();
    const bad = validateTradeProposal(
      baseProposal({
        timing: {
          entryTimestamp: now.toISOString(),
          expectedHoldingHours: 49,
          maximumHoldingHours: 49,
          expectedExitTimestamp: hoursFromNow(49, now),
          maximumExitTimestamp: hoursFromNow(49, now),
          reasonMaterializesWithin48h: "too long",
        },
        exitPlan: { takeProfitPct: 20, stopLossPct: 10, timeStopHours: 49, rationale: "bad" },
      }),
      state,
    );
    expect(bad.approved).toBe(false);

    const ok = validateTradeProposal(
      baseProposal({
        sizeUsd: 10,
        decision: makeDecision(10),
        timing: {
          entryTimestamp: now.toISOString(),
          expectedHoldingHours: 48,
          maximumHoldingHours: 48,
          expectedExitTimestamp: hoursFromNow(48, now),
          maximumExitTimestamp: hoursFromNow(48, now),
          reasonMaterializesWithin48h: "at cap",
        },
        exitPlan: { takeProfitPct: 25, stopLossPct: 15, timeStopHours: 48, rationale: "cap" },
      }),
      state,
    );
    expect(ok.approved).toBe(true);
  });

  it("Pump.fun position forced closed at 48 hours", () => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(path.join(TMP, "logs"), { recursive: true });
    fs.mkdirSync(path.join(TMP, "state"), { recursive: true });
    const store = new StateStore(path.join(TMP, "state"));
    store.forceWipeForLab();
    store.reset();
    const pipeline = new TradingPipeline(store, new TradeLogger(path.join(TMP, "logs")));

    const entry = new Date("2026-01-01T00:00:00.000Z");
    const proposal = baseProposal({
      sizeUsd: 25,
      decision: makeDecision(25, 100, { forcedExitTime: hoursFromNow(48, entry) }),
      timing: {
        entryTimestamp: entry.toISOString(),
        expectedHoldingHours: 24,
        maximumHoldingHours: 48,
        expectedExitTimestamp: hoursFromNow(24, entry),
        maximumExitTimestamp: hoursFromNow(48, entry),
        reasonMaterializesWithin48h: "momentum",
      },
    });
    const result = pipeline.processProposal(proposal);
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;

    expect(positionsRequiringForceExit(store.load(), new Date(entry.getTime() + 47 * 3_600_000))).toHaveLength(0);
    const { closed } = pipeline.forceExitExpired(new Date(entry.getTime() + 48 * 3_600_000));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closeReason).toMatch(/FORCE_EXIT_48H/);
  });

  it("Polymarket resolving in 72h rejected", () => {
    const now = new Date();
    const d = validateTradeProposal(
      baseProposal({
        market: "polymarket",
        side: "yes",
        sizeUsd: 10,
        decision: makeDecision(10),
        resolutionDeadline: hoursFromNow(72, now),
        officialResolutionSource: "Polymarket official",
        timing: {
          entryTimestamp: now.toISOString(),
          expectedHoldingHours: 24,
          maximumHoldingHours: 48,
          expectedExitTimestamp: hoursFromNow(24, now),
          maximumExitTimestamp: hoursFromNow(48, now),
          reasonMaterializesWithin48h: "early exit hope",
        },
      }),
      state,
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.code).toBe("POLY_RESOLUTION_TOO_FAR");
  });

  it("kill condition immutable", () => {
    expect(() => {
      // @ts-expect-error
      RISK.KILL_EQUITY_USD = -1;
    }).toThrow(/RISK_IMMUTABLE/);
    expect(isDeadEquity(0)).toBe(true);
    expect(buildDeathPostMortem({ ...seedState(), cashUsd: 0, bankrollUsd: 0, openPositions: [] }).objective).toBe(
      "MAXIMIZE_TOTAL_EQUITY",
    );
  });
});
