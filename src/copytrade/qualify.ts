/**
 * Close-classification helpers shared by learning analysis, TP/SL replay, and
 * wallet suspension (2026-09-28 ~21:00 MDT). Pure; imports config only so both
 * paperBook.ts and learning.ts can use it without a circular import.
 */

import {
  OUTAGE_HOLD_MINUTES,
  RUG_GAP_PCT,
  SUSPEND_MAX_WIN_RATE,
  SUSPEND_MIN_QUALIFYING_CLOSES,
  matchesRugProfile,
} from "./config.js";
import type { CopyBookState, PaperCopyPosition } from "./types.js";

/** Realized % on original basis (partial TP legs included). */
export function realizedPct(p: PaperCopyPosition): number {
  if (p.learning?.realizedPnlPct != null) return p.learning.realizedPnlPct;
  const basis = p.originalSizeUsd ?? p.sizeUsd;
  return basis > 0 ? (p.realizedPnlUsd ?? 0) / basis : 0;
}

/** Held far past MAX_HOLD + 1h → scheduler outage, not a strategy outcome. */
export function isOutageHeld(p: PaperCopyPosition): boolean {
  let hold = p.learning?.holdMinutes;
  if (hold == null && p.closedAt) {
    hold = (Date.parse(p.closedAt) - Date.parse(p.openedAt)) / 60_000;
  }
  return hold != null && Number.isFinite(hold) && hold > OUTAGE_HOLD_MINUTES;
}

/** Rug = realized ≤ −30% (fixed; independent of the SL setting or close label). */
export function isRugClose(p: PaperCopyPosition): boolean {
  return p.status !== "open" && realizedPct(p) <= -RUG_GAP_PCT;
}

export function isScrubOrMarkUnavailable(p: { closeReason?: string }): boolean {
  const r = (p.closeReason ?? "").toLowerCase();
  return r.startsWith("scrub_") || r.startsWith("mark_unavailable");
}

/** Rug on a bag whose entry matched the rug-filter profile (now blocked at entry). */
export function isFilterProfileRug(p: PaperCopyPosition): boolean {
  return isRugClose(p) && matchesRugProfile(p.learning);
}

/**
 * Learning-tagged market close usable for replay / suspension:
 * not scrub_*, not mark_unavailable, not outage-held.
 */
export function isQualifyingLearningClose(p: PaperCopyPosition): boolean {
  if (p.status === "open" || !p.closedAt) return false;
  if (p.learning?.policy !== "learning") return false;
  if (isScrubOrMarkUnavailable(p)) return false;
  if (isOutageHeld(p)) return false;
  return true;
}

export interface WalletQualStats {
  wallet: string;
  label: string;
  n: number;
  wins: number;
  winRate: number;
  pnlUsd: number;
  /** How many of n came from suspended-wallet shadow trades */
  shadowN: number;
}

/**
 * Per-wallet stats for the suspension rule: qualifying real closes plus
 * suspended-wallet SHADOW closes (so a suspended wallet can earn its way back),
 * minus filter-profile rugs. Shadow PnL is hypothetical at the same explorer size.
 */
export function walletSuspensionStats(book: CopyBookState): Map<string, WalletQualStats> {
  const m = new Map<string, WalletQualStats>();
  const add = (p: PaperCopyPosition, shadow: boolean) => {
    if (!isQualifyingLearningClose(p) || isFilterProfileRug(p)) return;
    const s =
      m.get(p.sourceWallet) ??
      { wallet: p.sourceWallet, label: p.sourceWalletLabel, n: 0, wins: 0, winRate: 0, pnlUsd: 0, shadowN: 0 };
    s.n++;
    if ((p.realizedPnlUsd ?? 0) > 0) s.wins++;
    s.pnlUsd += p.realizedPnlUsd ?? 0;
    if (shadow) s.shadowN++;
    s.winRate = s.n ? s.wins / s.n : 0;
    m.set(p.sourceWallet, s);
  };
  for (const p of book.positions) add(p, false);
  for (const p of book.shadowPositions ?? []) {
    if (p.shadow?.reason === "suspended_wallet") add(p, true);
  }
  return m;
}

export function meetsSuspensionCriteria(s: WalletQualStats | undefined): boolean {
  if (!s) return false;
  return s.n >= SUSPEND_MIN_QUALIFYING_CLOSES && s.pnlUsd < 0 && s.winRate < SUSPEND_MAX_WIN_RATE;
}

/**
 * Wallets currently suspended by learning tuning. A pre-2026-09-28 tuning state
 * (only `demoted`, old 4-close archive rule) is ignored — the new rule re-derives.
 */
export function suspendedWallets(book: CopyBookState): string[] {
  return book.learningTuning?.suspended ?? [];
}
