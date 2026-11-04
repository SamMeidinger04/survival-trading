/**
 * Autonomous capital-allocation agent.
 * Objective: MAXIMIZE TOTAL EQUITY.
 * Freely chooses size (1%…100% of cash/equity), markets, aggressiveness.
 * Still must pass hard-boundary risk validation before sim fill.
 * May use X/social trend signals embedded in ResearchNote.raw.xTrend.
 */
import { computeTotalEquity, survivalCheck } from "../risk/engine.js";
import { proposeFromResearch } from "../pipeline/propose.js";
import type { ResearchNote } from "../schemas/research.js";
import type { SystemState } from "../schemas/state.js";
import type { TradeProposal } from "../schemas/trade.js";
import type { XTrendSignal } from "../research/xTrends.js";

export type AgentDecision =
  | { action: "no_trade"; reason: string }
  | { action: "propose"; proposal: TradeProposal; reason: string };

function readXTrend(research: ResearchNote): XTrendSignal | undefined {
  const raw = research.raw?.xTrend;
  if (raw && typeof raw === "object") return raw as XTrendSignal;
  return undefined;
}

/**
 * Simple EV-seeking heuristic (strategy-owned, not risk-engine law).
 * X/social: scam/rug → prefer no_trade; strong heat can justify larger size.
 */
export function decideTrade(
  research: ResearchNote,
  state: SystemState,
  opts?: { aggressiveness?: "conservative" | "balanced" | "aggressive" },
): AgentDecision {
  const status = survivalCheck(state);
  if (!status.canOpenPositions || state.agentStatus === "DEAD") {
    return { action: "no_trade", reason: "Agent DEAD or trading disabled" };
  }

  const equity = computeTotalEquity(state);
  const cash = state.cashUsd;
  if (cash <= 0 || equity <= 0) {
    return { action: "no_trade", reason: "No controlled capital" };
  }

  if (research.market === "polymarket") {
    const end = research.raw?.endDate;
    if (typeof end === "string") {
      const hours = (Date.parse(end) - Date.now()) / 3_600_000;
      if (!Number.isFinite(hours) || hours > 48 || hours < 0) {
        return { action: "no_trade", reason: `Resolution outside 48h window (${hours}h)` };
      }
    } else {
      return { action: "no_trade", reason: "Unclear resolution timing" };
    }
  }

  const x = readXTrend(research);
  if (x?.ok && x.scamRugWarnings.length >= 2 && x.scoreDelta <= -10) {
    return {
      action: "no_trade",
      reason: `X/social scam/rug warnings (Δ${x.scoreDelta}) — skip to protect equity`,
    };
  }

  // Prefer live entry prices — never invent a fake pump entry that breaks MTM
  if (research.market === "pumpfun") {
    const px = research.raw?.priceUsd;
    if (typeof px !== "number" || !(px > 0)) {
      return {
        action: "no_trade",
        reason: "No live priceUsd on research — skip rather than invent fake entry",
      };
    }
  }

  const aggr = opts?.aggressiveness ?? "balanced";
  const openCount = state.openPositions.length;
  const cashRatio = equity > 0 ? cash / equity : 0;

  // Raise bar: weak scores spray tiny bags and dilute equity focus
  if (research.score < 60) {
    return { action: "no_trade", reason: `Score ${research.score} too weak — no trade > bad trade` };
  }

  // Stop spraying: overcrowded book needs a high-conviction, concentrated bet
  if (openCount >= 8 && research.score < 75) {
    return {
      action: "no_trade",
      reason: `Overcrowded (${openCount} open) — need score>=75 to add (got ${research.score})`,
    };
  }

  // Wait for force-exit recycle when cash is thin and book already busy
  if (cashRatio < 0.15 && openCount >= 5 && research.score < 80) {
    return {
      action: "no_trade",
      reason: `Low cash (${(cashRatio * 100).toFixed(1)}% of equity) with ${openCount} open — wait for recycle unless score>=80`,
    };
  }

  let fractionOfCash: number;
  if (aggr === "conservative") {
    fractionOfCash = research.score >= 75 ? 0.15 : 0.05;
  } else if (aggr === "aggressive") {
    // Fewer larger bets: score>=75 → ~60–80% of cash
    fractionOfCash = research.score >= 75 ? 0.7 : research.score >= 70 ? 0.5 : 0.35;
  } else {
    fractionOfCash = research.score >= 80 ? 0.35 : research.score >= 60 ? 0.15 : 0.05;
  }

  // When overcrowded but score clears 75, size at least the aggressive fraction
  if (openCount >= 8 && research.score >= 75) {
    fractionOfCash = Math.max(fractionOfCash, 0.7);
  }

  // Strategy nudge from social heat (still strategy-owned, not risk-engine law)
  if (x?.ok) {
    if (x.mentionHeat === "high" && x.scamRugWarnings.length === 0) {
      const cap = research.score >= 75 && (aggr === "aggressive" || openCount >= 8) ? 0.8 : 1;
      fractionOfCash = Math.min(cap, fractionOfCash * 1.25);
    } else if (x.mentionHeat === "none" && research.market === "pumpfun") {
      // Do not shrink below aggressive floor when overcrowded high-conviction
      const floor = openCount >= 8 && research.score >= 75 ? 0.7 : 0.02;
      fractionOfCash = Math.max(floor, fractionOfCash * (openCount >= 8 && research.score >= 75 ? 1 : 0.75));
    }
  }

  const feeBuffer = fractionOfCash >= 0.99 ? 0 : Math.min(0.05, cash * 0.001);
  const sizeUsd = Number(Math.max(0.01, Math.min(cash - feeBuffer, cash * fractionOfCash)).toFixed(4));
  if (sizeUsd <= 0 || sizeUsd > cash) {
    return { action: "no_trade", reason: "Computed size not fundable" };
  }

  const pctEquity = (sizeUsd / equity) * 100;
  const xEvidenceFor =
    x?.ok && x.bullishNotes.length
      ? x.bullishNotes.slice(0, 2).map((n) => `X/social: ${n.slice(0, 120)}`)
      : x?.ok
        ? [`X/social heat=${x.mentionHeat}`]
        : ["X/social: unavailable this cycle"];
  const xEvidenceAgainst =
    x?.ok && (x.bearishNotes.length || x.scamRugWarnings.length)
      ? [...x.scamRugWarnings, ...x.bearishNotes].slice(0, 3).map((n) => `X/social: ${n.slice(0, 120)}`)
      : x?.ok
        ? [`X/social heat=${x.mentionHeat} — limited confirmation`]
        : ["X/social research empty/failed — size cautiously"];

  const proposal = proposeFromResearch(research, state, {
    strategy: `autonomous_${aggr}_v1`,
    sizeUsd,
    expectedHoldingHours: research.market === "pumpfun" ? 4 : 8,
    maximumHoldingHours: research.market === "pumpfun" ? 24 : 36,
    reasonForPositionSize: `${aggr}: risking ${pctEquity.toFixed(2)}% of equity ($${sizeUsd}) score=${research.score}${x?.ok ? ` xHeat=${x.mentionHeat} xΔ=${x.scoreDelta}` : ""} to maximize total equity`,
    alternativesConsidered: [
      "no trade",
      `size at ${(fractionOfCash * 50).toFixed(1)}% of cash`,
      `size at ${Math.min(100, fractionOfCash * 200).toFixed(1)}% of cash`,
      "concentrate elsewhere",
      ...(x?.ok && x.scamRugWarnings.length ? ["skip due to X scam/rug chatter"] : []),
    ],
    estimatedProbabilityOfSuccess: Math.min(0.85, Math.max(0.2, research.score / 100)),
    expectedReturnPct: research.market === "pumpfun" ? 0.3 : 0.2,
  });

  // Merge X evidence into autonomy decision record
  proposal.decision.evidenceSupporting = [
    ...proposal.decision.evidenceSupporting,
    ...xEvidenceFor,
  ];
  proposal.decision.evidenceAgainst = [
    ...proposal.decision.evidenceAgainst,
    ...xEvidenceAgainst,
  ];
  if (x?.sourceUrls?.length) {
    proposal.metadata = {
      ...(proposal.metadata ?? {}),
      xTrendSourceUrls: x.sourceUrls.slice(0, 5),
      xTrendSummary: x.summary,
    };
  }

  return {
    action: "propose",
    proposal,
    reason: proposal.decision.reasonForPositionSize,
  };
}
