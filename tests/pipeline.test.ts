import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { StateStore } from "../src/state/store.js";
import { TradeLogger } from "../src/logging/logger.js";
import { TradingPipeline } from "../src/pipeline/execute.js";
import { proposeFromResearch } from "../src/pipeline/propose.js";
import { scorePumpCoin } from "../src/research/scorer.js";
import { PUMPFUN_FIXTURES } from "../src/markets/pumpfun/fixtures.js";
import { computeTotalEquity } from "../src/risk/engine.js";

const TMP = path.join(process.cwd(), "data", "test-run");

describe("TradingPipeline sim", () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(path.join(TMP, "logs"), { recursive: true });
    fs.mkdirSync(path.join(TMP, "state"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("approves strategy-chosen size; equity ≈ prior - fees", () => {
    const store = new StateStore(path.join(TMP, "state"));
    store.forceWipeForLab();
    store.reset();
    const pipeline = new TradingPipeline(store, new TradeLogger(path.join(TMP, "logs")));
    const before = store.load();
    const equityBefore = computeTotalEquity(before);
    const research = scorePumpCoin(PUMPFUN_FIXTURES[0]!);
    const proposal = proposeFromResearch(research, before, {
      strategy: "autonomous_balanced_v1",
      sizeUsd: 12.5, // strategy picks 12.5% — risk engine does not cap
    });
    expect(proposal.decision.percentOfEquityRisked).toBeCloseTo(12.5, 5);
    const result = pipeline.processProposal(proposal);
    expect(result.status).toBe("approved");
    const state = store.load();
    expect(state.openPositions.length).toBe(1);
    expect(computeTotalEquity(state)).toBeGreaterThan(equityBefore - 1);
  });

  it("markUnrealized + forceExitExpired with marks realize non-zero PnL", () => {
    const store = new StateStore(path.join(TMP, "state"));
    store.forceWipeForLab();
    store.reset();
    const pipeline = new TradingPipeline(store, new TradeLogger(path.join(TMP, "logs")));

    const entry = new Date("2026-01-01T00:00:00.000Z");
    const research = scorePumpCoin(PUMPFUN_FIXTURES[0]!);
    const before = store.load();
    const proposal = proposeFromResearch(research, before, {
      strategy: "test_mtm",
      sizeUsd: 20,
      now: entry,
      expectedHoldingHours: 24,
      maximumHoldingHours: 48,
    });
    expect(proposal.entryPrice).toBe(PUMPFUN_FIXTURES[0]!.priceUsd);
    const opened = pipeline.processProposal(proposal);
    expect(opened.status).toBe("approved");
    if (opened.status !== "approved") return;

    const mint = opened.position.instrument;
    const entryPx = opened.position.entryPrice;
    expect(entryPx).toBeGreaterThan(0);

    // Mark 50% higher → unrealized should move
    const markPx = entryPx * 1.5;
    const marked = pipeline.markUnrealized({ [mint]: markPx });
    const pos = marked.openPositions.find((p) => p.id === opened.position.id)!;
    expect(pos.unrealizedPnlUsd).toBeCloseTo(20 * 0.5, 4);
    expect(pos.currentMarketValueUsd).toBeCloseTo(30, 4);
    expect(computeTotalEquity(marked)).toBeGreaterThan(90);

    // Force-exit at mark → realized PnL non-zero (not flat at entry)
    const { closed } = pipeline.forceExitExpired(
      new Date(entry.getTime() + 48 * 3_600_000),
      { [mint]: markPx },
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitPrice).toBe(markPx);
    expect(closed[0]!.realizedPnlUsd).toBeCloseTo(10, 4);
    expect(closed[0]!.realizedPnlUsd).not.toBe(0);
  });

  it("proposeFromResearch omits fake pump entry when priceUsd missing", () => {
    const store = new StateStore(path.join(TMP, "state"));
    store.forceWipeForLab();
    store.reset();
    const research = scorePumpCoin(PUMPFUN_FIXTURES[0]!);
    const raw = { ...(research.raw ?? {}) };
    delete raw.priceUsd;
    const proposal = proposeFromResearch(
      { ...research, raw },
      store.load(),
      { strategy: "test_no_fake", sizeUsd: 5 },
    );
    expect(proposal.entryPrice).toBeUndefined();
  });
});
