/**
 * Paper copy book: sizing, dedupe, mark-to-market, simple win/loss/time exits.
 * $0 real money. Separate from the old Survival trial state.
 */

import { randomUUID } from "node:crypto";
import {
  COPY_BANKROLL_USD,
  COPY_SIZE_PROVEN_USD,
  COPY_SIZE_USD,
  PROVEN_SEED_WALLETS,
  LIVE_MARK_SOURCES,
  LOSS_PCT,
  isAcceptableLiveMarkRatio,
  liveDisagreesWithTxEntry,
  preferLiveOverTxEntry,
  shouldRefuseUnderwaterTxEntry,
  PROVEN_SIZE_COOLDOWN_MS,
  MARK_UNAVAILABLE_HOURS,
  MAX_HOLD_HOURS,
  MAX_OPEN_PER_WALLET,
  MAX_OPEN_POSITIONS,
  MAX_OPEN_UNPROVEN_TOTAL,
  OPEN_MARK_GRACE_MS,
  RECENT_SL_MINT_COOLDOWN_MS,
  SKIP_MINTS,
  SKIP_SYMBOLS,
  SKIP_NAME_PATTERN,
  SKIP_MAX_ENTRY_PRICE_USD,
  WIN_PCT,
  getActivePolicy,
  MAX_OPEN_SHADOW_POSITIONS,
  RUG_GAP_PCT,
  matchesRugProfile,
  matchesYoungThinPool,
  SIZE_CAP_YOUNG_THIN_TAG,
  SIZE_CAP_THIN_LIQ_TAG,
  BASE_SIZE_USD,
  EXPLORER_BIG_MIN_LIQ_USD,
  PROVEN_BIG_MIN_LIQ_USD,
  MIN_EXPOSURE_ROOM_USD,
  YOUNG_THIN_SIZE_CAP_USD,
  type CopyPolicy,
} from "./config.js";
import { isQualifyingLearningClose, suspendedWallets } from "./qualify.js";
import { getTokenPriceUsd } from "./prices.js";
import { sleep } from "./rpc.js";
import type {
  CopyBookState,
  LearningFeatures,
  PaperCopyPosition,
  WalletBuyEvent,
  WalletSellEvent,
} from "./types.js";

export function createEmptyBook(now = new Date()): CopyBookState {
  const iso = now.toISOString();
  return {
    version: 1,
    createdAt: iso,
    updatedAt: iso,
    bankrollUsd: COPY_BANKROLL_USD,
    cashUsd: COPY_BANKROLL_USD,
    copySizeUsd: getActivePolicy().explorerSizeUsd,
    winPct: WIN_PCT,
    lossPct: LOSS_PCT,
    maxHoldHours: MAX_HOLD_HOURS,
    lastPolledAt: iso,
    positions: [],
    seenSignatures: [],
    cycleCount: 0,
    notes: [
      "Paper copy book — $0 real money, no wallets/keys/swaps",
      "Separate from data/trial Survival experiment",
    ],
  };
}

export function equityOf(book: CopyBookState): {
  equityUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  openCount: number;
} {
  let unrealized = 0;
  let realized = 0;
  let openCount = 0;
  for (const p of book.positions) {
    if (p.status === "open") {
      unrealized += p.unrealizedPnlUsd;
      // Partial-TP leg already realized & returned to cash while remainder trails.
      realized += p.partialRealizedPnlUsd ?? 0;
      openCount++;
    } else {
      realized += p.realizedPnlUsd ?? 0;
    }
  }
  const openCost = book.positions
    .filter((p) => p.status === "open")
    .reduce((s, p) => s + p.sizeUsd, 0);
  return {
    equityUsd: book.cashUsd + openCost + unrealized,
    unrealizedPnlUsd: unrealized,
    realizedPnlUsd: realized,
    openCount,
  };
}

/** Pure: decide size for a new copy given cash + configured size. */
export function sizeForCopy(
  cashUsd: number,
  copySizeUsd: number,
): number | null {
  if (cashUsd < 1) return null;
  const size = Math.min(copySizeUsd, cashUsd);
  if (size < 1) return null;
  return size;
}

export interface ApplyMarkOpts {
  winPct: number;
  lossPct: number;
  maxHoldHours: number;
  /** Learning exit tuning: realize this fraction at +winPct (0 = full TP close). */
  partialTpFraction?: number;
  /** Trailing stop on the remainder after partial TP (fraction below peak, floored at breakeven). */
  trailPct?: number;
}

function withExcursion(
  pos: PaperCopyPosition,
  pnlPct: number,
): PaperCopyPosition["learning"] {
  if (!pos.learning) return pos.learning;
  return {
    ...pos.learning,
    peakPnlPct: Math.max(pos.learning.peakPnlPct ?? 0, pnlPct),
    troughPnlPct: Math.min(pos.learning.troughPnlPct ?? 0, pnlPct),
  };
}

/**
 * Pure: mark a position and optionally close on TP/SL/time.
 * Learning 2026-09-24 ~15:40 MDT: with opts.partialTpFraction + opts.trailPct,
 * first touch of +winPct realizes that fraction (partialRealizedPnlUsd; cash
 * returned by settleCashDelta) and the remainder trails from its peak with a
 * breakeven floor — banks the +12% hit rate while letting runners run.
 * rug_gap (≥2× lossPct) still exits immediately, even on the remainder.
 */
export function applyMark(
  pos: PaperCopyPosition,
  markPriceUsd: number,
  markSource: string,
  now: Date,
  opts: ApplyMarkOpts,
): PaperCopyPosition {
  if (pos.status !== "open") return pos;
  const markAt = now.toISOString();
  const unrealizedPnlUsd = (markPriceUsd - pos.entryPriceUsd) * pos.quantity;
  const unrealizedPnlPct =
    pos.entryPriceUsd > 0
      ? (markPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd
      : 0;
  let next: PaperCopyPosition = {
    ...pos,
    markPriceUsd,
    markSource,
    markAt,
    unrealizedPnlUsd,
    unrealizedPnlPct,
    learning: withExcursion(pos, unrealizedPnlPct),
  };

  const opened = new Date(pos.openedAt).getTime();
  const ageHours = (now.getTime() - opened) / 3_600_000;
  const ageMs = now.getTime() - opened;
  // 2026-09-28: fixed −30% rug threshold (was 2× lossPct → −20% stop gaps at SL −10%
  // were labelled rug_gap). Never below the stop itself.
  const gapPastStop = unrealizedPnlPct <= -Math.max(RUG_GAP_PCT, opts.lossPct);
  const slLabel = `SL -${(opts.lossPct * 100).toFixed(0)}%`;

  // Remainder after partial TP: trailing stop (breakeven floor), rug_gap, time.
  if (pos.partialTakenAt) {
    const peak = Math.max(pos.trailPeakPriceUsd ?? markPriceUsd, markPriceUsd);
    next = { ...next, trailPeakPriceUsd: peak };
    const trailPct = opts.trailPct ?? 0;
    const trailStop = Math.max(pos.entryPriceUsd, peak * (1 - trailPct));
    if (gapPastStop) {
      return closeByTotal(next, now, `rug_gap past ${slLabel} (after partial TP)`);
    }
    if (markPriceUsd <= trailStop) {
      return closeByTotal(
        next,
        now,
        `trail_stop ${(trailPct * 100).toFixed(0)}% after partial TP`,
      );
    }
    if (ageHours >= opts.maxHoldHours) {
      return closeByTotal(next, now, `time-stop ${opts.maxHoldHours}h (after partial TP)`);
    }
    return next;
  }

  if (unrealizedPnlPct >= opts.winPct) {
    const frac = opts.partialTpFraction ?? 0;
    if (frac > 0 && frac < 1 && (opts.trailPct ?? 0) > 0) {
      const soldQty = pos.quantity * frac;
      const keepQty = pos.quantity - soldQty;
      const partialPnl = (markPriceUsd - pos.entryPriceUsd) * soldQty;
      return {
        ...next,
        quantity: keepQty,
        sizeUsd: pos.sizeUsd * (1 - frac),
        originalSizeUsd: pos.originalSizeUsd ?? pos.sizeUsd,
        originalQuantity: pos.originalQuantity ?? pos.quantity,
        partialTakenAt: markAt,
        partialRealizedPnlUsd: (pos.partialRealizedPnlUsd ?? 0) + partialPnl,
        trailPeakPriceUsd: markPriceUsd,
        unrealizedPnlUsd: (markPriceUsd - pos.entryPriceUsd) * keepQty,
      };
    }
    return closePosition(next, now, "closed_win", `TP +${(opts.winPct * 100).toFixed(0)}%`);
  }
  // Learning 2026-09-23 ~04:50 MDT: soft SL inside open-grace skipped — pumpfun/Dex
  // quote flicker at entry must not crystallize as plain SL −15%.
  // Learning 2026-09-24 ~09:53 MDT: MOONIMALS −39% / DUEL −19% same-cycle open-grace
  // skip froze MTM at 0% and held a proven $75 bag through a rug_gap dump. Soft SL
  // (−lossPct … −2×) still waits out grace; rug_gap (≥2× lossPct) exits immediately
  // even inside grace so GREEF/GO-class dumps do not sit for 5m on oversized bags.
  const softStop = unrealizedPnlPct <= -opts.lossPct;
  if (softStop && (ageMs >= OPEN_MARK_GRACE_MS || gapPastStop)) {
    // Learning 2026-09-23 ~13:00 MDT: EPEP/metcat marked through after asymmetric
    // sanity at −90%+ but labeled plain "SL -15%". Keep honest mark fill; when the
    // gap is ≥2× the stop band, tag rug_gap so SL-rule scoring is not polluted.
    const reason = gapPastStop
      ? `rug_gap past ${slLabel}`
      : slLabel;
    return closePosition(next, now, "closed_loss", reason);
  }
  if (ageHours >= opts.maxHoldHours) {
    return closePosition(
      next,
      now,
      "closed_time",
      `time-stop ${opts.maxHoldHours}h`,
    );
  }
  return next;
}

/** Close using total (partial + remainder) PnL sign for status. */
function closeByTotal(
  pos: PaperCopyPosition,
  now: Date,
  reason: string,
): PaperCopyPosition {
  const total =
    (pos.markPriceUsd - pos.entryPriceUsd) * pos.quantity +
    (pos.partialRealizedPnlUsd ?? 0);
  const status = total > 0 ? "closed_win" : total < 0 ? "closed_loss" : "closed_time";
  return closePosition(pos, now, status, reason);
}

/** Bucket a close reason for learning analysis. */
export function exitBucketOf(closeReason?: string): string {
  const r = (closeReason ?? "").toLowerCase();
  if (r.startsWith("scrub_")) return "scrub";
  if (r.includes("rug_gap")) return "rug_gap";
  if (r.startsWith("trail_stop")) return "trail_after_partial";
  if (r.startsWith("tp")) return "tp";
  if (r.startsWith("sl")) return "sl";
  if (r.startsWith("time-stop")) return r.includes("partial") ? "time_after_partial" : "time_stop";
  if (r.startsWith("source_sell_follow")) return "source_sell";
  if (r.startsWith("mark_unavailable")) return "mark_unavailable";
  return r ? "other" : "unknown";
}

export function closePosition(
  pos: PaperCopyPosition,
  now: Date,
  status: "closed_win" | "closed_loss" | "closed_time",
  reason: string,
): PaperCopyPosition {
  const realizedPnlUsd =
    (pos.markPriceUsd - pos.entryPriceUsd) * pos.quantity +
    (pos.partialRealizedPnlUsd ?? 0);
  const basis = pos.originalSizeUsd ?? pos.sizeUsd;
  const learning = pos.learning
    ? {
        ...pos.learning,
        holdMinutes: Math.max(
          0,
          (now.getTime() - Date.parse(pos.openedAt)) / 60_000,
        ),
        exitBucket: exitBucketOf(reason),
        realizedPnlPct: basis > 0 ? realizedPnlUsd / basis : 0,
      }
    : undefined;
  return {
    ...pos,
    status,
    closedAt: now.toISOString(),
    closeReason: reason,
    realizedPnlUsd,
    unrealizedPnlUsd: 0,
    ...(learning ? { learning } : {}),
  };
}

/**
 * Pure cash delta when a position transitions prev → next (mark, partial TP,
 * close). Handles partial-TP legs: the sold fraction's cost + PnL returns on
 * the partial; the final close returns remaining cost + remainder PnL only.
 */
export function settleCashDelta(
  prev: PaperCopyPosition,
  next: PaperCopyPosition,
): number {
  if (prev.status !== "open") return 0;
  const partialPrev = prev.partialRealizedPnlUsd ?? 0;
  const partialNext = next.partialRealizedPnlUsd ?? 0;
  let delta = prev.sizeUsd - next.sizeUsd + (partialNext - partialPrev);
  if (next.status !== "open") {
    delta += next.sizeUsd + (next.realizedPnlUsd ?? 0) - partialNext;
  }
  return delta;
}

export function alreadyCopied(
  seenSignatures: Iterable<string>,
  signature: string,
): boolean {
  for (const s of seenSignatures) {
    if (s === signature) return true;
  }
  return false;
}


export function isSkippedNonMeme(
  mint: string,
  symbol?: string | null,
  tokenName?: string | null,
): boolean {
  if (SKIP_MINTS.has(mint)) return true;
  if (symbol) {
    const sym = symbol.toUpperCase();
    // Dex often prefixes majors with "$" (e.g. $WIF); match both forms.
    if (SKIP_SYMBOLS.has(sym) || SKIP_SYMBOLS.has(sym.replace(/^\$/, ""))) return true;
  }
  if (tokenName && SKIP_NAME_PATTERN.test(tokenName)) return true;
  return false;
}

/** Agent-forced scrub closes are not market performance — exclude from bleed gate. */
export function isAgentScrubClose(p: { closeReason?: string }): boolean {
  const reason = (p.closeReason ?? "").toLowerCase();
  return reason.startsWith("scrub_");
}

/**
 * Closes that put a mint on the re-entry cool-down.
 * Learning 2026-09-24 ~09:02 MDT: scrub_prefer_better_unproven vacated passthedutcher
 * GP (−$1.77) for virgin-then-rugged onlyljc GREEF (−$22); next cycle re-opened the
 * same GP mint because only SL/time-stop triggered cool-down. Prefer-scrubs leave a
 * mint on purpose — do not re-copy it within MAX_HOLD. Other scrub_* (excess /
 * inactive / non-meme / cooldown scrub itself) still free slots without cooling.
 */
export function triggersMintCooldown(p: {
  status: string;
  closeReason?: string;
}): boolean {
  if (p.status === "closed_loss") return true;
  if (p.status !== "closed_time") return false;
  const reason = (p.closeReason ?? "").toLowerCase();
  return reason.startsWith("time-stop") || reason.startsWith("scrub_prefer");
}

/**
 * Sum realized PnL from market closes only (excludes scrub_*).
 * Learning 2026-09-23 ~20:54 MDT: proven sizing / unproven-slot classification
 * still counted scrub_* PnL after the bleed-gate fix — a scrub-only +$ wallet
 * could falsely get COPY_SIZE_PROVEN_USD. Align all three gates.
 */
export function marketClosedRealizedUsd(
  book: CopyBookState,
  sourceWallet: string,
): number {
  return book.positions
    .filter(
      (p) =>
        p.sourceWallet === sourceWallet &&
        p.status !== "open" &&
        !isAgentScrubClose(p),
    )
    .reduce((s, p) => s + (p.realizedPnlUsd ?? 0), 0);
}

/** Market closes on this book for a wallet (excludes scrub_*). */
export function hasMarketClosesOnBook(
  book: CopyBookState,
  sourceWallet: string,
): boolean {
  return book.positions.some(
    (p) =>
      p.sourceWallet === sourceWallet &&
      p.status !== "open" &&
      !isAgentScrubClose(p),
  );
}

/** Market-close win count for explorer ranking (excludes scrub_*). */
export function marketClosedWins(
  book: CopyBookState,
  sourceWallet: string,
): number {
  return book.positions.filter(
    (p) =>
      p.sourceWallet === sourceWallet &&
      p.status !== "open" &&
      !isAgentScrubClose(p) &&
      (p.realizedPnlUsd ?? 0) > 0,
  ).length;
}

export interface UnprovenExplorerScore {
  wins: number;
  realized: number;
  marketCloses: number;
}

/**
 * Rank unproven explorers for the single MAX_OPEN_UNPROVEN slot.
 * Learning 2026-09-24 ~06:53 MDT: passthedutcher (0W/1L) held GP in the only
 * explorer slot while CoinSmuggler (2W/2L mixed, demoted to $25) hit
 * max_open_unproven_total ×3. Prefer more market wins, then higher
 * marketClosedRealized — mixed printers outrank pure-loss explorers.
 * Learning 2026-09-24 ~08:06 MDT: virgin onlyljc (0 closes) scrubbed
 * passthedutcher GP (−$1.77) solely because 0 > −1.58 realized — churn with
 * no edge evidence. Score still ranks wins→realized; displace also requires
 * market-close evidence (see canDisplaceExplorer).
 */
export function unprovenExplorerScore(
  book: CopyBookState,
  sourceWallet: string,
): UnprovenExplorerScore {
  return {
    wins: marketClosedWins(book, sourceWallet),
    realized: marketClosedRealizedUsd(book, sourceWallet),
    marketCloses: book.positions.filter(
      (p) =>
        p.sourceWallet === sourceWallet &&
        p.status !== "open" &&
        !isAgentScrubClose(p),
    ).length,
  };
}

/** >0 if a is better, <0 if b is better, 0 if equal. */
export function compareExplorerScore(
  a: UnprovenExplorerScore,
  b: UnprovenExplorerScore,
): number {
  if (a.wins !== b.wins) return a.wins - b.wins;
  if (a.realized !== b.realized) return a.realized - b.realized;
  return 0;
}

/**
 * Learning 2026-09-24 ~08:06 MDT: only scrub the explorer slot for a buyer that
 * both ranks higher AND has ≥1 market close (win or loss). Zero-sample virgins
 * must wait for a free slot instead of crystallizing mark losses on holders.
 */
export function canDisplaceExplorer(
  buyer: UnprovenExplorerScore,
  holder: UnprovenExplorerScore,
): boolean {
  return compareExplorerScore(buyer, holder) > 0 && buyer.marketCloses >= 1;
}

function scrubOpenById(
  book: CopyBookState,
  openId: string,
  now: Date,
  reason: string,
): CopyBookState {
  const pos = book.positions.find((p) => p.id === openId && p.status === "open");
  if (!pos) return book;
  const mark = pos.markPriceUsd > 0 ? pos.markPriceUsd : pos.entryPriceUsd;
  const marked: PaperCopyPosition = {
    ...pos,
    markPriceUsd: mark,
    markAt: now.toISOString(),
    unrealizedPnlUsd: (mark - pos.entryPriceUsd) * pos.quantity,
    unrealizedPnlPct:
      pos.entryPriceUsd > 0 ? (mark - pos.entryPriceUsd) / pos.entryPriceUsd : 0,
  };
  const done = closePosition(marked, now, "closed_time", reason);
  const cash = book.cashUsd + settleCashDelta(pos, done);
  return {
    ...book,
    positions: book.positions.map((p) => (p.id === openId ? done : p)),
    cashUsd: cash,
    updatedAt: now.toISOString(),
    notes: [
      ...book.notes,
      `${now.toISOString()}: ${reason} closed ${pos.sourceWalletLabel ?? pos.sourceWallet.slice(0, 6)}:${pos.symbol ?? pos.mint.slice(0, 8)} to free unproven slot for stronger explorer`,
    ],
  };
}


/**
 * Proven = net+ closed on THIS book, or prior-book seed until this book has
 * market closes for that wallet (bankroll restart carry-forward).
 */
export function isProvenPrinter(
  book: CopyBookState,
  sourceWallet: string,
  policy: CopyPolicy = getActivePolicy(),
): boolean {
  // Learning auto-tune (≥20 learning closes) overrides the raw rule.
  if (policy.name === "learning" && book.learningTuning) {
    if (suspendedWallets(book).includes(sourceWallet)) return false;
    if (book.learningTuning.promoted.includes(sourceWallet)) return true;
  }
  if (hasMarketClosesOnBook(book, sourceWallet)) {
    const closes = unprovenExplorerScore(book, sourceWallet).marketCloses;
    return (
      closes >= policy.provenMinCloses &&
      marketClosedRealizedUsd(book, sourceWallet) > 0
    );
  }
  return PROVEN_SEED_WALLETS.has(sourceWallet);
}

/** True when any wallet on this book currently qualifies as proven. */
export function hasAnyProvenPrinter(
  book: CopyBookState,
  policy: CopyPolicy = getActivePolicy(),
): boolean {
  const wallets = new Set<string>();
  for (const p of book.positions) wallets.add(p.sourceWallet);
  for (const w of PROVEN_SEED_WALLETS) wallets.add(w);
  for (const w of wallets) {
    if (isProvenPrinter(book, w, policy)) return true;
  }
  return false;
}

function isTpCloseReason(closeReason?: string): boolean {
  return (closeReason ?? "").toUpperCase().startsWith("TP");
}

function isRugGapCloseReason(closeReason?: string): boolean {
  return (closeReason ?? "").toLowerCase().includes("rug_gap");
}

/**
 * Proven $75 sizing only when net+ AND no recent TP/rug_gap close on that wallet.
 * Learning 2026-09-24 ~11:21 MDT: after TP or rug_gap, next opens use $25 for
 * PROVEN_SIZE_COOLDOWN_MS so a hot printer cannot immediately reload full size
 * into the next bag (cap SDOG→MOONIMALS; CoinSmuggler OTC→GO).
 */
export function shouldUseProvenSize(
  book: CopyBookState,
  sourceWallet: string,
  now = new Date(),
  cooldownMs = getActivePolicy().provenSizeCooldownMs,
  policy: CopyPolicy = getActivePolicy(),
): boolean {
  if (!isProvenPrinter(book, sourceWallet, policy)) return false;
  const cutoff = now.getTime() - cooldownMs;
  for (const p of book.positions) {
    if (p.sourceWallet !== sourceWallet || p.status === "open" || !p.closedAt) {
      continue;
    }
    if (isAgentScrubClose(p)) continue;
    const t = Date.parse(p.closedAt);
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (isTpCloseReason(p.closeReason) || isRugGapCloseReason(p.closeReason)) {
      return false;
    }
  }
  return true;
}

export function openPositionCount(book: CopyBookState): number {
  return book.positions.filter((p) => p.status === "open").length;
}

/** Entry context captured by resolveEntryPrice for learning features. */
export interface EntryContext {
  txEntryPriceUsd: number | null;
  liveEntryPriceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  createdAtMs: number | null;
  tokenName?: string | null;
  /** % supply in top-10 token accounts (RPC best effort; includes pool accounts). */
  top10HolderPct?: number | null;
  /** Holder count — no cheap source today; always null unless a venue provides it. */
  holderCount?: number | null;
}

export interface OpenCopyOpts {
  policy?: CopyPolicy;
  /** Per-wallet hard cap (e.g. re-admitted bleeders at $10). */
  sizeCapUsd?: number;
  entryContext?: EntryContext;
}

export function buildLearningFeatures(
  policy: CopyPolicy,
  walletTier: "proven" | "explorer",
  buy: WalletBuyEvent,
  entryPriceUsd: number,
  ctx: EntryContext | undefined,
  now: Date,
): LearningFeatures {
  const tx = ctx?.txEntryPriceUsd ?? buy.entryPriceUsd ?? null;
  const live = ctx?.liveEntryPriceUsd ?? null;
  const ref = live ?? entryPriceUsd;
  // Band-fail (tx mis-attribution, e.g. CORGI tx 5e-8 vs live 4.3e-6) → the tx
  // price is a phantom; record it but do not score it as slippage.
  const slip =
    tx != null && tx > 0 && ref > 0 && !liveDisagreesWithTxEntry(ref / tx)
      ? (ref - tx) / tx
      : null;
  const created = ctx?.createdAtMs ?? null;
  return {
    policy: policy.name,
    walletTier,
    entryMcapUsd: ctx?.mcapUsd ?? null,
    entryLiquidityUsd: ctx?.liquidityUsd ?? null,
    tokenAgeMinutes:
      created != null && created > 0
        ? Math.max(0, (now.getTime() - created) / 60_000)
        : null,
    txEntryPriceUsd: tx,
    liveEntryPriceUsd: live,
    entrySlippagePct: slip,
    signalLagSec:
      buy.blockTime != null
        ? Math.max(0, now.getTime() / 1000 - buy.blockTime)
        : null,
    peakPnlPct: 0,
    troughPnlPct: 0,
    top10HolderPct: ctx?.top10HolderPct ?? null,
    holderCount: ctx?.holderCount ?? null,
  };
}

export interface OpenCopyResult {
  book: CopyBookState;
  opened: PaperCopyPosition | null;
  skipReason?: string;
}

/**
 * Open a paper copy at an honest live/entry mark.
 * Dedupes by source signature. Spends cash from the paper bankroll.
 */
export function openPaperCopy(
  book: CopyBookState,
  buy: WalletBuyEvent,
  entryPriceUsd: number,
  entryPriceSource: PaperCopyPosition["entryPriceSource"],
  symbol: string | undefined,
  now = new Date(),
  opts: OpenCopyOpts = {},
): OpenCopyResult {
  const policy = opts.policy ?? getActivePolicy();
  if (alreadyCopied(book.seenSignatures, buy.signature)) {
    return { book, opened: null, skipReason: "already_copied_tx" };
  }
  if (isSkippedNonMeme(buy.mint, symbol, opts.entryContext?.tokenName)) {
    const seen = uniquePush(book.seenSignatures, buy.signature);
    return {
      book: { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
      opened: null,
      skipReason: "skip_non_meme",
    };
  }
  // Dollar-priced majors / bad Dex quotes (HYPE @$88) — not pump.fun meme learning.
  if (Number.isFinite(entryPriceUsd) && entryPriceUsd >= SKIP_MAX_ENTRY_PRICE_USD) {
    const seen = uniquePush(book.seenSignatures, buy.signature);
    return {
      book: { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
      opened: null,
      skipReason: "skip_non_meme",
    };
  }
  // Global mint dedupe: one open bag per mint across all wallets (correlated copies burn cash).
  const openSameMint = book.positions.find(
    (p) => p.status === "open" && p.mint === buy.mint,
  );
  if (openSameMint) {
    const seen = uniquePush(book.seenSignatures, buy.signature);
    return {
      book: { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
      opened: null,
      skipReason: "already_open_same_mint",
    };
  }
  // Cool-down after SL, time-stop, or scrub_prefer on this mint (avoid immediate
  // re-entry). Other scrub_* (inactive / non-meme / excess) do not trigger —
  // those free slots on purpose without cooling the mint.
  const recentCut = book.positions.find((p) => {
    if (p.mint !== buy.mint || !p.closedAt) return false;
    if (!triggersMintCooldown(p)) return false;
    const age = now.getTime() - Date.parse(p.closedAt);
    return Number.isFinite(age) && age >= 0 && age < policy.mintCooldownMs;
  });
  if (recentCut) {
    const seen = uniquePush(book.seenSignatures, buy.signature);
    return {
      book: { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
      opened: null,
      skipReason: "recent_sl_mint_cooldown",
    };
  }
  // Learning 2026-09-23 ~13:00 MDT: gr3gor14n 0/5 closed −$61 still opened CATWO
  // same cycle as EPEP rug. After ≥3 closed copies, stop spraying a net-negative
  // source (explore with thin samples; cut clear bleeders automatically).
  // Learning 2026-09-23 ~14:00 MDT: TylerD 2/2 SL (−$16) still opened SALLY because
  // gate was ≥3 — DecentralizeDie pattern repeats at n=2. Tighten to ≥2 closed net−.
  // Learning 2026-09-23 ~19:51 MDT: passthedutcher hit wallet_paper_bleed after 2
  // scrub_excess_unproven closes (agent-forced when MAX_OPEN_UNPROVEN tightened;
  // market net ~$0) — 5 buys/cycle skipped. Count only market closes (not scrub_*).
  // Learning 2026-09-24 ~05:56 MDT: CoinSmuggler flipped net− (−$12.88) after GO
  // rug despite 2W/2L. Old gate (≥2 closes + net<0) permanently banned a mixed
  // printer that isProvenPrinter already demotes to $25. Bleed only pure-loss
  // streaks (0 market wins) or deep net bleed (≤ −$40) — mixed printers stay
  // eligible at unproven size.
  const closedFromWallet = book.positions.filter(
    (p) =>
      p.sourceWallet === buy.walletAddress &&
      p.status !== "open" &&
      !isAgentScrubClose(p),
  );
  // Learning mode 2026-09-24 ~15:40 MDT: $10 explorers need a real sample —
  // pure-loss ban waits for policy.bleedMinCloses (4) market closes; deep
  // bleed at policy.deepBleedUsd (−$40). Auto-demote (≥20 closes) also blocks.
  // 2026-09-28 ~21:00 MDT: auto-demote → SUSPENSION. Suspended wallets stay polled;
  // their buys become shadow trades (never touch cash) so they can earn their way back.
  if (
    policy.name === "learning" &&
    suspendedWallets(book).includes(buy.walletAddress)
  ) {
    const seen = uniquePush(book.seenSignatures, buy.signature);
    const shadowed = addShadowTrade(
      { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
      buy, entryPriceUsd, entryPriceSource, symbol, now, policy, opts,
      "suspended_wallet", "learning_suspended_wallet",
    );
    return { book: shadowed, opened: null, skipReason: "learning_suspended_wallet" };
  }
  // Learning mode (2026-09-28): the pure-loss / deep bleed ban is judged on the
  // same qualifying closes as suspension (no scrub / mark_unavailable / outage-held),
  // and the pure-loss arm is retired — suspension (≥12 qualifying closes) owns that call.
  const bleedCloses =
    policy.name === "learning"
      ? closedFromWallet.filter((p) => !p.learning || isQualifyingLearningClose(p))
      : closedFromWallet;
  if (policy.name === "learning") {
    const netQ = bleedCloses.reduce((s, p) => s + (p.realizedPnlUsd ?? 0), 0);
    if (bleedCloses.length >= 2 && netQ <= policy.deepBleedUsd) {
      const seen = uniquePush(book.seenSignatures, buy.signature);
      return {
        book: { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
        opened: null,
        skipReason: "wallet_paper_bleed",
      };
    }
  } else if (closedFromWallet.length >= 2) {
    const netClosed = closedFromWallet.reduce(
      (s, p) => s + (p.realizedPnlUsd ?? 0),
      0,
    );
    const marketWins = closedFromWallet.filter(
      (p) => (p.realizedPnlUsd ?? 0) > 0,
    ).length;
    const pureLossBleed =
      marketWins === 0 &&
      netClosed < 0 &&
      closedFromWallet.length >= policy.bleedMinCloses;
    const deepNetBleed = netClosed <= policy.deepBleedUsd;
    if (pureLossBleed || deepNetBleed) {
      const seen = uniquePush(book.seenSignatures, buy.signature);
      return {
        book: { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
        opened: null,
        skipReason: "wallet_paper_bleed",
      };
    }
  }
  const openFromWallet = book.positions.filter(
    (p) => p.status === "open" && p.sourceWallet === buy.walletAddress,
  ).length;
  if (openFromWallet >= policy.maxOpenPerWallet) {
    const seen = uniquePush(book.seenSignatures, buy.signature);
    return {
      book: { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
      opened: null,
      skipReason: "max_open_per_wallet",
    };
  }
  // Learning 2026-09-23 ~15:00 MDT: concentrate on proven printers — cap total
  // open copies from unproven sources (wallet closed realized ≤ 0). Proven
  // (net+ closed) opens do not count against this budget.
  // Learning 2026-09-24 ~06:53 MDT: when the sole explorer slot is held by a
  // weaker unproven (fewer market wins / worse realized), scrub it so a
  // stronger mixed printer can take the $25 slot (scrub_prefer_better_unproven).
  // Learning 2026-09-24 ~08:06 MDT: buyer must also have ≥1 market close —
  // virgins no longer displace slight-loss holders (onlyljc vs GP churn).
  // Learning 2026-09-24 ~11:21 MDT: with ZERO this-book proven printers, do not
  // spray the $25 explorer slot into cold virgins (onlyljc GREEF −$22). Require
  // ≥1 this-book market win so only wallets with TP history (cap / CoinSmuggler
  // demoted-but-won) can refill while rebuilding a printer.
  // Learning mode: explorer_needs_this_book_win + displacement are OFF so
  // virgin wallets can trade at $10 (policy.requireBookWinForExplorer /
  // allowExplorerDisplace false); cap is policy.maxOpenUnprovenTotal (12 as of 2026-09-28).
  if (!isProvenPrinter(book, buy.walletAddress, policy)) {
    if (
      policy.requireBookWinForExplorer &&
      !hasAnyProvenPrinter(book, policy) &&
      marketClosedWins(book, buy.walletAddress) === 0
    ) {
      const seen = uniquePush(book.seenSignatures, buy.signature);
      return {
        book: { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
        opened: null,
        skipReason: "explorer_needs_this_book_win",
      };
    }
    let unprovenOpens = book.positions.filter((p) => {
      if (p.status !== "open") return false;
      return !isProvenPrinter(book, p.sourceWallet, policy);
    });
    if (unprovenOpens.length >= policy.maxOpenUnprovenTotal) {
      const buyerScore = unprovenExplorerScore(book, buy.walletAddress);
      let worst = unprovenOpens[0]!;
      let worstScore = unprovenExplorerScore(book, worst.sourceWallet);
      for (const p of unprovenOpens.slice(1)) {
        const s = unprovenExplorerScore(book, p.sourceWallet);
        const cmp = compareExplorerScore(s, worstScore);
        if (cmp < 0) {
          worst = p;
          worstScore = s;
        } else if (cmp === 0) {
          const uWorst = worst.unrealizedPnlUsd ?? 0;
          const uP = p.unrealizedPnlUsd ?? 0;
          if (
            uP < uWorst ||
            (uP === uWorst && Date.parse(p.openedAt) < Date.parse(worst.openedAt))
          ) {
            worst = p;
            worstScore = s;
          }
        }
      }
      if (
        policy.allowExplorerDisplace &&
        canDisplaceExplorer(buyerScore, worstScore)
      ) {
        book = scrubOpenById(
          book,
          worst.id,
          now,
          "scrub_prefer_better_unproven",
        );
        unprovenOpens = book.positions.filter((p) => {
          if (p.status !== "open") return false;
          return !isProvenPrinter(book, p.sourceWallet, policy);
        });
      }
      if (unprovenOpens.length >= policy.maxOpenUnprovenTotal) {
        const seen = uniquePush(book.seenSignatures, buy.signature);
        return {
          book: { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
          opened: null,
          skipReason: "max_open_unproven_total",
        };
      }
    }
  }
  if (openPositionCount(book) >= policy.maxOpenPositions) {
    const seen = uniquePush(book.seenSignatures, buy.signature);
    return {
      book: { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
      opened: null,
      skipReason: "max_open_positions",
    };
  }

  // 2026-09-28 ~21:00 MDT entry rug filter: age < 30m AND mcap ≥ $15k AND liq < $100k
  // (8/8 deep rugs, 0 winners in-sample). Checked last so the shadow trade is a true
  // "would have copied". Shadow is marked like a real bag but never touches cash.
  {
    const probe = buildLearningFeatures(policy, "explorer", buy, entryPriceUsd, opts.entryContext, now);
    if (matchesRugProfile(probe)) {
      const seen = uniquePush(book.seenSignatures, buy.signature);
      const shadowed = addShadowTrade(
        { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
        buy, entryPriceUsd, entryPriceSource, symbol, now, policy, opts,
        "rug_filter", "rug_filter_fresh_thin_pool",
      );
      return { book: shadowed, opened: null, skipReason: "rug_filter_fresh_thin_pool" };
    }
  }

  // Overweight proven printers (this-book net+ or prior-book seed), but
  // suspend $75 after a recent TP/rug_gap close on that wallet (confirm at $25).
  const provenSize = shouldUseProvenSize(
    book,
    buy.walletAddress,
    now,
    policy.provenSizeCooldownMs,
    policy,
  );
  let targetSize = provenSize ? policy.provenSizeUsd : policy.explorerSizeUsd;
  if (opts.sizeCapUsd != null && opts.sizeCapUsd > 0) {
    targetSize = Math.min(targetSize, opts.sizeCapUsd);
  }
  // 2026-09-29 young/thin size cap: age < 60m AND liq < $100k never exceeds the
  // $10 explorer size, even for a proven wallet (p/acc rug −$49 at $50).
  let sizeCapTag: string | undefined;
  {
    const probe = buildLearningFeatures(policy, "explorer", buy, entryPriceUsd, opts.entryContext, now);
    if (matchesYoungThinPool(probe) && targetSize > YOUNG_THIN_SIZE_CAP_USD) {
      sizeCapTag = `${SIZE_CAP_YOUNG_THIN_TAG}: $${targetSize}→$${YOUNG_THIN_SIZE_CAP_USD}`;
      targetSize = YOUNG_THIN_SIZE_CAP_USD;
    }
  }
  // Bigger-bags liquidity tiers (2026-09-29): $25 explorer needs liq ≥ $20k, proven
  // $60 needs liq ≥ $50k; thinner (or unrecorded, when a venue context exists) pools
  // step down a tier toward the $10 base. Never raises a size.
  if (policy.liquidityTieredSizing && opts.entryContext) {
    const liq = opts.entryContext.liquidityUsd;
    const known = liq != null && Number.isFinite(liq);
    let liqCap = Infinity;
    if (!known) liqCap = BASE_SIZE_USD;
    else if (liq! < EXPLORER_BIG_MIN_LIQ_USD) liqCap = BASE_SIZE_USD;
    else if (liq! < PROVEN_BIG_MIN_LIQ_USD) liqCap = policy.explorerSizeUsd;
    if (targetSize > liqCap) {
      const tag = `${SIZE_CAP_THIN_LIQ_TAG}: $${targetSize}→$${liqCap}`;
      sizeCapTag = sizeCapTag ? `${sizeCapTag}; ${tag}` : tag;
      targetSize = liqCap;
    }
  }
  // Total open exposure ceiling (fraction of equity); shrink to the room left or skip.
  if (policy.maxExposurePctOfEquity < 1) {
    const eq = equityOf(book).equityUsd;
    const openCost = book.positions
      .filter((p) => p.status === "open")
      .reduce((s, p) => s + p.sizeUsd, 0);
    const room = eq * policy.maxExposurePctOfEquity - openCost;
    if (room < Math.min(MIN_EXPOSURE_ROOM_USD, targetSize)) {
      const seen = uniquePush(book.seenSignatures, buy.signature);
      return {
        book: { ...book, seenSignatures: seen, updatedAt: now.toISOString() },
        opened: null,
        skipReason: "max_open_exposure",
      };
    }
    if (targetSize > room) {
      const tag = `exposure_cap: $${targetSize}→$${Math.floor(room)}`;
      sizeCapTag = sizeCapTag ? `${sizeCapTag}; ${tag}` : tag;
      targetSize = Math.floor(room);
    }
  }
  const size = sizeForCopy(book.cashUsd, targetSize);
  if (size == null) {
    return { book, opened: null, skipReason: "insufficient_cash" };
  }
  if (!(entryPriceUsd > 0) || !Number.isFinite(entryPriceUsd)) {
    return { book, opened: null, skipReason: "no_honest_entry_price" };
  }

  const quantity = size / entryPriceUsd;
  const pos: PaperCopyPosition = {
    id: randomUUID(),
    openedAt: now.toISOString(),
    sourceWallet: buy.walletAddress,
    sourceWalletLabel: buy.walletLabel,
    sourceSignature: buy.signature,
    mint: buy.mint,
    symbol,
    sizeUsd: size,
    entryPriceUsd,
    entryPriceSource,
    quantity,
    markPriceUsd: entryPriceUsd,
    markSource: entryPriceSource,
    markAt: now.toISOString(),
    unrealizedPnlUsd: 0,
    unrealizedPnlPct: 0,
    status: "open",
    ...(sizeCapTag ? { sizeCapTag } : {}),
    learning: buildLearningFeatures(
      policy,
      provenSize ? "proven" : "explorer",
      buy,
      entryPriceUsd,
      opts.entryContext,
      now,
    ),
  };

  return {
    book: {
      ...book,
      cashUsd: book.cashUsd - size,
      positions: [...book.positions, pos],
      seenSignatures: uniquePush(book.seenSignatures, buy.signature),
      updatedAt: now.toISOString(),
    },
    opened: pos,
  };
}

/**
 * Append a SHADOW trade (hypothetical copy at explorer size) to book.shadowPositions.
 * Never changes cashUsd / positions. One open shadow per mint; capped at
 * MAX_OPEN_SHADOW_POSITIONS open shadows (extra candidates are just not logged).
 */
export function addShadowTrade(
  book: CopyBookState,
  buy: WalletBuyEvent,
  entryPriceUsd: number,
  entryPriceSource: PaperCopyPosition["entryPriceSource"],
  symbol: string | undefined,
  now: Date,
  policy: CopyPolicy,
  opts: OpenCopyOpts,
  reason: "rug_filter" | "suspended_wallet",
  skipReason: string,
): CopyBookState {
  if (!(entryPriceUsd > 0) || !Number.isFinite(entryPriceUsd)) return book;
  const shadows = book.shadowPositions ?? [];
  if (shadows.some((p) => p.sourceSignature === buy.signature)) return book;
  const open = shadows.filter((p) => p.status === "open");
  if (open.some((p) => p.mint === buy.mint)) return book;
  if (open.length >= MAX_OPEN_SHADOW_POSITIONS) return book;
  // Shadows stay at the $10 base (young/thin candidates would be capped there anyway) so
  // shadow-vs-real validation data stays comparable across the 2026-09-29 size change.
  let size = Math.min(policy.explorerSizeUsd, BASE_SIZE_USD);
  if (opts.sizeCapUsd != null && opts.sizeCapUsd > 0) size = Math.min(size, opts.sizeCapUsd);
  const pos: PaperCopyPosition = {
    id: randomUUID(),
    openedAt: now.toISOString(),
    sourceWallet: buy.walletAddress,
    sourceWalletLabel: buy.walletLabel,
    sourceSignature: buy.signature,
    mint: buy.mint,
    symbol,
    sizeUsd: size,
    entryPriceUsd,
    entryPriceSource,
    quantity: size / entryPriceUsd,
    markPriceUsd: entryPriceUsd,
    markSource: entryPriceSource,
    markAt: now.toISOString(),
    unrealizedPnlUsd: 0,
    unrealizedPnlPct: 0,
    status: "open",
    learning: buildLearningFeatures(policy, "explorer", buy, entryPriceUsd, opts.entryContext, now),
    shadow: { reason, skipReason },
  };
  return { ...book, shadowPositions: [...shadows, pos] };
}

/**
 * Mark open shadow trades with the same exit rules as real bags. Cash/equity of
 * the real book are untouched (markBook runs on a detached copy with cash 0).
 */
export async function markShadowBook(
  book: CopyBookState,
  now = new Date(),
  policy: CopyPolicy = getActivePolicy(),
): Promise<{ book: CopyBookState; closed: number; blockers: string[] }> {
  const shadows = book.shadowPositions ?? [];
  if (!shadows.some((p) => p.status === "open")) return { book, closed: 0, blockers: [] };
  const detached: CopyBookState = { ...book, positions: shadows, cashUsd: 0 };
  const r = await markBook(detached, now, policy);
  return {
    book: { ...book, shadowPositions: r.book.positions },
    closed: r.closed,
    blockers: r.blockers.map((b) => `shadow: ${b}`),
  };
}

function uniquePush(list: string[], sig: string): string[] {
  if (list.includes(sig)) return list;
  const next = [...list, sig];
  // Cap memory
  if (next.length > 5_000) return next.slice(-4_000);
  return next;
}

/** applyMark options for a book under a policy (partial TP + trail in learning). */
export function markOpts(
  book: CopyBookState,
  policy: CopyPolicy = getActivePolicy(),
): ApplyMarkOpts {
  return {
    winPct: book.winPct,
    lossPct: book.lossPct,
    maxHoldHours: book.maxHoldHours,
    partialTpFraction: policy.partialTpFraction,
    trailPct: policy.trailPct,
  };
}

export async function markBook(
  book: CopyBookState,
  now = new Date(),
  policy: CopyPolicy = getActivePolicy(),
): Promise<{ book: CopyBookState; closed: number; blockers: string[] }> {
  const blockers: string[] = [];
  const positions: PaperCopyPosition[] = [];
  let closed = 0;
  let cash = book.cashUsd;

  for (const pos of book.positions) {
    if (pos.status !== "open") {
      positions.push(pos);
      continue;
    }
    await sleep(150);
    const quote = await getTokenPriceUsd(pos.mint);
    if (!quote) {
      const ageHours =
        (now.getTime() - new Date(pos.openedAt).getTime()) / 3_600_000;
      const neverLiveMarked = !LIVE_MARK_SOURCES.has(pos.markSource);
      // Dead/rugged mints return null forever; holding at entry ≈ fake 0% PnL.
      if (neverLiveMarked && ageHours >= MARK_UNAVAILABLE_HOURS) {
        const done = closePosition(
          pos,
          now,
          "closed_time",
          `mark_unavailable ${MARK_UNAVAILABLE_HOURS}h`,
        );
        closed++;
        cash += settleCashDelta(pos, done);
        blockers.push(
          `mark_unavailable closed ${pos.symbol ?? pos.mint.slice(0, 8)}… ` +
            `(no live mark after ${ageHours.toFixed(1)}h)`,
        );
        positions.push(done);
        continue;
      }
      // Learning 2026-09-23 ~03:45 MDT: mark miss on cashmaxing Z9b… left a
      // +16% live-marked bag stuck open past new TP +12%. If we already have a
      // live venue mark, re-apply TP/SL/time on that last mark instead of skipping.
      if (LIVE_MARK_SOURCES.has(pos.markSource) && pos.markPriceUsd > 0) {
        blockers.push(
          `mark miss ${pos.symbol ?? pos.mint.slice(0, 8)}… ` +
            `(reusing last ${pos.markSource} mark for TP/SL)`,
        );
        const marked = applyMark(
          pos,
          pos.markPriceUsd,
          pos.markSource,
          now,
          markOpts(book, policy),
        );
        if (marked.status !== "open") closed++;
        cash += settleCashDelta(pos, marked);
        positions.push(marked);
        continue;
      }
      blockers.push(`mark miss ${pos.symbol ?? pos.mint.slice(0, 8)}…`);
      positions.push(pos);
      continue;
    }
    // Reject upside spikes only (e.g. Dex pair quoting SOL ~$130 for a meme).
    // 2026-09-23 ~12:05 MDT: accept downside crashes (EPEP ratio 0.01 was
    // freezing bags at fake 0% under the old symmetric band). Open-grace still
    // blocks same-window SL flicker (FAP-class).
    const ratio =
      pos.entryPriceUsd > 0 ? quote.priceUsd / pos.entryPriceUsd : Infinity;
    if (!isAcceptableLiveMarkRatio(ratio)) {
      blockers.push(
        `mark rejected ${pos.symbol ?? pos.mint.slice(0, 8)}… ` +
          `(${quote.source} $${quote.priceUsd} vs entry $${pos.entryPriceUsd}; ratio ${ratio.toFixed(2)})`,
      );
      positions.push(pos);
      continue;
    }
    // Same-cycle open-grace: still apply live MTM. Soft SL closes stay deferred
    // inside applyMark; rug_gap (≥2× lossPct) is allowed through immediately
    // (2026-09-24 ~09:53 MDT — MOONIMALS −39% was skipped entirely, fake 0% MTM).
    const ageMsOpen =
      now.getTime() - new Date(pos.openedAt).getTime();
    const wouldSlPct =
      pos.entryPriceUsd > 0
        ? (quote.priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd
        : 0;
    if (
      ageMsOpen < OPEN_MARK_GRACE_MS &&
      wouldSlPct <= -book.lossPct &&
      wouldSlPct > -Math.max(RUG_GAP_PCT, book.lossPct)
    ) {
      blockers.push(
        `open-grace soft-SL MTM ${pos.symbol ?? pos.mint.slice(0, 8)}… ` +
          `(${(wouldSlPct * 100).toFixed(0)}% within ${OPEN_MARK_GRACE_MS / 60000}m of open; rug_gap still exits)`,
      );
      // Fall through to applyMark — soft SL will keep status open with honest MTM.
    }
    const marked = applyMark(
      pos,
      quote.priceUsd,
      quote.source,
      now,
      markOpts(book, policy),
    );
    if (marked.status !== "open") closed++;
    if (marked.partialTakenAt && !pos.partialTakenAt) {
      blockers.push(
        `partial TP ${pos.sourceWalletLabel}:${pos.symbol ?? pos.mint.slice(0, 8)} ` +
          `(+$${(marked.partialRealizedPnlUsd ?? 0).toFixed(2)} banked; remainder trails)`,
      );
    }
    // Return size + realized PnL (or partial-TP leg) to cash
    cash += settleCashDelta(pos, marked);
    positions.push(marked);
  }

  return {
    book: {
      ...book,
      positions,
      cashUsd: cash,
      updatedAt: now.toISOString(),
    },
    closed,
    blockers,
  };
}



/**
 * Exit-follow: when a tracked source wallet sells a mint we hold as an open
 * paper copy from that same wallet, close at sell-derived or last mark price.
 * Learning signal 2026-09-23: pure buy-copy + fixed TP/SL never exits when
 * the source dumps — bags bleed to SL. Copying the sell is the missing half.
 */
export function closeOnSourceSells(
  book: CopyBookState,
  sells: WalletSellEvent[],
  now = new Date(),
): { book: CopyBookState; closed: PaperCopyPosition[] } {
  if (!sells.length) return { book, closed: [] };

  // One sell event per (wallet, mint) — keep the latest by blockTime.
  const latest = new Map<string, WalletSellEvent>();
  for (const s of sells) {
    const key = `${s.walletAddress}|${s.mint}`;
    const prev = latest.get(key);
    if (!prev || (s.blockTime ?? 0) >= (prev.blockTime ?? 0)) {
      latest.set(key, s);
    }
  }

  const closed: PaperCopyPosition[] = [];
  let cash = book.cashUsd;
  const positions: PaperCopyPosition[] = [];
  const usedSellSigs = new Set<string>();

  for (const pos of book.positions) {
    if (pos.status !== "open") {
      positions.push(pos);
      continue;
    }
    const sell = latest.get(`${pos.sourceWallet}|${pos.mint}`);
    if (!sell) {
      positions.push(pos);
      continue;
    }

    let mark = pos.markPriceUsd > 0 ? pos.markPriceUsd : pos.entryPriceUsd;
    let markSource = pos.markSource || "last_mark";
    if (sell.exitPriceUsd != null && sell.exitPriceUsd > 0) {
      // Accept downside dumps; reject only upside spikes (same as markBook).
      const ratio =
        pos.entryPriceUsd > 0 ? sell.exitPriceUsd / pos.entryPriceUsd : Infinity;
      if (isAcceptableLiveMarkRatio(ratio)) {
        mark = sell.exitPriceUsd;
        markSource = "tx_sol_delta_sell";
      }
    }

    const marked: PaperCopyPosition = {
      ...pos,
      markPriceUsd: mark,
      markSource,
      markAt: now.toISOString(),
      unrealizedPnlUsd: (mark - pos.entryPriceUsd) * pos.quantity,
      unrealizedPnlPct:
        pos.entryPriceUsd > 0
          ? (mark - pos.entryPriceUsd) / pos.entryPriceUsd
          : 0,
    };
    const pnl = marked.unrealizedPnlUsd;
    const status: "closed_win" | "closed_loss" | "closed_time" =
      pnl > 0 ? "closed_win" : pnl < 0 ? "closed_loss" : "closed_time";
    const done = closePosition(
      marked,
      now,
      status,
      `source_sell_follow ${sell.walletLabel}`,
    );
    cash += settleCashDelta(pos, done);
    closed.push(done);
    positions.push(done);
    usedSellSigs.add(sell.signature);
  }

  if (!closed.length) return { book, closed };

  const seen = [...book.seenSignatures];
  for (const sig of usedSellSigs) {
    if (!seen.includes(sig)) seen.push(sig);
  }

  return {
    book: {
      ...book,
      positions,
      cashUsd: cash,
      seenSignatures: seen.length > 5_000 ? seen.slice(-4_000) : seen,
      updatedAt: now.toISOString(),
      notes: [
        ...book.notes,
        `${now.toISOString()}: exit-follow closed ${closed.length} open(s) on source sells`,
      ],
    },
    closed,
  };
}

/**
 * Close open paper positions that are stables/majors (invalid for meme learning).
 * Uses last mark (or entry) so cash returns honestly; $0 real money.
 */
export function scrubNonMemeOpens(
  book: CopyBookState,
  now = new Date(),
): { book: CopyBookState; closed: PaperCopyPosition[] } {
  const closed: PaperCopyPosition[] = [];
  let cash = book.cashUsd;
  const positions: PaperCopyPosition[] = [];
  for (const pos of book.positions) {
    const highEntry =
      Number.isFinite(pos.entryPriceUsd) &&
      pos.entryPriceUsd >= SKIP_MAX_ENTRY_PRICE_USD;
    if (
      pos.status !== "open" ||
      (!isSkippedNonMeme(pos.mint, pos.symbol) && !highEntry)
    ) {
      positions.push(pos);
      continue;
    }
    const mark = pos.markPriceUsd > 0 ? pos.markPriceUsd : pos.entryPriceUsd;
    const marked: PaperCopyPosition = {
      ...pos,
      markPriceUsd: mark,
      markAt: now.toISOString(),
      unrealizedPnlUsd: (mark - pos.entryPriceUsd) * pos.quantity,
      unrealizedPnlPct:
        pos.entryPriceUsd > 0 ? (mark - pos.entryPriceUsd) / pos.entryPriceUsd : 0,
    };
    const done = closePosition(
      marked,
      now,
      "closed_time",
      "scrub_non_meme_invalid_copy",
    );
    cash += settleCashDelta(pos, done);
    closed.push(done);
    positions.push(done);
  }
  if (!closed.length) return { book, closed };
  return {
    book: {
      ...book,
      positions,
      cashUsd: cash,
      updatedAt: now.toISOString(),
      notes: [
        ...book.notes,
        `${now.toISOString()}: scrubbed ${closed.length} non-meme open(s) (stables/majors) — free cash for mid-tier meme copies`,
      ],
    },
    closed,
  };
}

/**
 * Close open paper positions whose source wallet is no longer in the active
 * tracked set (legacy provisional-KOL / archived mega bags). Continuity kept
 * them for MTM, but they occupy MAX_OPEN slots and block mid-tier copies —
 * learning signal 2026-09-23: Doji leftovers caused max_open skips.
 */

/**
 * Close excess open copies beyond MAX_OPEN_PER_WALLET for any single source.
 * Learning 2026-09-23 ~10:15 MDT: gr3gor14n still held 3 opens from before the
 * per-wallet cap (same-cycle spray), crowding MAX_OPEN while CoinSmuggler hits
 * max_open_positions skips. Keep the oldest opens (tie-break: better unrealized),
 * scrub the rest so mid-tier diversity has room.
 */
export function scrubExcessPerWalletOpens(
  book: CopyBookState,
  now = new Date(),
  maxPerWallet = getActivePolicy().maxOpenPerWallet,
): { book: CopyBookState; closed: PaperCopyPosition[] } {
  const opensByWallet = new Map<string, PaperCopyPosition[]>();
  for (const pos of book.positions) {
    if (pos.status !== "open") continue;
    const list = opensByWallet.get(pos.sourceWallet) ?? [];
    list.push(pos);
    opensByWallet.set(pos.sourceWallet, list);
  }
  const scrubIds = new Set<string>();
  for (const [, opens] of opensByWallet) {
    if (opens.length <= maxPerWallet) continue;
    const ranked = [...opens].sort((a, b) => {
      const ao = Date.parse(a.openedAt);
      const bo = Date.parse(b.openedAt);
      if (ao !== bo) return ao - bo;
      return (b.unrealizedPnlUsd ?? 0) - (a.unrealizedPnlUsd ?? 0);
    });
    for (const drop of ranked.slice(maxPerWallet)) scrubIds.add(drop.id);
  }
  if (!scrubIds.size) return { book, closed: [] };

  const closed: PaperCopyPosition[] = [];
  let cash = book.cashUsd;
  const positions: PaperCopyPosition[] = [];
  for (const pos of book.positions) {
    if (pos.status !== "open" || !scrubIds.has(pos.id)) {
      positions.push(pos);
      continue;
    }
    const mark = pos.markPriceUsd > 0 ? pos.markPriceUsd : pos.entryPriceUsd;
    const marked: PaperCopyPosition = {
      ...pos,
      markPriceUsd: mark,
      markAt: now.toISOString(),
      unrealizedPnlUsd: (mark - pos.entryPriceUsd) * pos.quantity,
      unrealizedPnlPct:
        pos.entryPriceUsd > 0 ? (mark - pos.entryPriceUsd) / pos.entryPriceUsd : 0,
    };
    const done = closePosition(
      marked,
      now,
      "closed_time",
      "scrub_excess_per_wallet",
    );
    cash += settleCashDelta(pos, done);
    closed.push(done);
    positions.push(done);
  }
  return {
    book: {
      ...book,
      positions,
      cashUsd: cash,
      updatedAt: now.toISOString(),
      notes: [
        ...book.notes,
        `${now.toISOString()}: scrubbed ${closed.length} excess per-wallet open(s) (>${maxPerWallet}) — free slots for mid-tier copies`,
      ],
    },
    closed,
  };
}

/**
 * Close excess open copies from unproven sources beyond MAX_OPEN_UNPROVEN_TOTAL.
 * Learning 2026-09-23 ~16:56 MDT: MAX_OPEN_UNPROVEN_TOTAL dropped to 0 (proven-
 * only) but passthedutcher GP/neet (opened under the old =2 cap) still sat open
 * and tied cash. Keep the best unrealized unproven opens up to the cap; scrub
 * the rest (when cap is 0, scrub all unproven opens). Proven (net+ closed)
 * opens are never scrubbed here.
 */
export function scrubExcessUnprovenOpens(
  book: CopyBookState,
  now = new Date(),
  maxUnproven = getActivePolicy().maxOpenUnprovenTotal,
): { book: CopyBookState; closed: PaperCopyPosition[] } {
  // Market closes only — scrub_* must not flip a wallet to "proven" and exempt it.
  const closedNetByWallet = new Map<string, number>();
  for (const p of book.positions) {
    if (p.status === "open" || isAgentScrubClose(p)) continue;
    closedNetByWallet.set(
      p.sourceWallet,
      (closedNetByWallet.get(p.sourceWallet) ?? 0) + (p.realizedPnlUsd ?? 0),
    );
  }
  const unprovenOpens = book.positions.filter((p) => {
    if (p.status !== "open") return false;
    // Seed printers count as proven until this book has their market closes.
    if (isProvenPrinter(book, p.sourceWallet)) return false;
    return (closedNetByWallet.get(p.sourceWallet) ?? 0) <= 0;
  });
  if (unprovenOpens.length <= maxUnproven) return { book, closed: [] };

  const ranked = [...unprovenOpens].sort((a, b) => {
    const ua = a.unrealizedPnlUsd ?? 0;
    const ub = b.unrealizedPnlUsd ?? 0;
    if (ua !== ub) return ub - ua; // keep best unrealized
    return Date.parse(a.openedAt) - Date.parse(b.openedAt);
  });
  const scrubIds = new Set(ranked.slice(maxUnproven).map((p) => p.id));
  if (!scrubIds.size) return { book, closed: [] };

  const closed: PaperCopyPosition[] = [];
  let cash = book.cashUsd;
  const positions: PaperCopyPosition[] = [];
  for (const pos of book.positions) {
    if (pos.status !== "open" || !scrubIds.has(pos.id)) {
      positions.push(pos);
      continue;
    }
    const mark = pos.markPriceUsd > 0 ? pos.markPriceUsd : pos.entryPriceUsd;
    const marked: PaperCopyPosition = {
      ...pos,
      markPriceUsd: mark,
      markAt: now.toISOString(),
      unrealizedPnlUsd: (mark - pos.entryPriceUsd) * pos.quantity,
      unrealizedPnlPct:
        pos.entryPriceUsd > 0 ? (mark - pos.entryPriceUsd) / pos.entryPriceUsd : 0,
    };
    const done = closePosition(
      marked,
      now,
      "closed_time",
      "scrub_excess_unproven",
    );
    cash += settleCashDelta(pos, done);
    closed.push(done);
    positions.push(done);
  }
  return {
    book: {
      ...book,
      positions,
      cashUsd: cash,
      updatedAt: now.toISOString(),
      notes: [
        ...book.notes,
        `${now.toISOString()}: scrubbed ${closed.length} excess unproven open(s) (>${maxUnproven}) — concentrate on proven printers`,
      ],
    },
    closed,
  };
}

/**
 * Close opens that re-entered a mint still inside the SL/time-stop cool-down.
 * Learning 2026-09-23 ~11:12 MDT: FrostxXBT TROLL was time-stopped then
 * re-opened the same mint in that same cycle (before cool-down self-edit
 * landed). New opens are already blocked by recent_sl_mint_cooldown; this
 * scrub frees leftover slots that would have been blocked.
 */
export function scrubCooldownViolatingOpens(
  book: CopyBookState,
  now = new Date(),
  cooldownMs = getActivePolicy().mintCooldownMs,
): { book: CopyBookState; closed: PaperCopyPosition[] } {
  const scrubIds = new Set<string>();
  for (const pos of book.positions) {
    if (pos.status !== "open") continue;
    const openedAt = Date.parse(pos.openedAt);
    if (!Number.isFinite(openedAt)) continue;
    const priorCut = book.positions.find((p) => {
      if (p.id === pos.id || p.mint !== pos.mint || !p.closedAt) return false;
      if (!triggersMintCooldown(p)) return false;
      const closedAt = Date.parse(p.closedAt);
      if (!Number.isFinite(closedAt)) return false;
      // Only scrub if this open came at/after that cut and still within cool-down of it.
      if (openedAt < closedAt) return false;
      const ageFromCut = openedAt - closedAt;
      return ageFromCut >= 0 && ageFromCut < cooldownMs;
    });
    if (priorCut) scrubIds.add(pos.id);
  }
  if (!scrubIds.size) return { book, closed: [] };

  const closed: PaperCopyPosition[] = [];
  let cash = book.cashUsd;
  const positions: PaperCopyPosition[] = [];
  for (const pos of book.positions) {
    if (pos.status !== "open" || !scrubIds.has(pos.id)) {
      positions.push(pos);
      continue;
    }
    const mark = pos.markPriceUsd > 0 ? pos.markPriceUsd : pos.entryPriceUsd;
    const marked: PaperCopyPosition = {
      ...pos,
      markPriceUsd: mark,
      markAt: now.toISOString(),
      unrealizedPnlUsd: (mark - pos.entryPriceUsd) * pos.quantity,
      unrealizedPnlPct:
        pos.entryPriceUsd > 0 ? (mark - pos.entryPriceUsd) / pos.entryPriceUsd : 0,
    };
    const done = closePosition(
      marked,
      now,
      "closed_time",
      "scrub_cooldown_reentry",
    );
    cash += settleCashDelta(pos, done);
    closed.push(done);
    positions.push(done);
  }
  return {
    book: {
      ...book,
      positions,
      cashUsd: cash,
      updatedAt: now.toISOString(),
      notes: [
        ...book.notes,
        `${now.toISOString()}: scrubbed ${closed.length} cool-down re-entry open(s) — free slots for mid-tier copies`,
      ],
    },
    closed,
  };
}

export function scrubInactiveSourceOpens(
  book: CopyBookState,
  activeAddresses: Iterable<string>,
  now = new Date(),
): { book: CopyBookState; closed: PaperCopyPosition[] } {
  const active = new Set(
    [...activeAddresses].map((a) => a.trim()).filter(Boolean),
  );
  const closed: PaperCopyPosition[] = [];
  let cash = book.cashUsd;
  const positions: PaperCopyPosition[] = [];
  for (const pos of book.positions) {
    if (pos.status !== "open" || active.has(pos.sourceWallet)) {
      positions.push(pos);
      continue;
    }
    const mark = pos.markPriceUsd > 0 ? pos.markPriceUsd : pos.entryPriceUsd;
    const marked: PaperCopyPosition = {
      ...pos,
      markPriceUsd: mark,
      markAt: now.toISOString(),
      unrealizedPnlUsd: (mark - pos.entryPriceUsd) * pos.quantity,
      unrealizedPnlPct:
        pos.entryPriceUsd > 0 ? (mark - pos.entryPriceUsd) / pos.entryPriceUsd : 0,
    };
    const done = closePosition(
      marked,
      now,
      "closed_time",
      "scrub_inactive_source_wallet",
    );
    cash += settleCashDelta(pos, done);
    closed.push(done);
    positions.push(done);
  }
  if (!closed.length) return { book, closed };
  return {
    book: {
      ...book,
      positions,
      cashUsd: cash,
      updatedAt: now.toISOString(),
      notes: [
        ...book.notes,
        `${now.toISOString()}: scrubbed ${closed.length} open(s) from inactive source wallets — free slots for mid-tier copies`,
      ],
    },
    closed,
  };
}

export type ResolveEntryPriceResult =
  | {
      priceUsd: number;
      source: PaperCopyPosition["entryPriceSource"];
      symbol?: string;
      context?: EntryContext;
    }
  | { skipReason: string };

function contextFrom(
  buy: WalletBuyEvent,
  live: Awaited<ReturnType<typeof getTokenPriceUsd>>,
): EntryContext {
  return {
    txEntryPriceUsd:
      buy.entryPriceUsd != null && buy.entryPriceUsd > 0 ? buy.entryPriceUsd : null,
    liveEntryPriceUsd: live?.priceUsd ?? null,
    mcapUsd: live?.mcapUsd ?? null,
    liquidityUsd: live?.liquidityUsd ?? null,
    createdAtMs: live?.createdAtMs ?? null,
    tokenName: live?.name ?? null,
  };
}

/**
 * Pure entry decision given tx-implied and live prices.
 * refuse (entry_live_below_tx) when live ≤ (1 − underwaterRefusePct) × tx;
 * prefer live on 3× band fail or live ≤ (1 − LOSS_PCT) × tx; else tx.
 */
export function decideEntry(
  txPriceUsd: number,
  livePriceUsd: number | null,
  underwaterRefusePct: number,
): "refuse" | "live" | "tx" {
  if (livePriceUsd == null || !(livePriceUsd > 0)) return "tx";
  const ratio = livePriceUsd / txPriceUsd;
  if (shouldRefuseUnderwaterTxEntry(ratio, underwaterRefusePct)) return "refuse";
  if (preferLiveOverTxEntry(ratio)) return "live";
  return "tx";
}

/** Resolve entry: prefer tx-derived price, else live mark. */
export async function resolveEntryPrice(
  buy: WalletBuyEvent,
  policy: CopyPolicy = getActivePolicy(),
): Promise<ResolveEntryPriceResult | null> {
  if (buy.entryPriceUsd != null && buy.entryPriceUsd > 0) {
    // If live mark disagrees beyond sanity, prefer live — tx_sol_delta can
    // mis-attribute multi-leg txs and create instant −SL phantoms (FAP-class).
    // Learning 2026-09-24 ~11:21 MDT: if live is already far below tx, refuse
    // (YCAT-class dump-in-progress). Learning mode loosens refuse to 25%.
    const live = await getTokenPriceUsd(buy.mint);
    const context = contextFrom(buy, live);
    const decision = decideEntry(
      buy.entryPriceUsd,
      live?.priceUsd ?? null,
      policy.underwaterRefusePct,
    );
    if (decision === "refuse") return { skipReason: "entry_live_below_tx" };
    if (decision === "live" && live) {
      const source: PaperCopyPosition["entryPriceSource"] =
        live.source.startsWith("pumpfun") ? "pumpfun_mcap" : "dexscreener";
      return { priceUsd: live.priceUsd, source, symbol: live.symbol, context };
    }
    return {
      priceUsd: buy.entryPriceUsd,
      source: "tx_sol_delta",
      symbol: live?.symbol,
      context,
    };
  }
  const live = await getTokenPriceUsd(buy.mint);
  if (!live) return null;
  const source: PaperCopyPosition["entryPriceSource"] =
    live.source.startsWith("pumpfun") ? "pumpfun_mcap" : "dexscreener";
  return {
    priceUsd: live.priceUsd,
    source,
    symbol: live.symbol,
    context: contextFrom(buy, live),
  };
}
