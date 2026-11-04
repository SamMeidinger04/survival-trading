#!/usr/bin/env node
/**
 * One-shot autonomous agent run against LIVE read-only market data.
 * Proposes 0..n paper/sim trades via risk engine. NO real execution.
 *
 * For the multi-day paper trial with durable state, use:
 *   npm run trial-cycle
 * (see src/cli/trialCycle.ts → data/trial/)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpPumpFunClient, ResilientPumpFunClient } from "../markets/pumpfun/client.js";
import { HttpPolymarketClient, ResilientPolymarketClient } from "../markets/polymarket/client.js";
import { scorePumpCoin, scorePolymarket } from "../research/scorer.js";
import { StateStore } from "../state/store.js";
import { TradeLogger } from "../logging/logger.js";
import { TradingPipeline } from "../pipeline/execute.js";
import { decideTrade } from "../strategy/autonomousAgent.js";
import { computeTotalEquity, survivalCheck, validateTradeProposal } from "../risk/engine.js";
import { RISK } from "../risk/constants.js";
import type { ResearchNote } from "../schemas/research.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const ARTIFACTS = path.join(ROOT, "artifacts");
const RUN_DATA = path.join(ROOT, "data", "autonomy-live");

type ScanAttempt = {
  market: string;
  attempt: number;
  ok: boolean;
  source?: string;
  count?: number;
  error?: string;
};

async function scanWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
  retries = 2,
): Promise<{ value?: T; attempts: ScanAttempt[] }> {
  const attempts: ScanAttempt[] = [];
  for (let i = 1; i <= retries + 1; i++) {
    try {
      const value = await fn();
      attempts.push({ market: label, attempt: i, ok: true });
      return { value, attempts };
    } catch (e) {
      attempts.push({
        market: label,
        attempt: i,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
  return { attempts };
}

async function main() {
  fs.rmSync(RUN_DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DATA, "logs"), { recursive: true });
  fs.mkdirSync(path.join(RUN_DATA, "state"), { recursive: true });
  // Prefer live — do NOT force fixtures
  delete process.env.SURVIVAL_FORCE_FIXTURES;
  process.env.SURVIVAL_DATA_DIR = RUN_DATA;

  const store = new StateStore(path.join(RUN_DATA, "state"));
  store.forceWipeForLab();
  store.reset();
  const logger = new TradeLogger(path.join(RUN_DATA, "logs"));
  const pipeline = new TradingPipeline(store, logger);

  const report: Record<string, unknown> = {
    ranAt: new Date().toISOString(),
    objective: RISK.PRIMARY_OBJECTIVE,
    mode: "live_read_only_then_paper_sim",
    realMoneyExecution: false,
    startingEquity: RISK.STARTING_CASH_USD,
    scanAttempts: [] as ScanAttempt[],
    research: [] as unknown[],
    decisions: [] as unknown[],
    pipelineResults: [] as unknown[],
    usedFixturesFallback: false,
    errors: [] as string[],
  };

  const allAttempts: ScanAttempt[] = [];
  let pumpResearch: ResearchNote[] = [];
  let polyResearch: ResearchNote[] = [];

  // --- Pump.fun live ---
  const pumpLive = await scanWithRetry("pumpfun-live", async () => {
    const client = new HttpPumpFunClient();
    const coins = await client.listRecentCoins(8);
    if (!coins.length) throw new Error("empty pump list");
    return coins;
  });
  allAttempts.push(...pumpLive.attempts);
  if (pumpLive.value) {
    pumpResearch = pumpLive.value.map(scorePumpCoin).sort((a, b) => b.score - a.score);
    allAttempts[allAttempts.length - 1]!.source = "live";
    allAttempts[allAttempts.length - 1]!.count = pumpLive.value.length;
  } else {
    report.errors = [...(report.errors as string[]), "Pump.fun live failed after retries"];
    const resilient = new ResilientPumpFunClient();
    const coins = await resilient.listRecentCoins(8);
    pumpResearch = coins.map(scorePumpCoin).sort((a, b) => b.score - a.score);
    report.usedFixturesFallback = report.usedFixturesFallback || resilient.lastSource === "fixture";
    allAttempts.push({
      market: "pumpfun-fallback",
      attempt: 1,
      ok: true,
      source: resilient.lastSource,
      count: coins.length,
    });
  }

  // --- Polymarket live ---
  const polyLive = await scanWithRetry("polymarket-live", async () => {
    const client = new HttpPolymarketClient();
    const markets = await client.listActiveMarkets(25);
    if (!markets.length) throw new Error("empty poly list");
    return markets;
  });
  allAttempts.push(...polyLive.attempts);
  if (polyLive.value) {
    const within48 = polyLive.value.filter((m) => {
      if (!m.endDate) return false;
      const h = (Date.parse(m.endDate) - Date.now()) / 3_600_000;
      return h > 0 && h <= 48;
    });
    // If none within 48h, still score all but agent will no_trade far ones
    const pool = within48.length ? within48 : polyLive.value;
    polyResearch = pool.map(scorePolymarket).sort((a, b) => b.score - a.score);
    allAttempts[allAttempts.length - 1]!.source = "live";
    allAttempts[allAttempts.length - 1]!.count = pool.length;
    (report as { polyWithin48Count?: number }).polyWithin48Count = within48.length;
  } else {
    report.errors = [...(report.errors as string[]), "Polymarket live failed after retries"];
    const resilient = new ResilientPolymarketClient();
    const markets = await resilient.listActiveMarkets(10);
    polyResearch = markets.map(scorePolymarket).sort((a, b) => b.score - a.score);
    report.usedFixturesFallback = report.usedFixturesFallback || resilient.lastSource === "fixture";
    allAttempts.push({
      market: "polymarket-fallback",
      attempt: 1,
      ok: true,
      source: resilient.lastSource,
      count: markets.length,
    });
  }

  for (const r of [...pumpResearch.slice(0, 3), ...polyResearch.slice(0, 5)]) {
    logger.logResearch(r);
    (report.research as unknown[]).push({
      market: r.market,
      score: r.score,
      instrument: r.instrumentName ?? r.instrument,
      summary: r.summary.slice(0, 160),
    });
  }

  // Autonomous decisions: consider best of each market (0..n trades)
  const candidates: ResearchNote[] = [];
  if (pumpResearch[0]) candidates.push(pumpResearch[0]);
  // Prefer poly markets that resolve within 48h
  for (const r of polyResearch) {
    const end = r.raw?.endDate;
    if (typeof end === "string") {
      const h = (Date.parse(end) - Date.now()) / 3_600_000;
      if (h > 0 && h <= 48) {
        candidates.push(r);
        break;
      }
    }
  }
  if (candidates.length === 1 && polyResearch[0] && candidates[0]!.market !== "polymarket") {
    // still record a no_trade consideration for best poly even if far
    candidates.push(polyResearch[0]);
  }

  for (const research of candidates) {
    const state = store.load();
    if (state.agentStatus === "DEAD") break;
    const decision = decideTrade(research, state, { aggressiveness: "balanced" });
    (report.decisions as unknown[]).push({
      market: research.market,
      instrument: research.instrumentName ?? research.instrument,
      score: research.score,
      decision:
        decision.action === "no_trade"
          ? { action: "no_trade", reason: decision.reason }
          : {
              action: "propose",
              reason: decision.reason,
              sizeUsd: decision.proposal.sizeUsd,
              percentOfEquity: decision.proposal.decision.percentOfEquityRisked,
              ev: decision.proposal.decision.expectedValueUsd,
            },
    });

    if (decision.action === "propose") {
      // Pre-validate for report transparency
      const risk = validateTradeProposal(decision.proposal, state);
      const result = pipeline.processProposal(decision.proposal);
      (report.pipelineResults as unknown[]).push({
        riskApproved: risk.approved,
        status: result.status,
        code: result.status === "rejected" ? result.decision.code : undefined,
        sizeUsd: decision.proposal.sizeUsd,
        market: decision.proposal.market,
      });
    }
  }

  const finalState = store.load();
  report.scanAttempts = allAttempts;
  report.final = {
    cashUsd: finalState.cashUsd,
    totalEquityUsd: computeTotalEquity(finalState),
    peakEquityUsd: finalState.peakEquityUsd,
    agentStatus: finalState.agentStatus,
    survivalStateInfoOnly: finalState.survivalState,
    openPositions: finalState.openPositions.length,
    survival: survivalCheck(finalState),
  };
  report.logsDir = path.join(RUN_DATA, "logs");

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const out = path.join(ARTIFACTS, "autonomy_live_readonly_run.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ saved: out, final: report.final, usedFixturesFallback: report.usedFixturesFallback, decisions: report.decisions }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
