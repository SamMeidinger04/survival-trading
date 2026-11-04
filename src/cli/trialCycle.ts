#!/usr/bin/env node
/**
 * Multi-day paper trial cycle runner.
 * Durable state under data/trial/ (accumulates across cycles).
 * ZERO real dollars — sim/paper only. Live read-only market data preferred.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpPumpFunClient, ResilientPumpFunClient } from "../markets/pumpfun/client.js";
import { HttpPolymarketClient, ResilientPolymarketClient } from "../markets/polymarket/client.js";
import { scorePumpCoin, scorePolymarket } from "../research/scorer.js";
import {
  gatherXTrendsForCandidates,
  applyXTrendToResearch,
  type XTrendCandidate,
} from "../research/xTrends.js";
import { StateStore } from "../state/store.js";
import { TradeLogger } from "../logging/logger.js";
import { TradingPipeline } from "../pipeline/execute.js";
import { decideTrade } from "../strategy/autonomousAgent.js";
import {
  computeTotalEquity,
  survivalCheck,
  validateTradeProposal,
  positionsRequiringForceExit,
} from "../risk/engine.js";
import { RISK } from "../risk/constants.js";
import type { ResearchNote } from "../schemas/research.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const ARTIFACTS = path.join(ROOT, "artifacts");
const TRIAL_DATA = path.resolve(
  process.env.SURVIVAL_TRIAL_DIR ?? path.join(ROOT, "data", "trial"),
);

type ScanAttempt = {
  market: string;
  attempt: number;
  ok: boolean;
  source?: string;
  count?: number;
  error?: string;
};

function parseArgs(argv: string[]) {
  const reset = argv.includes("--reset");
  const cycleArg = argv.find((a) => a.startsWith("--cycle="));
  const cycle = cycleArg ? Number(cycleArg.split("=")[1]) : undefined;
  return { reset, cycle };
}

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
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  return { attempts };
}

function loadCycleCounter(trialDir: string): number {
  const p = path.join(trialDir, "cycle_counter.json");
  if (!fs.existsSync(p)) return 0;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { lastCycle?: number };
    return Number(j.lastCycle ?? 0);
  } catch {
    return 0;
  }
}

function saveCycleCounter(trialDir: string, n: number): void {
  fs.writeFileSync(
    path.join(trialDir, "cycle_counter.json"),
    JSON.stringify({ lastCycle: n, updatedAt: new Date().toISOString() }, null, 2) + "\n",
  );
}


/**
 * Fetch live USD marks for open pump.fun positions (instrument = mint).
 * Used for MTM + non-flat force exits.
 */
async function fetchOpenPositionMarks(
  openPositions: { market: string; instrument: string }[],
): Promise<{ marks: Record<string, number>; refreshed: number; failures: string[] }> {
  const marks: Record<string, number> = {};
  const failures: string[] = [];
  const pump = openPositions.filter((p) => p.market === "pumpfun");
  if (!pump.length) return { marks, refreshed: 0, failures };

  // Prefer live HTTP client for marks — fixture fallback cannot price live mints
  const live = new HttpPumpFunClient();
  const resilient = new ResilientPumpFunClient();
  const concurrency = 4;
  let i = 0;
  async function worker() {
    while (i < pump.length) {
      const idx = i++;
      const p = pump[idx]!;
      try {
        let coin = null;
        try {
          coin = await live.getCoin(p.instrument);
        } catch (e1) {
          // one resilient retry (may still be live if API recovers)
          try {
            coin = await resilient.getCoin(p.instrument);
          } catch (e2) {
            failures.push(
              `${p.instrument}: ${e1 instanceof Error ? e1.message : String(e1)}`,
            );
            continue;
          }
        }
        const px =
          coin?.priceUsd != null && coin.priceUsd > 0
            ? coin.priceUsd
            : coin?.usdMarketCap != null && coin.usdMarketCap > 0
              ? undefined // mcap alone is not a per-token mark without supply
              : undefined;
        if (px != null && px > 0) {
          marks[p.instrument] = px;
        } else if (coin == null) {
          failures.push(`${p.instrument}: coin not found`);
        } else {
          failures.push(
            `${p.instrument}: no priceUsd (source=${coin.source}, mcap=${coin.usdMarketCap ?? coin.marketCapUsd ?? "n/a"})`,
          );
        }
      } catch (e) {
        failures.push(`${p.instrument}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pump.length) }, () => worker()));
  return { marks, refreshed: Object.keys(marks).length, failures };
}

async function main() {
  const { reset, cycle: cycleOverride } = parseArgs(process.argv.slice(2));

  fs.mkdirSync(path.join(TRIAL_DATA, "logs"), { recursive: true });
  fs.mkdirSync(path.join(TRIAL_DATA, "state"), { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  delete process.env.SURVIVAL_FORCE_FIXTURES;
  process.env.SURVIVAL_DATA_DIR = TRIAL_DATA;

  const store = new StateStore(path.join(TRIAL_DATA, "state"));
  const statePath = store.statePath;
  const isFirstSeed = !fs.existsSync(statePath);

  if (reset) {
    if (fs.existsSync(statePath)) {
      const existing = store.load();
      if (existing.agentStatus === "DEAD" || existing.tradingPermanentlyDisabled) {
        console.error("Cannot --reset: agent is DEAD (no bailouts). Use forceWipeForLab only in labs.");
        process.exit(2);
      }
    }
    store.forceWipeForLab();
    store.reset();
    saveCycleCounter(TRIAL_DATA, 0);
    console.log("Trial state reset to $100 (lab flag --reset).");
  } else if (isFirstSeed) {
    store.reset(); // seeds $100 only when no state file
    console.log("Initialized durable trial state at $100.");
  } else {
    console.log("Loaded existing durable trial state:", statePath);
  }

  const logger = new TradeLogger(path.join(TRIAL_DATA, "logs"));
  const pipeline = new TradingPipeline(store, logger);

  const prevCycle = loadCycleCounter(TRIAL_DATA);
  const cycleNumber = cycleOverride ?? prevCycle + 1;
  const ranAt = new Date();
  const ranAtIso = ranAt.toISOString();
  const stamp = ranAtIso.replace(/[:.]/g, "-");

  const before = store.load();
  const equityBefore = computeTotalEquity(before);

  const report: Record<string, unknown> = {
    trial: "survival-trading-4-5-day-paper",
    cycleNumber,
    ranAt: ranAtIso,
    timezoneNote: "box-local America/Edmonton (MDT)",
    objective: RISK.PRIMARY_OBJECTIVE,
    mode: "paper_trial_cycle_live_readonly",
    realMoneyExecution: false,
    realDollars: 0,
    durableStateDir: TRIAL_DATA,
    statePath,
    seededFreshThisCycle: isFirstSeed || reset,
    equityBefore,
    cashBefore: before.cashUsd,
    agentStatusBefore: before.agentStatus,
    openPositionsBefore: before.openPositions.map((p) => ({
      id: p.id,
      market: p.market,
      instrument: p.instrumentName ?? p.instrument,
      sizeUsd: p.sizeUsd,
      forcedExitAt: p.forcedExitAt,
      currentMarketValueUsd: p.currentMarketValueUsd,
    })),
    forceExits: [] as unknown[],
    scanAttempts: [] as ScanAttempt[],
    research: [] as unknown[],
    xTrends: [] as unknown[],
    decisions: [] as unknown[],
    pipelineResults: [] as unknown[],
    usedFixturesFallback: false,
    errors: [] as string[],
  };

  // --- Step: refresh live marks (MTM) then force-exit expired 48h positions ---
  const markFetch = await fetchOpenPositionMarks(before.openPositions);
  report.marksRefreshed = markFetch.refreshed;
  report.marksAttempted = before.openPositions.filter((p) => p.market === "pumpfun").length;
  report.markFetchFailures = markFetch.failures;
  if (markFetch.failures.length) {
    (report.errors as string[]).push(
      ...markFetch.failures.slice(0, 10).map((f) => `markFetch: ${f}`),
    );
  }

  let equityAfterMark = equityBefore;
  if (Object.keys(markFetch.marks).length) {
    const marked = pipeline.markUnrealized(markFetch.marks);
    equityAfterMark = computeTotalEquity(marked);
    report.equityAfterMark = equityAfterMark;
    report.openUnrealizedAfterMark = marked.openPositions.map((p) => ({
      id: p.id,
      instrument: p.instrumentName ?? p.instrument,
      entryPrice: p.entryPrice,
      mark: markFetch.marks[p.instrument],
      unrealizedPnlUsd: p.unrealizedPnlUsd,
      currentMarketValueUsd: p.currentMarketValueUsd,
    }));
  } else {
    report.equityAfterMark = equityBefore;
    report.openUnrealizedAfterMark = [];
  }

  const due = positionsRequiringForceExit(store.load(), ranAt);
  if (due.length) {
    const { closed, state: afterForce } = pipeline.forceExitExpired(ranAt, markFetch.marks);
    (report.forceExits as unknown[]).push(
      ...closed.map((c) => ({
        id: c.id,
        market: c.market,
        instrument: c.instrumentName ?? c.instrument,
        entryPrice: c.entryPrice,
        exitPrice: c.exitPrice,
        realizedPnlUsd: c.realizedPnlUsd,
        closeReason: c.closeReason,
        forcedExitAt: c.forcedExitAt,
      })),
    );
    report.equityAfterForceExit = computeTotalEquity(afterForce);
  } else {
    report.forceExits = [];
    report.equityAfterForceExit = equityAfterMark;
  }

  if (store.load().agentStatus === "DEAD") {
    report.final = {
      cashUsd: store.load().cashUsd,
      totalEquityUsd: computeTotalEquity(store.load()),
      peakEquityUsd: store.load().peakEquityUsd,
      agentStatus: "DEAD",
      openPositions: [],
      survival: survivalCheck(store.load()),
      note: "Agent DEAD — cycle aborted after force-exits / prior death",
    };
    writeReports(report, stamp, cycleNumber);
    saveCycleCounter(TRIAL_DATA, cycleNumber);
    console.log(JSON.stringify({ cycleNumber, aborted: "DEAD", saved: true }, null, 2));
    return;
  }

  const allAttempts: ScanAttempt[] = [];
  let pumpResearch: ResearchNote[] = [];
  let polyResearch: ResearchNote[] = [];

  // --- Pump.fun live ---
  const pumpLive = await scanWithRetry("pumpfun-live", async () => {
    const coins = await new HttpPumpFunClient().listRecentCoins(10);
    if (!coins.length) throw new Error("empty pump list");
    return coins;
  });
  allAttempts.push(...pumpLive.attempts);
  if (pumpLive.value) {
    pumpResearch = pumpLive.value.map(scorePumpCoin).sort((a, b) => b.score - a.score);
    const last = allAttempts[allAttempts.length - 1]!;
    last.source = "live";
    last.count = pumpLive.value.length;
  } else {
    (report.errors as string[]).push("Pump.fun live failed after retries");
    const resilient = new ResilientPumpFunClient();
    const coins = await resilient.listRecentCoins(10);
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

  // --- Polymarket live (prefer ≤48h resolution) ---
  const polyLive = await scanWithRetry("polymarket-live", async () => {
    const markets = await new HttpPolymarketClient().listActiveMarkets(40);
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
    const pool = within48.length ? within48 : polyLive.value;
    polyResearch = pool.map(scorePolymarket).sort((a, b) => b.score - a.score);
    const last = allAttempts[allAttempts.length - 1]!;
    last.source = "live";
    last.count = pool.length;
    report.polyWithin48Count = within48.length;
  } else {
    (report.errors as string[]).push("Polymarket live failed after retries");
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

  // --- X / social public-web trend research for top candidates ---
  const xCandidates: XTrendCandidate[] = [];
  for (const r of [...pumpResearch.slice(0, 3), ...polyResearch.slice(0, 2)]) {
    const sym =
      typeof r.raw?.symbol === "string"
        ? r.raw.symbol
        : r.instrumentName?.match(/\b([A-Z0-9]{2,15})\b/)?.[1];
    xCandidates.push({
      instrument: r.instrument,
      instrumentName: r.instrumentName,
      symbol: sym,
      market: r.market,
    });
  }
  const xTrends = await gatherXTrendsForCandidates(xCandidates, { concurrency: 2 });
  for (const t of xTrends) {
    logger.logXTrends(t);
    (report.xTrends as unknown[]).push({
      instrument: t.instrumentName ?? t.instrument,
      heat: t.mentionHeat,
      scoreDelta: t.scoreDelta,
      ok: t.ok,
      scamWarnings: t.scamRugWarnings.length,
      sources: t.sourceUrls.slice(0, 3),
      summary: t.summary,
    });
  }
  const xByInstrument = new Map(xTrends.map((t) => [t.instrument, t]));
  pumpResearch = pumpResearch.map((r) => {
    const t = xByInstrument.get(r.instrument);
    return t ? applyXTrendToResearch(r, t) : r;
  });
  polyResearch = polyResearch.map((r) => {
    const t = xByInstrument.get(r.instrument);
    return t ? applyXTrendToResearch(r, t) : r;
  });
  // Re-sort after X score deltas
  pumpResearch.sort((a, b) => b.score - a.score);
  polyResearch.sort((a, b) => b.score - a.score);

  for (const r of [...pumpResearch.slice(0, 5), ...polyResearch.slice(0, 5)]) {
    logger.logResearch(r);
    (report.research as unknown[]).push({
      market: r.market,
      score: r.score,
      instrument: r.instrumentName ?? r.instrument,
      summary: r.summary.slice(0, 180),
      xTrend: (r.raw as { xTrend?: { mentionHeat?: string; scoreDelta?: number; ok?: boolean } } | undefined)?.xTrend
        ? {
            heat: (r.raw as { xTrend: { mentionHeat: string; scoreDelta: number; ok: boolean } }).xTrend.mentionHeat,
            scoreDelta: (r.raw as { xTrend: { mentionHeat: string; scoreDelta: number; ok: boolean } }).xTrend.scoreDelta,
            ok: (r.raw as { xTrend: { mentionHeat: string; scoreDelta: number; ok: boolean } }).xTrend.ok,
          }
        : null,
    });
  }

  const candidates: ResearchNote[] = [];

  if (pumpResearch[0]) candidates.push(pumpResearch[0]);
  let polyCandidate: ResearchNote | undefined;
  for (const r of polyResearch) {
    const end = r.raw?.endDate;
    if (typeof end === "string") {
      const h = (Date.parse(end) - Date.now()) / 3_600_000;
      if (h > 0 && h <= 48) {
        polyCandidate = r;
        break;
      }
    }
  }
  if (polyCandidate) candidates.push(polyCandidate);
  else if (polyResearch[0]) candidates.push(polyResearch[0]); // will likely no_trade

  for (const research of candidates) {
    const state = store.load();
    if (state.agentStatus === "DEAD") break;
    const decision = decideTrade(research, state, { aggressiveness: "aggressive" });
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
              maxLoss: decision.proposal.decision.maximumPossibleLossUsd,
              forcedExitTime: decision.proposal.decision.forcedExitTime,
            },
    });

    if (decision.action === "propose") {
      const risk = validateTradeProposal(decision.proposal, state);
      const result = pipeline.processProposal(decision.proposal);
      (report.pipelineResults as unknown[]).push({
        riskApproved: risk.approved,
        status: result.status,
        code: result.status === "rejected" ? result.decision.code : undefined,
        sizeUsd: decision.proposal.sizeUsd,
        market: decision.proposal.market,
        instrument: decision.proposal.instrumentName ?? decision.proposal.instrument,
        positionId: result.status === "approved" ? result.position.id : undefined,
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
    tradingEnabled: finalState.tradingEnabled,
    openPositionCount: finalState.openPositions.length,
    openPositions: finalState.openPositions.map((p) => ({
      id: p.id,
      market: p.market,
      instrument: p.instrumentName ?? p.instrument,
      sizeUsd: p.sizeUsd,
      entryPrice: p.entryPrice,
      currentMarketValueUsd: p.currentMarketValueUsd,
      forcedExitAt: p.forcedExitAt,
      unrealizedPnlUsd: p.unrealizedPnlUsd,
      percentOfEquityAtEntry: p.decision?.percentOfEquityRisked,
    })),
    survival: survivalCheck(finalState),
  };
  report.logsDir = path.join(TRIAL_DATA, "logs");

  const paths = writeReports(report, stamp, cycleNumber);
  saveCycleCounter(TRIAL_DATA, cycleNumber);

  // Append to trial ledger
  fs.appendFileSync(
    path.join(TRIAL_DATA, "cycle_ledger.jsonl"),
    JSON.stringify({
      cycleNumber,
      ranAt: ranAtIso,
      equity: (report.final as { totalEquityUsd: number }).totalEquityUsd,
      cash: (report.final as { cashUsd: number }).cashUsd,
      agentStatus: (report.final as { agentStatus: string }).agentStatus,
      openPositions: (report.final as { openPositionCount: number }).openPositionCount,
      decisions: report.decisions,
      latestArtifact: paths.latest,
    }) + "\n",
  );

  console.log(
    JSON.stringify(
      {
        cycleNumber,
        agentStatus: (report.final as { agentStatus: string }).agentStatus,
        cashUsd: (report.final as { cashUsd: number }).cashUsd,
        totalEquityUsd: (report.final as { totalEquityUsd: number }).totalEquityUsd,
        openPositions: (report.final as { openPositions: unknown[] }).openPositions,
        decisions: report.decisions,
        forceExits: report.forceExits,
        marksRefreshed: report.marksRefreshed,
        marksAttempted: report.marksAttempted,
        equityAfterMark: report.equityAfterMark,
        usedFixturesFallback: report.usedFixturesFallback,
        artifacts: paths,
      },
      null,
      2,
    ),
  );
}

function writeReports(
  report: Record<string, unknown>,
  stamp: string,
  cycleNumber: number,
): { latest: string; stamped: string } {
  const latest = path.join(ARTIFACTS, "trial_cycle_latest.json");
  const stamped = path.join(ARTIFACTS, `trial_cycle_${stamp}.json`);
  const body = JSON.stringify(report, null, 2) + "\n";
  fs.writeFileSync(latest, body, "utf8");
  fs.writeFileSync(stamped, body, "utf8");
  // also keep numbered convenience copy
  fs.writeFileSync(
    path.join(ARTIFACTS, `trial_cycle_${String(cycleNumber).padStart(3, "0")}.json`),
    body,
    "utf8",
  );
  return { latest, stamped };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
