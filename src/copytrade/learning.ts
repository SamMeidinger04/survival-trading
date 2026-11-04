/**
 * Learning-mode analysis + auto-tune (paper only, $0 real money).
 *
 * - analyzeBook: win rate / PnL grouped by wallet, exit reason, token-age
 *   bucket, liquidity bucket, entry slippage bucket, and sizing tier.
 * - computeLearningTuning: once ≥ LEARNING_MIN_CLOSES_FOR_TUNING learning
 *   trades have closed, promote / demote wallets and pick TP/SL from a
 *   conservative MFE/MAE replay (stop assumed to hit first when both touched).
 */

import {
  LEARNING_MIN_CLOSES_FOR_TUNING,
  LEARNING_MIN_NONRUG_CLOSES_FOR_TPSL,
  LEARNING_PARTIAL_TP_FRACTION,
  LOSS_PCT,
  MIN_ACTIVE_WALLETS,
  REPLAY_VERSION,
  RUG_GAP_PCT,
  STOP_FILL_OVERSHOOT_PCT,
  TRACKED_WALLETS,
  WIN_PCT,
} from "./config.js";
import {
  isQualifyingLearningClose,
  isRugClose,
  meetsSuspensionCriteria,
  realizedPct,
  walletSuspensionStats,
} from "./qualify.js";
import { exitBucketOf, isAgentScrubClose } from "./paperBook.js";
import type {
  CopyBookState,
  LearningTuningState,
  PaperCopyPosition,
} from "./types.js";

export interface GroupStats {
  key: string;
  n: number;
  wins: number;
  winRate: number;
  pnlUsd: number;
  avgPnlPct: number;
}

export interface LearningReport {
  totalClosed: number;
  learningClosed: number;
  openCount: number;
  overall: GroupStats;
  byWallet: GroupStats[];
  byExit: GroupStats[];
  byTokenAge: GroupStats[];
  byLiquidity: GroupStats[];
  bySlippage: GroupStats[];
  byTier: GroupStats[];
  shadow: ShadowGroupStats[];
  suggestions: string[];
}

/** Market closes (excludes agent scrub_*). */
export function marketCloses(book: CopyBookState): PaperCopyPosition[] {
  return book.positions.filter((p) => p.status !== "open" && !isAgentScrubClose(p));
}

/** Market closes opened under the learning policy (feature-tagged). */
export function learningCloses(book: CopyBookState): PaperCopyPosition[] {
  return marketCloses(book).filter((p) => p.learning?.policy === "learning");
}

export function tokenAgeBucket(mins: number | null | undefined): string {
  if (mins == null || !Number.isFinite(mins)) return "unknown";
  if (mins < 30) return "<30m";
  if (mins < 120) return "30m-2h";
  if (mins < 24 * 60) return "2h-24h";
  if (mins < 7 * 24 * 60) return "1d-7d";
  return ">7d";
}

export function liquidityBucket(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "unknown";
  if (usd < 10_000) return "<$10k";
  if (usd < 50_000) return "$10k-50k";
  if (usd < 200_000) return "$50k-200k";
  return ">$200k";
}

export function slippageBucket(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "unknown";
  if (pct < -0.1) return "<-10%";
  if (pct < 0) return "-10%..0";
  if (pct < 0.1) return "0..+10%";
  if (pct < 0.3) return "+10..30%";
  return ">+30%";
}

function pnlPct(p: PaperCopyPosition): number {
  if (p.learning?.realizedPnlPct != null) return p.learning.realizedPnlPct;
  const basis = p.originalSizeUsd ?? p.sizeUsd;
  return basis > 0 ? (p.realizedPnlUsd ?? 0) / basis : 0;
}

function stats(key: string, ps: PaperCopyPosition[]): GroupStats {
  const n = ps.length;
  const wins = ps.filter((p) => (p.realizedPnlUsd ?? 0) > 0).length;
  const pnlUsd = ps.reduce((s, p) => s + (p.realizedPnlUsd ?? 0), 0);
  const avgPnlPct = n ? ps.reduce((s, p) => s + pnlPct(p), 0) / n : 0;
  return { key, n, wins, winRate: n ? wins / n : 0, pnlUsd, avgPnlPct };
}

function groupBy(
  ps: PaperCopyPosition[],
  keyOf: (p: PaperCopyPosition) => string,
): GroupStats[] {
  const m = new Map<string, PaperCopyPosition[]>();
  for (const p of ps) {
    const k = keyOf(p);
    const list = m.get(k) ?? [];
    list.push(p);
    m.set(k, list);
  }
  return [...m.entries()]
    .map(([k, v]) => stats(k, v))
    .sort((a, b) => b.pnlUsd - a.pnlUsd);
}

export function analyzeBook(book: CopyBookState): LearningReport {
  const closed = marketCloses(book);
  const learn = learningCloses(book);
  const byWallet = groupBy(closed, (p) => p.sourceWalletLabel || p.sourceWallet.slice(0, 6));
  const byExit = groupBy(closed, (p) => p.learning?.exitBucket ?? exitBucketOf(p.closeReason));
  const byTokenAge = groupBy(closed, (p) => tokenAgeBucket(p.learning?.tokenAgeMinutes));
  const byLiquidity = groupBy(closed, (p) => liquidityBucket(p.learning?.entryLiquidityUsd));
  const bySlippage = groupBy(closed, (p) => slippageBucket(p.learning?.entrySlippagePct));
  const byTier = groupBy(closed, (p) =>
    p.learning ? `${p.learning.policy}:${p.learning.walletTier}` : "legacy:untagged",
  );
  const suggestions: string[] = [];
  if (learn.length < LEARNING_MIN_CLOSES_FOR_TUNING) {
    suggestions.push(
      `Only ${learn.length}/${LEARNING_MIN_CLOSES_FOR_TUNING} learning trades closed — auto promote/demote + TP/SL tune inactive; keep exploring at small size.`,
    );
  }
  const describe = (dim: string, gs: GroupStats[]) => {
    for (const g of gs) {
      if (g.n < 3 || g.key === "unknown") continue;
      if (g.pnlUsd > 0 && g.winRate >= 0.4) {
        suggestions.push(
          `${dim} ${g.key}: looks profitable (${g.wins}/${g.n} W, ${fmtUsd(g.pnlUsd)}) — favor / size up.`,
        );
      } else if (g.pnlUsd < 0 && g.winRate < 0.3) {
        suggestions.push(
          `${dim} ${g.key}: bleeding (${g.wins}/${g.n} W, ${fmtUsd(g.pnlUsd)}) — candidate gate / demote.`,
        );
      }
    }
  };
  describe("wallet", byWallet);
  describe("token age", byTokenAge);
  describe("liquidity", byLiquidity);
  describe("entry slippage", bySlippage);
  const rug = byExit.find((g) => g.key === "rug_gap");
  if (rug && closed.length && rug.n / closed.length >= 0.25) {
    suggestions.push(
      `rug_gap is ${rug.n}/${closed.length} closes (${fmtUsd(rug.pnlUsd)}) — keep sizes small; check which liquidity/age buckets the rugs came from.`,
    );
  }
  const tuning = computeLearningTuning(book, new Date(), { dryRun: true });
  if (tuning) {
    suggestions.push(
      `Auto-tune: TP +${(tuning.winPct * 100).toFixed(0)}% / SL -${(tuning.lossPct * 100).toFixed(0)}%${tuning.tpSlFrozen ? " (pinned)" : ""}; promote [${tuning.promoted.join(", ") || "-"}], suspend [${(tuning.suspended ?? []).join(", ") || "-"}].`,
    );
  }
  return {
    totalClosed: closed.length,
    learningClosed: learn.length,
    openCount: book.positions.filter((p) => p.status === "open").length,
    overall: stats("all", closed),
    byWallet,
    byExit,
    byTokenAge,
    byLiquidity,
    bySlippage,
    byTier,
    shadow: shadowReport(book),
    suggestions,
  };
}

function fmtUsd(n: number): string {
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

/**
 * Replay v2 (2026-09-28 ~21:00 MDT) — one closed trade under (tp, sl):
 * - rug (realized ≤ −30%): fills at the actual (worse) close.
 * - trough breached −sl (stop assumed first when both touched): fill at
 *   −(sl + STOP_FILL_OVERSHOOT_PCT), or the actual close if that was worse.
 * - recorded MARK peak ≥ tp: partial fraction at tp, remainder at the actual
 *   exit clamped to [breakeven, peak] (trail with breakeven floor).
 * - otherwise the actual exit — an exit above TP that the marks never showed
 *   (e.g. source-sell fill) is credited at its actual value, not as TP.
 */
export function replayTradePct(
  p: PaperCopyPosition,
  tp: number,
  sl: number,
  opts: { partialFraction?: number; overshoot?: number } = {},
): number {
  const frac = opts.partialFraction ?? LEARNING_PARTIAL_TP_FRACTION;
  const overshoot = opts.overshoot ?? STOP_FILL_OVERSHOOT_PCT;
  const final = realizedPct(p);
  const peak = Math.max(0, p.learning?.peakPnlPct ?? 0);
  const trough = Math.min(p.learning?.troughPnlPct ?? 0, final);
  const stopFill = -(sl + overshoot);
  if (final <= -RUG_GAP_PCT) return Math.min(final, stopFill);
  if (trough <= -sl) return final <= -sl ? Math.min(final, stopFill) : stopFill;
  if (peak >= tp) {
    if (!(frac > 0 && frac < 1)) return tp;
    const remainder = Math.max(0, Math.min(final, peak));
    return frac * tp + (1 - frac) * remainder;
  }
  return final;
}

export const TP_GRID = [0.08, 0.12, 0.15, 0.2, 0.3];
export const SL_GRID = [0.1, 0.15, 0.2, 0.25];
/** Minimum mean-per-trade improvement (fraction) before changing TP/SL. */
export const TUNE_MIN_EDGE = 0.005;

export interface TuningOpts {
  minCloses?: number;
  dryRun?: boolean;
  /** Active roster (for the MIN_ACTIVE_WALLETS floor). Default TRACKED_WALLETS. */
  activeWallets?: string[];
  /** Override the non-rug gate (tests). */
  minNonRugForTpSl?: number;
}

export function computeLearningTuning(
  book: CopyBookState,
  now = new Date(),
  opts: TuningOpts = {},
): LearningTuningState | null {
  const minCloses = opts.minCloses ?? LEARNING_MIN_CLOSES_FOR_TUNING;
  const learn = learningCloses(book);
  if (learn.length < minCloses) return null;
  const notes: string[] = [];

  // Promote (unchanged rule) on learning closes.
  const byWallet = new Map<string, PaperCopyPosition[]>();
  for (const p of learn) {
    const list = byWallet.get(p.sourceWallet) ?? [];
    list.push(p);
    byWallet.set(p.sourceWallet, list);
  }
  const promoted: string[] = [];
  for (const [w, ps] of byWallet) {
    const s = stats(w, ps);
    const label = ps[0]?.sourceWalletLabel ?? w.slice(0, 6);
    if (s.n >= 3 && s.pnlUsd > 0 && s.winRate >= 0.4) {
      promoted.push(w);
      notes.push(`promote ${label}: ${s.wins}/${s.n} W ${fmtUsd(s.pnlUsd)}`);
    }
  }

  // Suspension (replaces archive-on-demote): ≥12 qualifying closes, net<0, WR<25%;
  // floor of MIN_ACTIVE_WALLETS un-suspended active wallets.
  const active = opts.activeWallets ?? TRACKED_WALLETS.map((w) => w.address);
  const qstats = walletSuspensionStats(book);
  let suspended = active.filter((w) => meetsSuspensionCriteria(qstats.get(w)));
  const floorNeed = MIN_ACTIVE_WALLETS - (active.length - suspended.length);
  if (floorNeed > 0 && suspended.length) {
    const keep = [...suspended]
      .sort((a, b) => (qstats.get(b)!.pnlUsd - qstats.get(a)!.pnlUsd))
      .slice(0, floorNeed);
    for (const w of keep) {
      const s = qstats.get(w)!;
      notes.push(`floor keeps ${s.label} active (${s.wins}/${s.n} W ${fmtUsd(s.pnlUsd)}; min ${MIN_ACTIVE_WALLETS} active)`);
    }
    suspended = suspended.filter((w) => !keep.includes(w));
  }
  for (const w of suspended) {
    const s = qstats.get(w)!;
    notes.push(
      `suspend ${s.label}: ${s.wins}/${s.n} W ${fmtUsd(s.pnlUsd)} qualifying${s.shadowN ? ` (${s.shadowN} shadow)` : ""}`,
    );
  }

  // TP/SL: pinned at base until ≥50 non-rug qualifying closes; then replay v2 grid.
  const qual = learn.filter(isQualifyingLearningClose);
  const nonRug = qual.filter((p) => !isRugClose(p)).length;
  const minNonRug = opts.minNonRugForTpSl ?? LEARNING_MIN_NONRUG_CLOSES_FOR_TPSL;
  let winPct = WIN_PCT;
  let lossPct = LOSS_PCT;
  let tpSlFrozen = true;
  if (nonRug < minNonRug) {
    notes.push(
      `TP/SL pinned ${pct(WIN_PCT)}/${pct(LOSS_PCT)} (replay v${REPLAY_VERSION} needs ≥${minNonRug} non-rug qualifying closes; have ${nonRug})`,
    );
  } else {
    tpSlFrozen = false;
    const prev = book.learningTuning;
    const curTp = prev?.replayVersion === REPLAY_VERSION && !prev.tpSlFrozen ? prev.winPct : WIN_PCT;
    const curSl = prev?.replayVersion === REPLAY_VERSION && !prev.tpSlFrozen ? prev.lossPct : LOSS_PCT;
    const mean = (tp: number, sl: number) =>
      qual.reduce((s, p) => s + replayTradePct(p, tp, sl), 0) / qual.length;
    const curMean = mean(curTp, curSl);
    let best = { tp: curTp, sl: curSl, m: curMean };
    for (const tp of TP_GRID) {
      for (const sl of SL_GRID) {
        const m = mean(tp, sl);
        if (m > best.m) best = { tp, sl, m };
      }
    }
    winPct = curTp;
    lossPct = curSl;
    if (best.m - curMean >= TUNE_MIN_EDGE) {
      winPct = best.tp;
      lossPct = best.sl;
      notes.push(
        `TP/SL ${pct(curTp)}/${pct(curSl)} → ${pct(winPct)}/${pct(lossPct)} (replay v${REPLAY_VERSION} mean ${pct(curMean)} → ${pct(best.m)} per trade, n=${qual.length}, non-rug ${nonRug})`,
      );
    } else {
      notes.push(
        `TP/SL kept ${pct(curTp)}/${pct(curSl)} (replay v${REPLAY_VERSION} mean ${pct(curMean)}; best grid ${pct(best.tp)}/${pct(best.sl)} ${pct(best.m)} below +${pct(TUNE_MIN_EDGE)} edge)`,
      );
    }
  }
  void opts.dryRun;
  return {
    computedAt: now.toISOString(),
    learningClosed: learn.length,
    winPct,
    lossPct,
    promoted,
    demoted: suspended,
    suspended,
    replayVersion: REPLAY_VERSION,
    tpSlFrozen,
    nonRugQualifyingCloses: nonRug,
    notes,
  };
}

export interface ShadowGroupStats {
  reason: string;
  open: number;
  closed: number;
  rugs: number;
  wins: number;
  pnlUsd: number;
}

/** Shadow-trade outcome summary by reason (rug_filter / suspended_wallet). */
export function shadowReport(book: CopyBookState): ShadowGroupStats[] {
  const m = new Map<string, ShadowGroupStats>();
  for (const p of book.shadowPositions ?? []) {
    const reason = p.shadow?.reason ?? "unknown";
    const g = m.get(reason) ?? { reason, open: 0, closed: 0, rugs: 0, wins: 0, pnlUsd: 0 };
    if (p.status === "open") g.open++;
    else {
      g.closed++;
      if (isRugClose(p)) g.rugs++;
      if ((p.realizedPnlUsd ?? 0) > 0) g.wins++;
      g.pnlUsd += p.realizedPnlUsd ?? 0;
    }
    m.set(reason, g);
  }
  return [...m.values()];
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function formatReport(r: LearningReport): string {
  const row = (g: GroupStats) =>
    `  ${g.key.padEnd(24)} n=${String(g.n).padStart(3)}  W=${String(g.wins).padStart(3)}  WR=${(g.winRate * 100).toFixed(0).padStart(3)}%  PnL=${fmtUsd(g.pnlUsd).padStart(9)}  avg=${pct(g.avgPnlPct).padStart(7)}`;
  const section = (title: string, gs: GroupStats[]) =>
    [`\n${title}`, ...(gs.length ? gs.map(row) : ["  (none)"])].join("\n");
  return [
    "Copy-trade learning report (paper only, $0 real money)",
    `Closed (market): ${r.totalClosed} · learning-tagged closed: ${r.learningClosed} · open: ${r.openCount}`,
    row(r.overall),
    section("By wallet", r.byWallet),
    section("By exit reason", r.byExit),
    section("By token age at entry", r.byTokenAge),
    section("By entry liquidity", r.byLiquidity),
    section("By entry slippage vs source tx", r.bySlippage),
    section("By policy:tier", r.byTier),
    "\nShadow trades (blocked candidates; never in equity)",
    ...(r.shadow.length
      ? r.shadow.map(
          (g) =>
            `  ${g.reason.padEnd(24)} open=${g.open} closed=${g.closed} rugs(≤-30%)=${g.rugs} wins=${g.wins} hypothetical PnL=${fmtUsd(g.pnlUsd)}`,
        )
      : ["  (none yet)"]),
    "\nSuggestions",
    ...(r.suggestions.length ? r.suggestions.map((s) => `  - ${s}`) : ["  - none"]),
  ].join("\n");
}
