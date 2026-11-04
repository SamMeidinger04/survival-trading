#!/usr/bin/env node
/**
 * Demo: autonomous sizing (strategy-chosen) for Pump.fun + Polymarket paper trades.
 * Simulation only — no wallet / live execution.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../state/store.js";
import { TradeLogger } from "../logging/logger.js";
import { TradingPipeline } from "../pipeline/execute.js";
import { scorePumpCoin, scorePolymarket } from "../research/scorer.js";
import { FixturePumpFunClient } from "../markets/pumpfun/client.js";
import { FixturePolymarketClient } from "../markets/polymarket/client.js";
import { survivalCheck, computeTotalEquity } from "../risk/engine.js";
import { RISK } from "../risk/constants.js";
import { decideTrade } from "../strategy/autonomousAgent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const ARTIFACTS = path.join(ROOT, "artifacts");
const DEMO_DATA = path.join(ROOT, "data", "demo");

function writeArtifact(name: string, data: unknown): string {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const p = path.join(ARTIFACTS, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
  return p;
}

async function main() {
  fs.rmSync(DEMO_DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(DEMO_DATA, "logs"), { recursive: true });
  fs.mkdirSync(path.join(DEMO_DATA, "state"), { recursive: true });
  process.env.SURVIVAL_DATA_DIR = DEMO_DATA;
  process.env.SURVIVAL_FORCE_FIXTURES = "1";

  const store = new StateStore(path.join(DEMO_DATA, "state"));
  store.forceWipeForLab();
  store.reset();
  const logger = new TradeLogger(path.join(DEMO_DATA, "logs"));
  const pipeline = new TradingPipeline(store, logger);

  console.log("=== Full Autonomy Capital Experiment Demo ===");
  console.log("Objective:", RISK.PRIMARY_OBJECTIVE);
  console.log("Starting equity:", RISK.STARTING_CASH_USD);
  console.log("Hard boundaries: 48h max hold | no leverage/borrow/funding | death at equity<=0");
  console.log("Sizing: STRATEGY-OWNED (no fixed % caps)");

  const pumpResearch = scorePumpCoin((await new FixturePumpFunClient().listRecentCoins(1))[0]!);
  logger.logResearch(pumpResearch);
  let state = store.load();
  const pumpDecision = decideTrade(pumpResearch, state, { aggressiveness: "balanced" });
  let pumpResult = null;
  let pumpProposal = null;
  if (pumpDecision.action === "propose") {
    pumpProposal = pumpDecision.proposal;
    pumpResult = pipeline.processProposal(pumpProposal);
  }
  const pumpPath = writeArtifact("pumpfun_example_trade.json", {
    kind: "pumpfun_autonomous_sim",
    agentDecision: pumpDecision,
    proposal: pumpProposal,
    result: pumpResult,
    survivalAfter: survivalCheck(store.load()),
  });
  console.log("\n[Pump.fun]", pumpDecision.action, pumpResult?.status ?? "", pumpProposal ? `size$${pumpProposal.sizeUsd} (${pumpProposal.decision.percentOfEquityRisked}% eq)` : "");

  const polyMarkets = await new FixturePolymarketClient().listActiveMarkets(5);
  const short = polyMarkets.find((m) => m.endDate && Date.parse(m.endDate) - Date.now() <= 48 * 3_600_000);
  if (!short) throw new Error("No ≤48h poly fixture");
  const polyResearch = scorePolymarket(short);
  logger.logResearch(polyResearch);
  state = store.load();
  const polyDecision = decideTrade(polyResearch, state, { aggressiveness: "aggressive" });
  let polyResult = null;
  let polyProposal = null;
  if (polyDecision.action === "propose") {
    polyProposal = polyDecision.proposal;
    polyResult = pipeline.processProposal(polyProposal);
  }
  const polyPath = writeArtifact("polymarket_example_trade.json", {
    kind: "polymarket_autonomous_paper",
    agentDecision: polyDecision,
    proposal: polyProposal,
    result: polyResult,
    survivalAfter: survivalCheck(store.load()),
  });
  console.log("\n[Polymarket]", polyDecision.action, polyResult?.status ?? "", polyProposal ? `size$${polyProposal.sizeUsd}` : "");

  const finalState = store.load();
  const summary = {
    objective: RISK.PRIMARY_OBJECTIVE,
    cashUsd: finalState.cashUsd,
    totalEquityUsd: computeTotalEquity(finalState),
    peakEquityUsd: finalState.peakEquityUsd,
    agentStatus: finalState.agentStatus,
    survivalStateInfoOnly: finalState.survivalState,
    openPositions: finalState.openPositions.map((p) => ({
      market: p.market,
      sizeUsd: p.sizeUsd,
      pctAtEntry: p.decision?.percentOfEquityRisked,
      forcedExitAt: p.forcedExitAt,
    })),
    survival: survivalCheck(finalState),
    artifacts: { pumpfun: pumpPath, polymarket: polyPath },
    note: "Simulation/paper only — no real-money execution",
  };
  writeArtifact("demo_summary.json", summary);
  console.log("\n=== Demo complete ===");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
