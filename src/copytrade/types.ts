/** Paper copy-trade types. Paper/sim only — no signing, no live swaps. */

export type WalletSeedSource =
  | "public_kol_directory"
  | "provisional_article"
  | "pumpfun_leaderboard_1w"
  | "pumpfun_leaderboard_1w_midtier"
  | "pumpfun_leaderboard_1w_rotation_promote"
  | "kolscan_leaderboard_midtier"
  | "learning_readmit"
  | "manual";

export interface TrackedWallet {
  address: string;
  label: string;
  /** Why this wallet is on the list */
  justification: string;
  source: WalletSeedSource;
  /** If true, address came from public docs/articles without live PnL verification this run */
  provisional: boolean;
  /** Optional weekly Net PnL from pump.fun leaderboard when known */
  weeklyNetPnlUsd?: number;
  /** Leaderboard rank when known (1 = top) */
  leaderboardRank?: number;
  /** Optional pump.fun follower count when known */
  followers?: number;
  /** When false, still poll for marks/exit-follow but do not open new paper copies. Default true. */
  acceptNewCopies?: boolean;
  /** Hard per-copy size cap regardless of proven status (e.g. re-admitted bleeders at $10). */
  sizeCapUsd?: number;
}

export interface WalletBuyEvent {
  walletAddress: string;
  walletLabel: string;
  signature: string;
  blockTime: number | null;
  mint: string;
  tokenAmount: number;
  /** SOL spent by wallet (approx from native balance delta); null if unknown */
  solSpent: number | null;
  /** Entry USD price derived honestly from solSpent * solUsd / tokenAmount when possible */
  entryPriceUsd: number | null;
  observedAt: string;
}

/** Source wallet sold (or reduced) a non-WSOL token — used for exit-follow. */
export interface WalletSellEvent {
  walletAddress: string;
  walletLabel: string;
  signature: string;
  blockTime: number | null;
  mint: string;
  tokenAmount: number;
  /** SOL received by wallet (approx); null if unknown */
  solReceived: number | null;
  /** Exit USD price from solReceived * solUsd / tokens sold when possible */
  exitPriceUsd: number | null;
  observedAt: string;
}

/** Features recorded at entry (and updated while open / at close) for learning analysis. */
export interface LearningFeatures {
  policy: "learning" | "legacy";
  /** Sizing tier at entry */
  walletTier: "proven" | "explorer";
  /** Entry market cap / FDV USD when available (Dex marketCap|fdv or pump.fun usd_market_cap) */
  entryMcapUsd: number | null;
  /** Entry pool liquidity USD when available (Dex liquidity.usd or pump.fun bonding-curve SOL×2) */
  entryLiquidityUsd: number | null;
  /** Token/pair age at entry (minutes) when available */
  tokenAgeMinutes: number | null;
  /** Source wallet tx-implied price (tx_sol_delta) when known */
  txEntryPriceUsd: number | null;
  /** Live venue price at entry when fetched */
  liveEntryPriceUsd: number | null;
  /** (live − tx) / tx — how far price moved vs the source's fill before we copied */
  entrySlippagePct: number | null;
  /** Seconds between source tx blockTime and our paper open */
  signalLagSec: number | null;
  /** Max favorable / adverse unrealized % seen at marks (MFE / MAE) */
  peakPnlPct: number;
  troughPnlPct: number;
  /**
   * % of supply in the 10 largest token accounts (RPC getTokenLargestAccounts /
   * getTokenSupply). Includes pool / bonding-curve accounts. null when unavailable.
   */
  top10HolderPct?: number | null;
  /**
   * Holder count — null: no cheap source (DexScreener / pump.fun coin API do not
   * expose it; exact count needs getProgramAccounts, disabled on public RPC).
   */
  holderCount?: number | null;
  /** Filled at close */
  holdMinutes?: number;
  exitBucket?: string;
  realizedPnlPct?: number;
}

export interface PaperCopyPosition {
  id: string;
  openedAt: string;
  sourceWallet: string;
  sourceWalletLabel: string;
  sourceSignature: string;
  mint: string;
  symbol?: string;
  sizeUsd: number;
  entryPriceUsd: number;
  entryPriceSource: "tx_sol_delta" | "dexscreener" | "pumpfun_mcap";
  quantity: number;
  markPriceUsd: number;
  markSource: string;
  markAt: string;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  status: "open" | "closed_win" | "closed_loss" | "closed_time";
  closedAt?: string;
  closeReason?: string;
  realizedPnlUsd?: number;
  /** Learning-mode feature tags (absent on legacy positions). */
  learning?: LearningFeatures;
  /** Set when the young/thin-pool size cap reduced this copy (e.g. "size_cap_young_thin_pool: $50→$10"). */
  sizeCapTag?: string;
  /** Partial take-profit bookkeeping (learning mode exit tuning). */
  partialTakenAt?: string;
  /** PnL already realized (and returned to cash) by the partial TP leg. */
  partialRealizedPnlUsd?: number;
  /** Size/qty before partial */
  originalSizeUsd?: number;
  originalQuantity?: number;
  /** Highest mark price seen since partial TP (trailing stop anchor). */
  trailPeakPriceUsd?: number;
  /**
   * Present only on SHADOW trades (book.shadowPositions): hypothetical copies that
   * were blocked (rug filter / suspended wallet). Marked like real bags, never
   * touch cash or equity.
   */
  shadow?: { reason: "rug_filter" | "suspended_wallet"; skipReason: string };
}

export interface LearningTuningState {
  computedAt: string;
  learningClosed: number;
  winPct: number;
  lossPct: number;
  promoted: string[];
  /** Deprecated alias of `suspended` (kept for older readers). */
  demoted: string[];
  /** Wallets suspended (still polled; buys shadow-tracked; auto-reinstated when they recover). */
  suspended?: string[];
  /** Replay implementation used for TP/SL (2 = overshoot-aware, 2026-09-28). */
  replayVersion?: number;
  /** True while TP/SL is pinned at base (not enough non-rug qualifying closes). */
  tpSlFrozen?: boolean;
  /** Non-rug qualifying closes counted toward the TP/SL retune gate. */
  nonRugQualifyingCloses?: number;
  notes: string[];
}

export interface CopyBookState {
  version: 1;
  createdAt: string;
  updatedAt: string;
  bankrollUsd: number;
  cashUsd: number;
  /** Fixed USD size per new paper copy */
  copySizeUsd: number;
  /** Take-profit / stop-loss thresholds (fraction, e.g. 0.25 = ±25%) */
  winPct: number;
  lossPct: number;
  /** Max hold hours before time-stop close */
  maxHoldHours: number;
  /** Only consider buys newer than this ISO time (advances each cycle) */
  lastPolledAt: string;
  positions: PaperCopyPosition[];
  seenSignatures: string[];
  cycleCount: number;
  notes: string[];
  /** Learning-mode auto-tune output (after ≥ LEARNING_MIN_CLOSES_FOR_TUNING closes). */
  learningTuning?: LearningTuningState;
  /** Shadow trades (never counted in cash/equity). See PaperCopyPosition.shadow. */
  shadowPositions?: PaperCopyPosition[];
}

export interface CopyCycleArtifact {
  ranAt: string;
  mode: "paper_copytrade";
  realMoney: false;
  learningMode?: boolean;
  policy?: import("./config.js").CopyPolicy;
  learningTuning?: LearningTuningState | null;
  walletsTracked: Array<{
    address: string;
    label: string;
    provisional: boolean;
    justification: string;
  }>;
  newBuysDetected: number;
  newCopiesOpened: number;
  skipped: Array<{ signature: string; reason: string }>;
  openPositions: number;
  closedThisCycle: number;
  equityUsd: number;
  cashUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  positions: PaperCopyPosition[];
  blockers: string[];
  summary: string;
}
