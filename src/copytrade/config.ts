import type { TrackedWallet } from "./types.js";

/** Virtual paper bankroll for the COPY book (separate from old $100 trial). */
export const COPY_BANKROLL_USD = 1_000;
/**
 * Fixed notional per paper copy for unproven / net-negative sources.
 * Learning 2026-09-23 ~13:00 MDT: equal $50 mid-tier spray drove equity
 * $1000→$611 (−39%) while only CoinSmuggler is net+ closed. Cut unproven
 * size; proven overweight stays at COPY_SIZE_PROVEN_USD.
 */
export const COPY_SIZE_USD = 25;
/**
 * Learning 2026-09-23 ~10:15 MDT: CoinSmuggler is the only net-positive closed
 * printer (~+$55) while equal-weight mid-tier dilutes. Overweight wallets whose
 * closed realized PnL on this book is > 0.
 */
export const COPY_SIZE_PROVEN_USD = 75;
/**
 * Prior-book printers carried into a bankroll restart so overweight survives a
 * clean $1000 reset. Cleared once that wallet has market closes on the new book
 * (see isProvenPrinter).
 * Learning 2026-09-24 ~05:56 MDT: emptied — CoinSmuggler now has market closes
 * on the do-or-die book and flipped net− (−$12.88 after GO rug); seed no longer
 * applies.
 * Learning 2026-09-24 ~10:42 MDT: cap also flipped net− (−$25.22 after YCAT
 * rug_gap −$48 on phantom tx_sol_delta entry) — ZERO this-book proven printers;
 * all active wallets size at COPY_SIZE_USD ($25) until someone is net+ again.
 */
export const PROVEN_SEED_WALLETS = new Set<string>([]);
/** Cap concurrent open paper copies so cash is not sprayed across correlated bags. */
export const MAX_OPEN_POSITIONS = 8;
/**
 * Learning 2026-09-23 ~07:09 MDT: one printer (gr3gor14n) opened 3 bags same
 * cycle and filled half of MAX_OPEN while CoinSmuggler (proven TP printer) and
 * DecentralizeDie starved behind max_open skips. Cap opens per source wallet so
 * mid-tier diversity / enter-make-exit learning stays intact.
 */
export const MAX_OPEN_PER_WALLET = 2;
/**
 * Learning 2026-09-23 ~16:56 MDT: after MAX_OPEN_UNPROVEN_TOTAL=1, explorers
 * under the old =2 cap occupied slots; dropped to 0 (proven-only).
 * Learning 2026-09-23 ~18:54 MDT: proven-only is a catch-22 — unproven mid-tier
 * can never open, so they can never earn proven status. CoinSmuggler stayed the
 * only net+ closed (~+$17.31) while 2 buys/cycle hit max_open_unproven_total and
 * the book sat flat at $612 with 0 opens after ANSEM time-stop. Restore a single
 * $25 explorer slot (scrubExcessUnprovenOpens enforces the cap); proven stays $75.
 * Learning 2026-09-24 ~06:53 MDT: when the slot is full, openPaperCopy may scrub
 * a weaker explorer for a stronger mixed printer (scrub_prefer_better_unproven).
 * Learning 2026-09-24 ~08:06 MDT: displace requires ≥1 market close on the buyer
 * (no virgin-for-loser churn).
 */
export const MAX_OPEN_UNPROVEN_TOTAL = 1;
/**
 * Never paper-copy these mints (stables / majors). Goal is mid-tier pump.fun meme
 * enter/make/exit — USDC/JTO/PUMP-majors dilute learning and burn cash.
 */
export const SKIP_MINTS = new Set<string>([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "So11111111111111111111111111111111111111112", // native SOL wrap
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", // JTO
  "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", // official PUMP
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "HiMSSzzwkZkrXJ4PGVJRdtfLaANeAztjjcgk5Dxe7Lwx", // HIMS tokenized equity (Backpack Securities) — Hash copy 2026-09-24
  "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g", // HYPE @$88 major/weird pair — Cooker copy 2026-09-29; not a pump meme
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK bluechip major — LUKEY copy 2026-09-29; not mid-tier pump learning
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // dogwifhat ($WIF) bluechip major — Cooker copy 2026-09-29; not mid-tier pump learning
]);
/**
 * Tokenized equities / RWAs are not pump.fun memes (learning 2026-09-24 ~15:40
 * MDT: first learning cycle copied Hash into "Hims & Hers Health - Backpack
 * Securities" at $29). Skip by venue token name.
 */
export const SKIP_NAME_PATTERN = /\b(securities|xstock|tokenized|backed)\b/i;
/** Symbol fallback when mint not listed yet (case-insensitive). */
export const SKIP_SYMBOLS = new Set(
  ["USDC", "USDT", "SOL", "WSOL", "JTO", "JUP", "RAY", "MSOL", "STSOL", "PYUSD", "PUMP", "BONK", "WIF", "$WIF"].map((s) =>
    s.toUpperCase(),
  ),
);
/**
 * Dollar-priced majors / tokenized equities / bad Dex pairs quote well above $1.
 * Pump.fun memes use fractional prices. Learning 2026-09-29: Cooker copied HYPE
 * at $88.42 (liq ~$3M) — scrub + block future entries at this ceiling.
 */
export const SKIP_MAX_ENTRY_PRICE_USD = 10;
/**
 * Enter / make some / exit thresholds (fraction).
 * Learning 2026-09-23 ~03:45 MDT: after tightening to TP +20% / SL -15%, still
 * 0 TP hits across the book while bags sit +9–16% then reverse to SL. Sources
 * often keep buying (exit-follow idle). Bank partial wins earlier at +12%.
 */
export const WIN_PCT = 0.12;
export const LOSS_PCT = 0.15;
/** Time-stop after 6 hours if not already closed by TP/SL. */
export const MAX_HOLD_HOURS = 6;
/**
 * Learning 2026-09-23 ~09:22 MDT: DecentralizeDie SL'd DUEL (−$13.90) then
 * re-copied the same mint next cycle (already −12.6%).
 * Learning 2026-09-23 ~10:15 MDT: FrostxXBT time-stopped TROLL (−$4.80) then
 * immediately re-copied TROLL same cycle. Cool-down covers stop-loss AND
 * time-stop closes for MAX_HOLD.
 * Learning 2026-09-23 ~11:12 MDT: that same-cycle TROLL re-open was still
 * sitting open after the cool-down edit; scrubCooldownViolatingOpens now
 * closes leftovers that openPaperCopy would have blocked.
 * Learning 2026-09-24 ~09:02 MDT: also covers scrub_prefer_* (GP re-opened
 * after prefer-scrub vacated it for GREEF, which then rugged). Other scrub_*
 * still do not cool the mint.
 */
export const RECENT_SL_MINT_COOLDOWN_MS = MAX_HOLD_HOURS * 60 * 60 * 1000;
/**
 * If a bag never gets a live venue mark (DexScreener / pump.fun) within this many
 * hours, close as mark_unavailable — dead/rugged mints otherwise sit at fake 0% PnL.
 * Learning 2026-09-23 ~02:48 MDT: HH7NR6gc… pump.fun 404, Dex null for 3h+.
 */
export const MARK_UNAVAILABLE_HOURS = 2;
/**
 * Learning 2026-09-23 ~04:50 MDT: throatycrab FAP opened+closed same second at
 * −81% labeled "SL −15%" because pumpfun_mcap entry vs next quote disagreed ~5×
 * (still inside the old 20× sanity band). Cap upside spikes at this ratio, and
 * do not crystallize SL inside the open-grace window (quote flicker at entry).
 *
 * Learning 2026-09-23 ~12:05 MDT: EPEP live marks at ratio 0.01 (both Dex +
 * pump.fun) were rejected by the symmetric band → bag stuck at fake 0% PnL.
 * Rugs/crashes must mark through; only reject upside > MAX× entry. Open-grace
 * still blocks same-window SL flicker.
 */
export const MARK_SANITY_MAX_RATIO = 3;
/**
 * Live mark vs entry for open MTM / exit-follow: accept any downside crash;
 * reject only upside spikes above MARK_SANITY_MAX_RATIO.
 */
export function isAcceptableLiveMarkRatio(ratio: number): boolean {
  return Number.isFinite(ratio) && ratio > 0 && ratio <= MARK_SANITY_MAX_RATIO;
}
/**
 * Entry resolve: live vs tx_sol_delta disagree beyond the band either way →
 * prefer live (multi-leg tx mis-attribution).
 */
export function liveDisagreesWithTxEntry(ratio: number): boolean {
  return !(
    Number.isFinite(ratio) &&
    ratio >= 1 / MARK_SANITY_MAX_RATIO &&
    ratio <= MARK_SANITY_MAX_RATIO
  );
}
/**
 * Prefer live venue mark over tx_sol_delta for entry when either the 3× sanity
 * band fails OR live is already ≥ LOSS_PCT below the tx price.
 * Learning 2026-09-24 ~10:42 MDT: YCAT tx 5.57e-5 vs Dex 1.99e-5 (ratio ~0.36)
 * stayed just inside 1/3…3, kept phantom entry, same-cycle rug_gap −$48 on a
 * then-proven $75 bag. Floor at 1−lossPct catches already-underwater opens
 * without tightening open-MTM upside rejection.
 */
export function preferLiveOverTxEntry(
  ratio: number,
  lossPct: number = LOSS_PCT,
): boolean {
  if (liveDisagreesWithTxEntry(ratio)) return true;
  return Number.isFinite(ratio) && ratio > 0 && ratio <= 1 - lossPct;
}
/**
 * Refuse the copy when live is already ≥ LOSS_PCT below tx-implied entry.
 * Learning 2026-09-24 ~11:21 MDT: preferLiveOverTxEntry alone still let YCAT
 * open (switched to live at ratio ~0.36) into an already-dumping bag; same-cycle
 * rug_gap −$48 on then-proven $75. Late underwater copies are refused entirely
 * (skip entry_live_below_tx); prefer-live remains for upside band fails.
 */
export function shouldRefuseUnderwaterTxEntry(
  ratio: number,
  lossPct: number = LOSS_PCT,
): boolean {
  return Number.isFinite(ratio) && ratio > 0 && ratio <= 1 - lossPct;
}
/**
 * After a this-wallet TP or rug_gap market close, suspend proven $75 sizing
 * for this long (next opens use COPY_SIZE_USD). Learning 2026-09-24 ~11:21 MDT:
 * cap SDOG TP +$33 then MOONIMALS rug_gap −$33 four minutes later at $75; YCAT
 * −$48 followed. CoinSmuggler OTC TP then GO rug at $75. Cooldown = MAX_HOLD
 * so rapid consecutive proven bags cannot re-load full size into the next rug.
 */
export const PROVEN_SIZE_COOLDOWN_MS = MAX_HOLD_HOURS * 60 * 60 * 1000;
/**
 * Soft SL (−lossPct … −2×) deferred this long after open (TP still allowed).
 * Learning 2026-09-24 ~09:53 MDT: rug_gap (≥2× lossPct) exits immediately even
 * inside grace — MOONIMALS −39% was held at fake 0% MTM under the old full skip.
 */
export const OPEN_MARK_GRACE_MS = 5 * 60 * 1000;
/**
 * ===================== LEARNING MODE (2026-09-24 ~15:36 MDT) =====================
 * Samuel: the gate stack (explorer_needs_this_book_win, single explorer slot,
 * canDisplaceExplorer, 6h proven-size cooldown) froze the book — 7/7 buys
 * blocked one cycle, 0 buys the next, 4W/9L on n=13 is too little data to
 * learn from. Learning mode takes MANY small exploratory paper copies ($10
 * explorers, proven ≤ $50) with higher concurrency, keeps only the gates that
 * protect DATA QUALITY (mark sanity, rug-gap immediate exit, underwater-entry
 * refusal at 25%, short per-mint cooldown, one open bag per mint), tags every
 * position with features, and after ≥20 learning closes auto-promotes /
 * demotes wallets and tunes TP/SL from the recorded MFE/MAE.
 * Disable with COPYTRADE_LEARNING_MODE=false to restore the legacy policy.
 */
export const LEARNING_MODE =
  (process.env.COPYTRADE_LEARNING_MODE ?? "true").trim().toLowerCase() !== "false";
/**
 * BIGGER BAGS (2026-09-29 ~16:50 MDT, Samuel: "trade with bigger bags and learn to
 * win"). PAPER ONLY. Explorer $10 → $25, proven $50 → $60, max open 16 → 12, plus a
 * total-exposure ceiling so cash is never sprayed. Safety gates are NOT weakened:
 * rug filter, young/thin cap (still $10), suspension, skip lists, honest-entry gate,
 * TP/SL and auto-tune are unchanged. Bigger size only goes to deeper pools (see the
 * liquidity floors below).
 */
/** Explorer (unproven / virgin / net−) paper size in learning mode (non-suspended wallets). */
export const LEARNING_EXPLORER_SIZE_USD = 25;
/** Proven (net+ on this book with ≥2 market closes) cap in learning mode — below legacy $75 because of rug gaps. */
export const LEARNING_PROVEN_SIZE_USD = 60;
export const LEARNING_MAX_OPEN_POSITIONS = 12;
/**
 * Total open cost (sum of open sizeUsd) may not exceed this fraction of equity.
 * A buy that would cross it is shrunk to the remaining room, or skipped
 * (`max_open_exposure`) when the room is < BIG_BAG_MIN_ROOM_USD. Keeps ≥40% cash.
 */
export const MAX_OPEN_EXPOSURE_PCT_OF_EQUITY = 0.6;
/** Smallest size worth opening when exposure room is nearly used up. */
export const MIN_EXPOSURE_ROOM_USD = 10;
/**
 * Liquidity floors for the bigger sizes (only enforced when entry liquidity was
 * recorded; unknown liquidity keeps the old behaviour). Below the floor the bag is
 * capped to the next size down. Tag: size_cap_thin_liquidity.
 */
export const BASE_SIZE_USD = 10;
export const EXPLORER_BIG_MIN_LIQ_USD = 20_000;
export const PROVEN_BIG_MIN_LIQ_USD = 50_000;
export const SIZE_CAP_THIN_LIQ_TAG = "size_cap_thin_liquidity";
/** Per-wallet open cap.
 * Learning 2026-09-29 ~22:34 MDT: Cooker sat at 3/3 and 12/12 buys this cycle
 * hit max_open_per_wallet — froze the book while total opens were only 6/12.
 * Raise 3 → 5 so an active mid-tier wallet can keep sampling; mark/rug/
 * live-below-tx/dup-mint safety gates stay on. Max open 12 + 60% exposure still bind.
 */
export const LEARNING_MAX_OPEN_PER_WALLET = 5;
/** Replaces MAX_OPEN_UNPROVEN_TOTAL=1: explorers may fill all open slots.
 * Learning 2026-09-28 ~16:06 MDT: with ZERO this-book proven printers, reserving
 * 2 slots for proven froze the book (max_open_unproven_total blocked 4 of 20
 * buys while 10/10 explorers sat open). Raise unproven = max open so learning
 * keeps sampling; proven bags still share the same pool when they appear.
 * Learning 2026-09-28 ~16:49 MDT: 12/12 explorers sat open and 7/10 buys hit
 * max_open_unproven_total — raise to 16 so learning keeps sampling ($10 size,
 * cash ~$745) while mark/rug/live-below-tx/dup-mint safety gates stay on.
 * 2026-09-29 ~16:50 MDT: max open 16 → 12 with bigger bags (unproven total tracks it).
 */
export const LEARNING_MAX_OPEN_UNPROVEN_TOTAL = LEARNING_MAX_OPEN_POSITIONS;
/** Refuse copy when live is ≥25% below tx-implied entry (legacy 15%). */
export const LEARNING_UNDERWATER_REFUSE_PCT = 0.25;
/** Short per-mint re-entry cooldown after SL / time-stop / prefer-scrub. */
export const LEARNING_MINT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
/** Proven-size cooldown after TP / rug_gap (legacy = MAX_HOLD 6h). */
export const LEARNING_PROVEN_SIZE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
/** Proven requires net+ AND ≥ this many market closes on the book. */
export const LEARNING_PROVEN_MIN_CLOSES = 2;
/** Learning bleed ban: pure-loss after this many market closes, or net ≤ deep.
 * Learning 2026-09-28 ~17:24 MDT: −$30 froze cap (3W/−$30.12 mixed printer) via
 * wallet_paper_bleed on a buy this cycle — raise to −$40 (matches legacy +
 * paperBook mixed-printer intent) so printers with wins keep exploring at $10.
 */
export const LEARNING_BLEED_MIN_CLOSES = 4;
export const LEARNING_DEEP_BLEED_USD = -40;
/** Partial TP: realize this fraction at +winPct; remainder trails. */
export const LEARNING_PARTIAL_TP_FRACTION = 0.5;
/** Trailing stop on the remainder: exit when price falls this far from peak (floored at breakeven). */
export const LEARNING_TRAIL_PCT = 0.1;
/** Auto promote/demote + TP/SL tune only once this many learning trades closed. */
export const LEARNING_MIN_CLOSES_FOR_TUNING = 20;

/**
 * ============ 2026-09-28 ~21:00 MDT: rug filter / replay v2 / suspension ============
 * Analysis of the $1000 book (n=39 learning closes): all 8 deep rugs (≤ −50%)
 * were token age < 25m, entry mcap $17k–$298k, liquidity $11k–$50k. Winners were
 * older, deeper, or bonding-curve micro. Rule below blocked 8/8 deep rugs, 0 winners,
 * +$76.48 in-sample. Every blocked candidate is logged as a SHADOW trade (marked like
 * a real bag, never touches cash/equity) so the rule can be validated out-of-sample.
 */
/**
 * Learning 2026-09-29 ~03:25 MDT: ily's p/acc (age 33.3m, mcap $150.7k, liq $36.5k)
 * rugged −98% in ~10 min (−$49.07 at proven $50) — missed the old 30m cutoff by
 * 3 minutes. Evidence in the 30–60m / liq<$100k / mcap≥$15k band on the book:
 * n=4 (1 deep rug, 2 small trail winners +$2.55 total at $5 remaining, 1 −$1.50
 * source-sell) → not contradictory; cutoff widened 30m → 60m. Revert = set to 30.
 */
export const RUG_FILTER_MAX_AGE_MIN = 60;
export const RUG_FILTER_MIN_MCAP_USD = 15_000;
export const RUG_FILTER_MAX_LIQ_USD = 100_000;
/**
 * Young-thin size cap (2026-09-29): a buy in a token younger than this with
 * liquidity < RUG_FILTER_MAX_LIQ_USD can never exceed the explorer size, even
 * for a proven wallet. Fires (logged as SIZE_CAP_YOUNG_THIN_TAG) only when the
 * rug filter did not already skip the buy (e.g. mcap < $15k).
 */
export const YOUNG_THIN_CAP_AGE_MIN = 60;
/** Stays $10 regardless of the explorer size bump (2026-09-29 bigger-bags change). */
export const YOUNG_THIN_SIZE_CAP_USD = 10;
export const SIZE_CAP_YOUNG_THIN_TAG = "size_cap_young_thin_pool";
export function matchesYoungThinPool(f: RugProfileInput | null | undefined): boolean {
  if (!f) return false;
  const age = f.tokenAgeMinutes;
  const liq = f.entryLiquidityUsd;
  if (age == null || liq == null) return false;
  if (![age, liq].every(Number.isFinite)) return false;
  return age < YOUNG_THIN_CAP_AGE_MIN && liq < RUG_FILTER_MAX_LIQ_USD;
}
export interface RugProfileInput {
  tokenAgeMinutes?: number | null;
  entryMcapUsd?: number | null;
  entryLiquidityUsd?: number | null;
}
/**
 * Fresh-pumped / thin-pool profile: age < RUG_FILTER_MAX_AGE_MIN (60m) AND mcap ≥ $15k AND liquidity < $100k.
 * Requires all three fields recorded — unknown data never trips the filter.
 */
export function matchesRugProfile(f: RugProfileInput | null | undefined): boolean {
  if (!f) return false;
  const age = f.tokenAgeMinutes;
  const mcap = f.entryMcapUsd;
  const liq = f.entryLiquidityUsd;
  if (age == null || mcap == null || liq == null) return false;
  if (![age, mcap, liq].every(Number.isFinite)) return false;
  return age < RUG_FILTER_MAX_AGE_MIN && mcap >= RUG_FILTER_MIN_MCAP_USD && liq < RUG_FILTER_MAX_LIQ_USD;
}
/** Cap on concurrently open shadow trades (each costs one price fetch per mark). */
export const MAX_OPEN_SHADOW_POSITIONS = 24;

/**
 * Fixed rug threshold (was 2× lossPct, which labelled −20% stop gaps as rugs at SL −10%).
 * Any mark ≤ −30% exits immediately (even inside open-grace) and is labelled rug_gap;
 * learning analysis classifies a close as a rug when realized ≤ −30%.
 */
export const RUG_GAP_PCT = 0.3;

/**
 * Replay v2 (TP/SL auto-tune). Observed stop overshoot at 15-min polling: "SL −10%"
 * fills averaged −15.0% (n=7), "SL −15%" −19.7% (n=5) → model stop fills at
 * −(sl + 5pp). TP credit only when a recorded MARK peak touched TP (exits above TP
 * via source-sell are credited at their actual value, not TP), with the learning
 * partial (50% at TP, remainder clamped to [breakeven, peak] using actual exit).
 */
export const REPLAY_VERSION = 2;
export const STOP_FILL_OVERSHOOT_PCT = 0.05;
/** TP/SL stay pinned at base WIN_PCT/LOSS_PCT until this many non-rug qualifying closes. */
export const LEARNING_MIN_NONRUG_CLOSES_FOR_TPSL = 50;
/**
 * Outage-held: a close whose hold exceeds MAX_HOLD + 1h cannot be a normal 6h
 * time-stop — the scheduler was down (Sep 24 ~16:00 → Sep 28 14:28 MDT, ~95h holds).
 * Excluded from replay and wallet suspension.
 */
export const OUTAGE_HOLD_MINUTES = MAX_HOLD_HOURS * 60 + 60;

/**
 * Wallet SUSPENSION (replaces archive-on-demote). Suspended wallets stay in
 * TRACKED_WALLETS and keep being polled; their buys become shadow trades, and
 * shadow closes count toward re-evaluation so a wallet can come back automatically.
 * Qualifying closes exclude scrub_*, mark_unavailable, outage-held, and rugs whose
 * entry matched the rug-filter profile (the filter now blocks those at entry).
 */
export const SUSPEND_MIN_QUALIFYING_CLOSES = 12; // 2026-10-01 restart: 8 → 12 (was too trigger-happy)
export const SUSPEND_MAX_WIN_RATE = 0.25;
/** Never suspend below this many active (non-suspended) tracked wallets. */
export const MIN_ACTIVE_WALLETS = 6; // 2026-10-01 restart: 4 → 6

export interface CopyPolicy {
  name: "learning" | "legacy";
  explorerSizeUsd: number;
  provenSizeUsd: number;
  maxOpenPositions: number;
  maxOpenPerWallet: number;
  maxOpenUnprovenTotal: number;
  /** Total open cost ceiling as a fraction of equity (1 = no extra ceiling beyond cash). */
  maxExposurePctOfEquity: number;
  /** Apply liquidity floors to the bigger sizes (learning bigger-bags rule). */
  liquidityTieredSizing: boolean;
  /** legacy explorer_needs_this_book_win gate */
  requireBookWinForExplorer: boolean;
  /** legacy scrub_prefer_better_unproven displacement */
  allowExplorerDisplace: boolean;
  underwaterRefusePct: number;
  mintCooldownMs: number;
  provenSizeCooldownMs: number;
  provenMinCloses: number;
  bleedMinCloses: number;
  deepBleedUsd: number;
  partialTpFraction: number;
  trailPct: number;
}

export const LEGACY_POLICY: CopyPolicy = {
  name: "legacy",
  explorerSizeUsd: COPY_SIZE_USD,
  provenSizeUsd: COPY_SIZE_PROVEN_USD,
  maxOpenPositions: MAX_OPEN_POSITIONS,
  maxOpenPerWallet: MAX_OPEN_PER_WALLET,
  maxOpenUnprovenTotal: MAX_OPEN_UNPROVEN_TOTAL,
  maxExposurePctOfEquity: 1,
  liquidityTieredSizing: false,
  requireBookWinForExplorer: true,
  allowExplorerDisplace: true,
  underwaterRefusePct: LOSS_PCT,
  mintCooldownMs: RECENT_SL_MINT_COOLDOWN_MS,
  provenSizeCooldownMs: PROVEN_SIZE_COOLDOWN_MS,
  provenMinCloses: 1,
  bleedMinCloses: 2,
  deepBleedUsd: -40,
  partialTpFraction: 0,
  trailPct: 0,
};

export const LEARNING_POLICY: CopyPolicy = {
  name: "learning",
  explorerSizeUsd: LEARNING_EXPLORER_SIZE_USD,
  provenSizeUsd: LEARNING_PROVEN_SIZE_USD,
  maxOpenPositions: LEARNING_MAX_OPEN_POSITIONS,
  maxOpenPerWallet: LEARNING_MAX_OPEN_PER_WALLET,
  maxOpenUnprovenTotal: LEARNING_MAX_OPEN_UNPROVEN_TOTAL,
  maxExposurePctOfEquity: MAX_OPEN_EXPOSURE_PCT_OF_EQUITY,
  liquidityTieredSizing: true,
  requireBookWinForExplorer: false,
  allowExplorerDisplace: false,
  underwaterRefusePct: LEARNING_UNDERWATER_REFUSE_PCT,
  mintCooldownMs: LEARNING_MINT_COOLDOWN_MS,
  provenSizeCooldownMs: LEARNING_PROVEN_SIZE_COOLDOWN_MS,
  provenMinCloses: LEARNING_PROVEN_MIN_CLOSES,
  bleedMinCloses: LEARNING_BLEED_MIN_CLOSES,
  deepBleedUsd: LEARNING_DEEP_BLEED_USD,
  partialTpFraction: LEARNING_PARTIAL_TP_FRACTION,
  trailPct: LEARNING_TRAIL_PCT,
};

let activePolicy: CopyPolicy = LEARNING_MODE ? LEARNING_POLICY : LEGACY_POLICY;
/** Policy used by default by paperBook gates (tests may swap it). */
export function getActivePolicy(): CopyPolicy {
  return activePolicy;
}
export function setActivePolicy(p: CopyPolicy): void {
  activePolicy = p;
}

/** Live venue mark sources (not entry-tx estimates). */
export const LIVE_MARK_SOURCES = new Set([
  "dexscreener",
  "pumpfun_mcap",
  "pumpfun_price_usd",
]);
/** How far back to look on the very first cycle (avoid dumping entire history). */
export const INITIAL_LOOKBACK_MINUTES = 90;
/** Max signatures fetched per wallet per cycle. */
export const SIGS_PER_WALLET = 25;
/** Max successful txs to fully decode per wallet per cycle. */
export const TX_DECODE_LIMIT = 12;

/**
 * Active tracked wallets = Pump.fun Leaderboard 1W mid-tier / smaller-following
 * consistent printers (not mega whales). Source label:
 * `pumpfun_leaderboard_1w_midtier` (scraped ~2026-09-22 22:55 MDT).
 *
 * Continuity policy: keep existing open paper positions mark-to-market for fair
 * PnL continuity; only NEW copies come from this mid-tier active list. Prior
 * mega top-6 whales are in WHALES_ARCHIVED (addresses kept, not polled).
 */
/** Hard per-copy cap for re-admitted wallets: raised $10 → $25 (= explorer size) 2026-09-29 ~16:50 MDT. */
export const READMIT_SIZE_CAP_USD = 25;
export const TRACKED_WALLETS: TrackedWallet[] = [
  {
    address: "HsQnUgdVVUJNTTEe5mzpQFFi55oXq4UwcjByEFb3Rd52",
    label: "counter17",
    justification:
      "Promoted 2026-09-24 ~10:42 MDT — rotation rank #8 (+$417,438 1W). Replaces passthedutcher bleed (0W/2L market WAGMI/DUEL ~-$6.14; wallet_paper_bleed already blocking; scrub churn on GP).",
    source: "pumpfun_leaderboard_1w_rotation_promote",
    provisional: false,
    weeklyNetPnlUsd: 417437.92,
    leaderboardRank: 8,
  },
  {
    address: "CXhZnEbWmaiK8GE8uYqDyQmcGS9SANqsuLJMYSYnLmGR",
    label: "CoinSmuggler",
    justification:
      "pump.fun leaderboard 1W mid-tier rank #18 (+$209,280, followers 4666). Preferred mid-tier / smaller-following consistent printer (not mega whale).",
    source: "pumpfun_leaderboard_1w_midtier",
    provisional: false,
    weeklyNetPnlUsd: 209280,
    leaderboardRank: 18,
    followers: 4666,
  },
  {
    address: "AcoNeFQsTPYs7ZrH8RMWaxxGJTTQJJ4H5aTXmptaz5UK",
    label: "ily",
    justification:
      "Promoted 2026-09-23 ~08:24 MDT — mid-tier 1W candidate; RPC very active (13 ok sigs / 6h, newest ~2m). Replaces throatycrab1008 (paper bleed).",
    source: "pumpfun_leaderboard_1w_midtier",
    provisional: false,
  },
  // 2026-09-28 ~21:10 MDT: old auto-demote replaced by SUSPENSION (qualify.ts). Suspended
  // wallets STAY in this list (polled; buys shadow-tracked) — do not archive on suspension.
  // The 8 wallets archived tonight all pass the new rule and are restored at the explorer size cap ($10 until 2026-09-29 ~16:50 MDT, now $25):
  {
    address: "8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6",
    label: "Cooker",
    justification:
      "Restored 2026-09-28 ~21:10 MDT at the explorer size cap — passes the new suspension rule (0/2 W −$4.03 (3 of its 5 closes were outage-held ~95h holds); needs ≥12 qualifying closes, net<0, WR<25% to suspend). Archived earlier tonight by the old 4-close auto-demote.",
    source: "learning_readmit",
    provisional: false,
    sizeCapUsd: READMIT_SIZE_CAP_USD,
  },
  {
    address: "uDYvqwgSxNDMKGPaMJ7JqyadEg1EhxkuCx9hbLSanHA",
    label: "passthedutcher",
    justification:
      "Restored 2026-09-28 ~21:10 MDT at the explorer size cap — passes the new suspension rule (0 qualifying closes (all 3 learning closes outage-held; legacy closes not learning-tagged); needs ≥12 qualifying closes, net<0, WR<25% to suspend). Archived earlier tonight by the old 4-close auto-demote.",
    source: "learning_readmit",
    provisional: false,
    sizeCapUsd: READMIT_SIZE_CAP_USD,
  },
  {
    address: "6HJetMbdHBuk3mLUainxAPpBpWzDgYbHGTS2TqDAUSX2",
    label: "onlyljc",
    justification:
      "Restored 2026-09-28 ~21:10 MDT at the explorer size cap — passes the new suspension rule (0 qualifying closes (only close TRTF was a rug-filter-profile rug); needs ≥12 qualifying closes, net<0, WR<25% to suspend). Archived earlier tonight by the old 4-close auto-demote.",
    source: "learning_readmit",
    provisional: false,
    sizeCapUsd: READMIT_SIZE_CAP_USD,
  },
  {
    address: "DNsh1UfJdxmze6T6GV9QK5SoFm7HsM5TRNxVuwVgo8Zj",
    label: "Hash",
    justification:
      "Restored 2026-09-28 ~21:10 MDT at the explorer size cap — passes the new suspension rule (1/4 W −$2.69 (FOMOWTRLMN filter-profile rug + MUGSHOT outage excluded); needs ≥12 qualifying closes, net<0, WR<25% to suspend). Archived earlier tonight by the old 4-close auto-demote.",
    source: "learning_readmit",
    provisional: false,
    sizeCapUsd: READMIT_SIZE_CAP_USD,
  },
  {
    address: "CAPn1yH4oSywsxGU456jfgTrSSUidf9jgeAnHceNUJdw",
    label: "cap",
    justification:
      "Restored 2026-09-28 ~21:10 MDT at the explorer size cap — passes the new suspension rule (1/2 W +$2.92 (CRYS / BUJC / Collectinu filter-profile rugs excluded); needs ≥12 qualifying closes, net<0, WR<25% to suspend). Archived earlier tonight by the old 4-close auto-demote.",
    source: "learning_readmit",
    provisional: false,
    sizeCapUsd: READMIT_SIZE_CAP_USD,
  },
  {
    address: "4fZFcK8ms3bFMpo1ACzEUz8bH741fQW4zhAMGd5yZMHu",
    label: "Rilsio",
    justification:
      "Restored 2026-09-28 ~21:10 MDT at the explorer size cap — passes the new suspension rule (0/2 W −$3.01 (JAKU / BUNTRUMP filter-profile rugs excluded); needs ≥12 qualifying closes, net<0, WR<25% to suspend). Archived earlier tonight by the old 4-close auto-demote.",
    source: "learning_readmit",
    provisional: false,
    sizeCapUsd: READMIT_SIZE_CAP_USD,
  },
  {
    address: "DjM7Tu7whh6P3pGVBfDzwXAx2zaw51GJWrJE3PwtuN7s",
    label: "LUKEY",
    justification:
      "Restored 2026-09-28 ~21:10 MDT at the explorer size cap — passes the new suspension rule (0/3 W −$5.88 (mark_unavailable $0 close excluded); needs ≥12 qualifying closes, net<0, WR<25% to suspend). Archived earlier tonight by the old 4-close auto-demote.",
    source: "learning_readmit",
    provisional: false,
    sizeCapUsd: READMIT_SIZE_CAP_USD,
  },
  {
    address: "4xY9T1Q7foJzJsJ6YZDSsfp9zkzeZsXnxd45SixduMmr",
    label: "zeropnl",
    justification:
      "Restored 2026-09-28 ~21:10 MDT at the explorer size cap — passes the new suspension rule (0/4 W −$4.21; needs ≥12 qualifying closes, net<0, WR<25% to suspend). Archived earlier tonight by the old 4-close auto-demote.",
    source: "learning_readmit",
    provisional: false,
    sizeCapUsd: READMIT_SIZE_CAP_USD,
  },
  // Learning re-admits archived 2026-09-28 ~16:06 MDT (passthedutcher/onlyljc/Cooker → bleeders).
  // Remaining kolscan.io 7d mid-ranks (RPC-verified 2026-09-24 ~15:36 MDT).
  // Hash archived bleed 2026-09-28 ~17:24 MDT (auto-demote 1/6 W −$13.45).
  // cap archived bleed 2026-09-28 ~18:05 MDT (auto-demote 1/5 W −$24.10; BUJC rug).
  // Rilsio archived bleed 2026-09-28 ~19:18 MDT (auto-demote 0/4 W −$22.36; JAKU+BUNTRUMP rugs).
  // LUKEY archived bleed 2026-09-28 ~20:05 MDT (auto-demote 0/4 W −$5.88; SWORDJAK rug).
  // zeropnl archived bleed 2026-09-28 ~20:55 MDT (auto-demote 0/4 W −$4.21; DWIF SL).
  {
    address: "FqamE7xrahg7FEWoByrx1o8SeyHt44rpmE6ZQfT7zrve",
    label: "EustazZ",
    justification:
      "kolscan.io 7d #18 (+276 SOL, 460W/300L) and 30d #24 (+829 SOL). RPC ~15:36 MDT: 30 ok sigs / 6h, newest ~4m; 6 decoded → 3 buys + 1 sell over 3 mints (e.g. sig CJ7irBpu…). Note: that sig also moved Idontpaytaxes (2T5N…) tokens — likely linked; only EustazZ added.",
    source: "kolscan_leaderboard_midtier",
    provisional: false,
    leaderboardRank: 18,
  },
];

/**
 * Prior mega top-6 (ranks 1–6) archived 2026-09-22 ~22:55 MDT.
 * Addresses kept for reference / possible future rotation; NOT polled as active.
 */
export const WHALES_ARCHIVED: TrackedWallet[] = [
  {
    address: "4ugDhHJ8XDXAeABmrNmGffFaLbJb9BkPyiFGVSV9ocwo",
    label: "The__Solstice",
    justification:
      "Former active mega whale — pump.fun leaderboard 1W rank #1 (+$3,537,723.94). Archived to whales_archived; not polled.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    weeklyNetPnlUsd: 3537723.94,
    leaderboardRank: 1,
  },
  {
    address: "4UrFSCrGxgoCtCUBAEZq7ZmPK3Pczkxx7PwYnkBMi1KR",
    label: "J777Crypto",
    justification:
      "Former active mega whale — pump.fun leaderboard 1W rank #2 (+$1,901,686.63). Archived; not polled.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    weeklyNetPnlUsd: 1901686.63,
    leaderboardRank: 2,
  },
  {
    address: "Bmi9zf27MNN5pjCtyv2Y15TDQoYgcbcmPTxvEoQ6UwWs",
    label: "Crypto_Keys",
    justification:
      "Former active mega whale — pump.fun leaderboard 1W rank #3 (+$1,194,564.53). Archived; not polled.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    weeklyNetPnlUsd: 1194564.53,
    leaderboardRank: 3,
  },
  {
    address: "49MHZz9c1mE1ePTcLxBWPjf7KKzt3Ntd25JnspKvV8vL",
    label: "OldManPervert",
    justification:
      "Former active mega whale — pump.fun leaderboard 1W rank #4 (+$896,912.76). Archived; not polled.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    weeklyNetPnlUsd: 896912.76,
    leaderboardRank: 4,
  },
  {
    address: "2M2vLX34LXMg24dMEnjWHvRXS1tshpEDRWzmXgV8ENNZ",
    label: "SossaDotKek",
    justification:
      "Former active mega whale — pump.fun leaderboard 1W rank #5 (+$868,176.90). Archived; not polled.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    weeklyNetPnlUsd: 868176.9,
    leaderboardRank: 5,
  },
  {
    address: "EVqxB3F6iUBeWsTpBFQqWwxpqUS8s4NrzgxBvQ2VRbTq",
    label: "faposhi__",
    justification:
      "Former active mega whale — pump.fun leaderboard 1W rank #6 (+$484,264.78). Archived; not polled.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    weeklyNetPnlUsd: 484264.78,
    leaderboardRank: 6,
  },
];

/**
 * Ranks 7–15 for rotation / promotion when desired.
 * Not polled unless moved into TRACKED_WALLETS.
 */

/**
 * Mid-tier wallets dropped from active poll after clear paper bleed.
 * Opens already taken are marked to market / mark_unavailable until closed;
 * no NEW copies from these addresses.
 */
export const BLEEDERS_ARCHIVED: TrackedWallet[] = [
  {
    address: "9qpucJgTkTVSbMPksG4fequu9STgFxr9AQmLN25MwiBV",
    label: "FrostxXBT",
    justification:
      "Archived bleed 2026-09-23 ~15:00 MDT. Paper closed 0/2 (TROLL time-stop -$4.80 + scrub_cooldown_reentry -$0.82) realized ~-$5.62; wallet_paper_bleed ≥2 already blocks new copies — free poll slot for active mid-tier.",
    source: "pumpfun_leaderboard_1w_rotation_promote",
    provisional: false,
    leaderboardRank: 15,
  },
  {
    address: "23LAQiqYP77uDchq5k4W2SPUuZ7f1du9rt7KGUkXa36V",
    label: "TylerD",
    justification:
      "Archived bleed 2026-09-23 ~14:00 MDT. Paper closed 0/2 (BLUF SL -$8.26, LEVERHYPPO SL -$8.11) realized ~-$16.37 within hours of open; still opened SALLY after 2 SLs because bleed gate was ≥3. Pattern matches DecentralizeDie — stop new copies, free slots. PEPE open was stuck flat 0% on pumpfun_mcap.",
    source: "pumpfun_leaderboard_1w_midtier",
    provisional: false,
  },
  {
    address: "J23qr98GjGJJqKq9CBEnyRhHbmkaVxtTJNNxKu597wsA",
    label: "gr3gor14n",
    justification:
      "Archived bleed 2026-09-23 ~13:00 MDT. Paper closed 0/5 (STUCK/CAGRIPPA/BuffCat/Rise/EPEP) realized ~-$61.14; EPEP rug_gap -$49.50 after asymmetric marks finally landed. Pattern matches DecentralizeDie/throatycrab — stop new copies, free slots for active mid-tier.",
    source: "pumpfun_leaderboard_1w_rotation_promote",
    provisional: false,
    leaderboardRank: 14,
  },
  {
    address: "95CwNd3p9TtUmNesnri1Tf5KzS58SzgDZJCDHmTiwgE2",
    label: "DecentralizeDie",
    justification:
      "Archived bleed 2026-09-23 ~09:22 MDT. Paper closed: DUEL SL -$13.90, WISE SL -$19.72 (realized ~-$33.62) within ~1h of open; immediately re-copied DUEL (open −12.6%). Pattern matches throatycrab/cashmaxing — stop new copies, free slots for active mid-tier.",
    source: "pumpfun_leaderboard_1w_midtier",
    provisional: false,
    weeklyNetPnlUsd: 135414,
    leaderboardRank: 29,
    followers: 1360,
  },
  {
    address: "29yFzeBZgxf5zqrAkKXwgZtQehRf4pL8WbV2nRJikbw8",
    label: "throatycrab1008",
    justification:
      "Archived bleed 2026-09-23 ~08:24 MDT. Paper closed: FAP SL -$40.65, JOTC time-stop -$1.74 (realized ~-$42); JEAN2000 still open ~-11%. Pattern matches cashmaxing drop — stop new copies, free slots for active mid-tier.",
    source: "pumpfun_leaderboard_1w_midtier",
    provisional: false,
    weeklyNetPnlUsd: 143212,
    leaderboardRank: 28,
    followers: 7079,
  },
  {
    address: "FtJ4yajd6fPcvFdtEsAoUukcUn6nD1qhEFevSQDcauHz",
    label: "cashmaxing",
    justification:
      "Fully unpolled 2026-09-23 ~04:50 MDT (0 opens left). Was acceptNewCopies=false after 3/3 closed SL ~$-55; HH7 unmarkable. Address kept in bleeders_archived only.",
    source: "pumpfun_leaderboard_1w_midtier",
    provisional: false,
    weeklyNetPnlUsd: 152868,
    leaderboardRank: 27,
    followers: 4816,
  },
];


/**
 * Mid-tier wallets removed from active poll after going quiet (no recent sigs).
 * Kept for reference; NOT polled. Replaced 2026-09-23 ~03:45 MDT.
 */
export const SILENT_ARCHIVED: TrackedWallet[] = [
  {
    address: "Frk9APGk2RkutWrBCKueWB4UQBA5ZTJdgtRdNZSmFX1i",
    label: "Dumpcomesfast",
    justification:
      "Was mid-tier #17; archived silent — 0 sigs in 6h, newest ~18h at swap time. 2026-09-23 ~03:45 MDT.",
    source: "pumpfun_leaderboard_1w_midtier",
    provisional: false,
    weeklyNetPnlUsd: 212549,
    leaderboardRank: 17,
    followers: 1476,
  },
  {
    address: "3kfyzegbWkgAdLWtywmGcLFcUw2RPzt3i1EEzdXYtYM8",
    label: "ThePatientOne",
    justification:
      "Was mid-tier #26; archived silent — 0 sigs in 6h, newest ~15h at swap time. 2026-09-23 ~03:45 MDT.",
    source: "pumpfun_leaderboard_1w_midtier",
    provisional: false,
    weeklyNetPnlUsd: 159915,
    leaderboardRank: 26,
    followers: 5459,
  },
  {
    address: "2NsevsKWiaDtEiYF5gGLCVGNBwsLNibgppoiVPHHYrqq",
    label: "y22",
    justification:
      "Archived silent 2026-09-23 ~17:56 MDT. Was rotation promote #13; RPC quiet (1 ok sig / 6h, newest ~286m) with 0 closed paper copies under proven-only. Free poll slot for active mid-tier.",
    source: "pumpfun_leaderboard_1w_rotation_promote",
    provisional: false,
    leaderboardRank: 13,
  },
  {
    address: "24L6uekgvsQRgT41DZRhahEAAVnkseTT7x4qyigC3HvH",
    label: "Nexybtw",
    justification:
      "Archived quieting 2026-09-23 ~18:54 MDT. Was rotation promote #9; RPC quieting (4 ok sigs / 6h, newest ~271m) with 0 closed paper copies under proven-only. Free poll slot for active mid-tier (cap #7).",
    source: "pumpfun_leaderboard_1w_rotation_promote",
    provisional: false,
    weeklyNetPnlUsd: 391493.79,
    leaderboardRank: 9,
  },
  {
    address: "9djgawmgpGrzt7DQoJ6tA2YW4gQyt3yH19uVZ3e2T3JJ",
    label: "retardedgains",
    justification:
      "Archived quieting 2026-09-23 ~23:51 MDT. Was rotation promote #11; RPC quieting (4 ok sigs / 6h, newest ~306m) with 0 closed paper copies on do-or-die $1000 book. Free poll slot for active mid-tier (onlyljc #10).",
    source: "pumpfun_leaderboard_1w_rotation_promote",
    provisional: false,
    leaderboardRank: 11,
  },
];

export const ROTATION_WALLETS: TrackedWallet[] = [
  {
    address: "CAPn1yH4oSywsxGU456jfgTrSSUidf9jgeAnHceNUJdw",
    label: "cap",
    justification:
      "pump.fun leaderboard 1W Net PnL rank #7 (+$469,498.66) — rotation candidate.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    weeklyNetPnlUsd: 469498.66,
    leaderboardRank: 7,
  },
  {
    address: "HsQnUgdVVUJNTTEe5mzpQFFi55oXq4UwcjByEFb3Rd52",
    label: "counter17",
    justification:
      "pump.fun leaderboard 1W Net PnL rank #8 (+$417,437.92) — rotation candidate.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    weeklyNetPnlUsd: 417437.92,
    leaderboardRank: 8,
  },
  {
    address: "24L6uekgvsQRgT41DZRhahEAAVnkseTT7x4qyigC3HvH",
    label: "Nexybtw",
    justification:
      "pump.fun leaderboard 1W Net PnL rank #9 (+$391,493.79) — rotation candidate.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    weeklyNetPnlUsd: 391493.79,
    leaderboardRank: 9,
  },
  {
    address: "6HJetMbdHBuk3mLUainxAPpBpWzDgYbHGTS2TqDAUSX2",
    label: "onlyljc",
    justification:
      "pump.fun leaderboard 1W Net PnL rank #10 (+$340,160.09) — rotation candidate.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    weeklyNetPnlUsd: 340160.09,
    leaderboardRank: 10,
  },
  {
    address: "9djgawmgpGrzt7DQoJ6tA2YW4gQyt3yH19uVZ3e2T3JJ",
    label: "retardedgains",
    justification:
      "pump.fun leaderboard 1W Net PnL rank #11 — rotation candidate.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    leaderboardRank: 11,
  },
  {
    address: "uDYvqwgSxNDMKGPaMJ7JqyadEg1EhxkuCx9hbLSanHA",
    label: "passthedutcher",
    justification:
      "pump.fun leaderboard 1W Net PnL rank #12 — rotation candidate.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    leaderboardRank: 12,
  },
  {
    address: "2NsevsKWiaDtEiYF5gGLCVGNBwsLNibgppoiVPHHYrqq",
    label: "y22",
    justification:
      "pump.fun leaderboard 1W Net PnL rank #13 — rotation candidate.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    leaderboardRank: 13,
  },
  {
    address: "J23qr98GjGJJqKq9CBEnyRhHbmkaVxtTJNNxKu597wsA",
    label: "gr3gor14n",
    justification:
      "pump.fun leaderboard 1W Net PnL rank #14 — rotation candidate.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    leaderboardRank: 14,
  },
  {
    address: "9qpucJgTkTVSbMPksG4fequu9STgFxr9AQmLN25MwiBV",
    label: "FrostxXBT",
    justification:
      "pump.fun leaderboard 1W Net PnL rank #15 — rotation candidate.",
    source: "pumpfun_leaderboard_1w",
    provisional: false,
    leaderboardRank: 15,
  },
];

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const DEFAULT_RPC =
  process.env.SOLANA_RPC_URL?.trim() || "https://solana-rpc.publicnode.com";
