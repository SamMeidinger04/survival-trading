/**
 * One paper copy-trade cycle:
 * refresh wallet activity → exit/mark (free slots) → open paper copies →
 * rematch marks → write artifacts.
 *
 * Learning 2026-09-23 ~05:49 MDT: opening BEFORE markBook meant time-stop /
 * TP / SL closes could not free MAX_OPEN slots in the same cycle (ANSEM 6h
 * time-stop + 3 max_open skips). Pre-exit first so new mid-tier buys can fill.
 */

import {
  DEFAULT_RPC,
  INITIAL_LOOKBACK_MINUTES,
  LOSS_PCT,
  MAX_HOLD_HOURS,
  TRACKED_WALLETS,
  WIN_PCT,
  getActivePolicy,
} from "./config.js";
import { computeLearningTuning } from "./learning.js";
import {
  closeOnSourceSells,
  equityOf,
  markBook,
  markShadowBook,
  openPaperCopy,
  resolveEntryPrice,
  scrubCooldownViolatingOpens,
  scrubExcessPerWalletOpens,
  scrubExcessUnprovenOpens,
  scrubInactiveSourceOpens,
  scrubNonMemeOpens,
} from "./paperBook.js";
import { getTop10HolderPct } from "./prices.js";
import { SolanaRpc } from "./rpc.js";
import { loadBook, saveBook, writeArtifact, writeStatusMd } from "./store.js";
import type { CopyCycleArtifact } from "./types.js";
import { pollWalletBuys } from "./walletActivity.js";

export async function runCopyCycle(root = process.cwd()): Promise<{
  artifact: CopyCycleArtifact;
  paths: { book: string; latest: string; statusMd: string };
}> {
  const now = new Date();
  const ranAt = now.toISOString();
  const blockers: string[] = [];
  const skipped: Array<{ signature: string; reason: string }> = [];

  const policy = getActivePolicy();
  let book = await loadBook(root);
  // Keep risk params in sync with config (book.json may lag after self-edits).
  // 2026-09-28 ~21:00 MDT: re-derive tuning (replay v2 + suspension) BEFORE any
  // marks so a stale persisted state (e.g. old 30/10 or old demote list) never
  // drives this cycle's exits. Below 20 learning closes → base TP/SL.
  const freshTuning = policy.name === "learning" ? computeLearningTuning(book, now) : null;
  book = {
    ...book,
    ...(freshTuning ? { learningTuning: freshTuning } : {}),
    winPct: freshTuning?.winPct ?? WIN_PCT,
    lossPct: freshTuning?.lossPct ?? LOSS_PCT,
    maxHoldHours: MAX_HOLD_HOURS,
    copySizeUsd: policy.explorerSizeUsd,
  };
  if (policy.name === "learning") {
    blockers.push(
      `learning mode ON: explorer $${policy.explorerSizeUsd} / proven ≤$${policy.provenSizeUsd}, max open ${policy.maxOpenPositions} (per wallet ${policy.maxOpenPerWallet}, unproven ${policy.maxOpenUnprovenTotal}), TP +${(book.winPct * 100).toFixed(0)}% partial ${(policy.partialTpFraction * 100).toFixed(0)}% + trail ${(policy.trailPct * 100).toFixed(0)}%, SL -${(book.lossPct * 100).toFixed(0)}%`,
    );
  }
  // Drop stables/majors left open by earlier cycles (invalid for meme learning).
  const scrubbed = scrubNonMemeOpens(book, now);
  book = scrubbed.book;
  if (scrubbed.closed.length) {
    blockers.push(
      `scrubbed ${scrubbed.closed.length} non-meme open(s): ` +
        scrubbed.closed.map((p) => p.symbol ?? p.mint.slice(0, 8)).join(", "),
    );
  }
  // Drop opens from wallets no longer polled (legacy KOL / archived) so they
  // stop occupying MAX_OPEN slots needed for mid-tier learning copies.
  const inactiveScrub = scrubInactiveSourceOpens(
    book,
    TRACKED_WALLETS.map((w) => w.address),
    now,
  );
  book = inactiveScrub.book;
  if (inactiveScrub.closed.length) {
    blockers.push(
      `scrubbed ${inactiveScrub.closed.length} inactive-source open(s): ` +
        inactiveScrub.closed
          .map((p) => `${p.sourceWalletLabel ?? p.sourceWallet.slice(0, 6)}:${p.symbol ?? p.mint.slice(0, 8)}`)
          .join(", "),
    );
  }
  // Drop excess opens beyond MAX_OPEN_PER_WALLET left from pre-cap sprays.
  const excessScrub = scrubExcessPerWalletOpens(book, now);
  book = excessScrub.book;
  if (excessScrub.closed.length) {
    blockers.push(
      `scrubbed ${excessScrub.closed.length} excess per-wallet open(s): ` +
        excessScrub.closed
          .map((p) => `${p.sourceWalletLabel ?? p.sourceWallet.slice(0, 6)}:${p.symbol ?? p.mint.slice(0, 8)}`)
          .join(", "),
    );
  }
  // Drop excess unproven opens beyond MAX_OPEN_UNPROVEN_TOTAL (proven-only when 0).
  const unprovenScrub = scrubExcessUnprovenOpens(book, now);
  book = unprovenScrub.book;
  if (unprovenScrub.closed.length) {
    blockers.push(
      `scrubbed ${unprovenScrub.closed.length} excess unproven open(s): ` +
        unprovenScrub.closed
          .map((p) => `${p.sourceWalletLabel ?? p.sourceWallet.slice(0, 6)}:${p.symbol ?? p.mint.slice(0, 8)}`)
          .join(", "),
    );
  }
  // Drop opens that re-entered a mint still inside SL/time-stop cool-down
  // (leftovers from before recent_sl_mint_cooldown landed).
  const cooldownScrub = scrubCooldownViolatingOpens(book, now);
  book = cooldownScrub.book;
  if (cooldownScrub.closed.length) {
    blockers.push(
      `scrubbed ${cooldownScrub.closed.length} cool-down re-entry open(s): ` +
        cooldownScrub.closed
          .map((p) => `${p.sourceWalletLabel ?? p.sourceWallet.slice(0, 6)}:${p.symbol ?? p.mint.slice(0, 8)}`)
          .join(", "),
    );
  }
  // Use wide lookback until we have either open/closed copies or a successful poll with seen txs.
  const needsWarmStart =
    book.positions.length === 0 && book.seenSignatures.length === 0;

  const sinceUnixSec = needsWarmStart
    ? Math.floor(now.getTime() / 1000) - INITIAL_LOOKBACK_MINUTES * 60
    : Math.floor(new Date(book.lastPolledAt).getTime() / 1000) - 60; // 1m overlap

  const rpc = new SolanaRpc(DEFAULT_RPC);
  const seen = new Set(book.seenSignatures);

  const {
    buys,
    sells,
    blockers: pollBlockers,
  } = await pollWalletBuys(rpc, TRACKED_WALLETS, {
    sinceUnixSec,
    seenSignatures: seen,
  });
  blockers.push(...pollBlockers);

  // Pre-exit BEFORE opens so TP/SL/time-stop/exit-follow free MAX_OPEN slots
  // for this cycle's mid-tier buys (was: open then mark → wasted capacity).
  const followed = closeOnSourceSells(book, sells, now);
  book = followed.book;
  if (followed.closed.length) {
    blockers.push(
      `exit-follow closed ${followed.closed.length} on source sell(s): ` +
        followed.closed
          .map(
            (p) =>
              `${p.sourceWalletLabel ?? p.sourceWallet.slice(0, 6)}:${p.symbol ?? p.mint.slice(0, 8)}`,
          )
          .join(", "),
    );
  }

  const preMarked = await markBook(book, now, policy);
  book = preMarked.book;
  blockers.push(...preMarked.blockers);

  // Learning auto-tune: after ≥20 learning closes, promote/demote wallets and
  // tune TP/SL from MFE/MAE replay. Applies to this cycle's opens + marks.
  if (policy.name === "learning") {
    const tuning = computeLearningTuning(book, now);
    if (tuning) {
      book = {
        ...book,
        learningTuning: tuning,
        winPct: tuning.winPct,
        lossPct: tuning.lossPct,
      };
      blockers.push(`learning auto-tune (n=${tuning.learningClosed}): ${tuning.notes.join("; ")}`);
    }
  }

  const noNewCopy = new Set(
    TRACKED_WALLETS.filter((w) => w.acceptNewCopies === false).map((w) => w.address),
  );
  const sizeCaps = new Map(
    TRACKED_WALLETS.filter((w) => w.sizeCapUsd != null).map((w) => [w.address, w.sizeCapUsd!]),
  );
  let openedCount = 0;
  for (const buy of buys) {
    if (seen.has(buy.signature) || book.seenSignatures.includes(buy.signature)) {
      skipped.push({ signature: buy.signature, reason: "already_copied_tx" });
      continue;
    }
    if (noNewCopy.has(buy.walletAddress)) {
      skipped.push({ signature: buy.signature, reason: "wallet_no_new_copies" });
      book = {
        ...book,
        seenSignatures: [...book.seenSignatures, buy.signature].slice(-5000),
      };
      seen.add(buy.signature);
      continue;
    }
    const entry = await resolveEntryPrice(buy, policy);
    if (!entry) {
      // Learning 2026-09-28 ~21:12 MDT: 3/3 buys this cycle hit no_honest_entry_price
      // (no tx_sol_delta AND Dex/pump live miss). Do NOT mark seen — retry next
      // cycle when a live mark appears. Still refuse to open without an honest
      // price (data-quality gate stays on).
      skipped.push({ signature: buy.signature, reason: "no_honest_entry_price" });
      continue;
    }
    if ("skipReason" in entry) {
      skipped.push({ signature: buy.signature, reason: entry.skipReason });
      book = {
        ...book,
        seenSignatures: [...book.seenSignatures, buy.signature].slice(-5000),
      };
      seen.add(buy.signature);
      continue;
    }
    // Holder concentration (opt-in; null unless COPYTRADE_HOLDER_STATS_RPC is set).
    if (entry.context && entry.context.top10HolderPct === undefined) {
      entry.context = {
        ...entry.context,
        top10HolderPct: await getTop10HolderPct(buy.mint),
        holderCount: null,
      };
    }
    const result = openPaperCopy(
      book,
      buy,
      entry.priceUsd,
      entry.source,
      entry.symbol,
      now,
      {
        policy,
        sizeCapUsd: sizeCaps.get(buy.walletAddress),
        entryContext: entry.context,
      },
    );
    book = result.book;
    seen.add(buy.signature);
    if (result.opened) {
      openedCount++;
      if (result.opened.sizeCapTag) {
        blockers.push(
          `${result.opened.sizeCapTag} (${result.opened.sourceWalletLabel ?? buy.walletAddress.slice(0, 6)}:${result.opened.symbol ?? buy.mint.slice(0, 8)})`,
        );
      }
    } else if (result.skipReason) {
      skipped.push({ signature: buy.signature, reason: result.skipReason });
    }
  }

  // Rematch after opens (fresh bags get live marks; open-grace still protects).
  const marked = await markBook(book, now, policy);
  book = marked.book;
  blockers.push(...marked.blockers);

  // Shadow trades (rug-filter / suspended-wallet candidates): same exit rules,
  // never touch cash or equity.
  const shadowMarked = await markShadowBook(book, now, policy);
  book = shadowMarked.book;
  const shadowOpen = (book.shadowPositions ?? []).filter((p) => p.status === "open").length;
  const shadowSkips = skipped.filter(
    (s) => s.reason === "rug_filter_fresh_thin_pool" || s.reason === "learning_suspended_wallet",
  ).length;
  if (shadowOpen || shadowMarked.closed || shadowSkips) {
    blockers.push(
      `shadow trades: ${shadowSkips} logged this cycle, ${shadowOpen} open, ${shadowMarked.closed} closed this cycle (never in equity)`,
    );
  }

  book = {
    ...book,
    lastPolledAt: ranAt,
    cycleCount: book.cycleCount + 1,
    updatedAt: ranAt,
  };

  const eq = equityOf(book);
  const artifact: CopyCycleArtifact = {
    ranAt,
    mode: "paper_copytrade",
    realMoney: false,
    learningMode: policy.name === "learning",
    policy,
    learningTuning: book.learningTuning ?? null,
    walletsTracked: TRACKED_WALLETS.map((w) => ({
      address: w.address,
      label: w.label,
      provisional: w.provisional,
      justification: w.justification,
    })),
    newBuysDetected: buys.length,
    newCopiesOpened: openedCount,
    skipped,
    openPositions: eq.openCount,
    closedThisCycle:
      preMarked.closed +
      marked.closed +
      scrubbed.closed.length +
      inactiveScrub.closed.length +
      excessScrub.closed.length +
      unprovenScrub.closed.length +
      cooldownScrub.closed.length +
      followed.closed.length,
    equityUsd: round2(eq.equityUsd),
    cashUsd: round2(book.cashUsd),
    unrealizedPnlUsd: round2(eq.unrealizedPnlUsd),
    realizedPnlUsd: round2(eq.realizedPnlUsd),
    positions: book.positions,
    blockers: dedupe(blockers).slice(0, 40),
    summary: buildSummary(openedCount, buys.length, eq, blockers),
  };

  const bookPath = await saveBook(book, root);
  const { latest } = await writeArtifact(artifact, root);
  const statusMd = await writeStatusMd(artifact, root);

  return { artifact, paths: { book: bookPath, latest, statusMd } };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function buildSummary(
  opened: number,
  buys: number,
  eq: ReturnType<typeof equityOf>,
  blockers: string[],
): string {
  const parts = [
    `Paper copy cycle: detected ${buys} buy event(s), opened ${opened} paper copy position(s).`,
    `Book equity $${eq.equityUsd.toFixed(2)} with ${eq.openCount} open (unrealized $${eq.unrealizedPnlUsd.toFixed(2)}, realized $${eq.realizedPnlUsd.toFixed(2)}).`,
  ];
  if (blockers.length) {
    parts.push(`${blockers.length} blocker note(s) — see blockers list (often RPC/rate-limit).`);
  }
  parts.push("Old Survival trial remains paused; this book lives under data/copytrade/.");
  return parts.join(" ");
}
