/**
 * 2026-09-28 ~21:10 MDT rules: entry rug filter + shadow trades, TP/SL reset +
 * replay v2 + fixed −30% rug label, wallet suspension (replaces archive).
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const quotes = new Map<string, number | null>();
vi.mock("../src/copytrade/prices.js", async (orig) => {
  const real = await orig<typeof import("../src/copytrade/prices.js")>();
  return {
    ...real,
    getTokenPriceUsd: vi.fn(async (mint: string) => {
      const p = quotes.get(mint);
      return p == null ? null : { priceUsd: p, source: "dexscreener" };
    }),
  };
});

import {
  LEARNING_POLICY,
  LOSS_PCT,
  MAX_OPEN_SHADOW_POSITIONS,
  MIN_ACTIVE_WALLETS,
  RUG_GAP_PCT,
  TRACKED_WALLETS,
  WIN_PCT,
  matchesRugProfile,
  matchesYoungThinPool,
  RUG_FILTER_MAX_AGE_MIN,
  SIZE_CAP_YOUNG_THIN_TAG,
  setActivePolicy,
} from "../src/copytrade/config.js";
import { computeLearningTuning, replayTradePct, shadowReport, analyzeBook, formatReport } from "../src/copytrade/learning.js";
import {
  applyMark,
  createEmptyBook,
  equityOf,
  markOpts,
  markShadowBook,
  openPaperCopy,
  type EntryContext,
} from "../src/copytrade/paperBook.js";
import { getTop10HolderPct, top10PctFrom } from "../src/copytrade/prices.js";
import {
  isOutageHeld,
  isQualifyingLearningClose,
  isRugClose,
  meetsSuspensionCriteria,
  walletSuspensionStats,
} from "../src/copytrade/qualify.js";
import type { CopyBookState, PaperCopyPosition, WalletBuyEvent } from "../src/copytrade/types.js";

beforeEach(() => {
  setActivePolicy(LEARNING_POLICY);
  quotes.clear();
});

const NOW = new Date("2026-09-28T22:00:00.000Z");
const w = (n: number) => `RWallet${String(n).padStart(3, "0")}`.padEnd(44, "1");
const m = (n: number) => `RMint${String(n).padStart(4, "0")}`.padEnd(44, "1");
let sigN = 0;
function buy(wn: number, mn: number): WalletBuyEvent {
  return {
    walletAddress: w(wn),
    walletLabel: `w${wn}`,
    signature: `rsig-${wn}-${mn}-${sigN++}`,
    blockTime: Math.floor(NOW.getTime() / 1000) - 60,
    mint: m(mn),
    tokenAmount: 1000,
    solSpent: 0.1,
    entryPriceUsd: null,
    observedAt: NOW.toISOString(),
  };
}
function ctx(ageMin: number, mcap: number | null, liq: number | null): EntryContext {
  return {
    txEntryPriceUsd: null,
    liveEntryPriceUsd: 1,
    mcapUsd: mcap,
    liquidityUsd: liq,
    createdAtMs: NOW.getTime() - ageMin * 60_000,
  };
}
function closed(
  wallet: string,
  pnl: number,
  over: {
    reason?: string;
    hold?: number;
    peak?: number;
    trough?: number;
    age?: number;
    mcap?: number;
    liq?: number;
    shadow?: PaperCopyPosition["shadow"];
  } = {},
): PaperCopyPosition {
  const pct = pnl / 10;
  const reason = over.reason ?? (pnl > 0 ? "trail_stop 10% after partial TP" : "SL -15%");
  return {
    id: `x-${sigN++}`,
    openedAt: "2026-09-28T20:00:00.000Z",
    closedAt: "2026-09-28T21:00:00.000Z",
    sourceWallet: wallet,
    sourceWalletLabel: wallet.slice(0, 10),
    sourceSignature: `cs-${sigN++}`,
    mint: `CM${sigN++}`.padEnd(44, "1"),
    symbol: "X",
    sizeUsd: 10,
    entryPriceUsd: 1,
    entryPriceSource: "dexscreener",
    quantity: 10,
    markPriceUsd: 1 + pct,
    markSource: "dexscreener",
    markAt: "2026-09-28T21:00:00.000Z",
    unrealizedPnlUsd: 0,
    unrealizedPnlPct: pct,
    status: pnl > 0 ? "closed_win" : pnl < 0 ? "closed_loss" : "closed_time",
    closeReason: reason,
    realizedPnlUsd: pnl,
    learning: {
      policy: "learning",
      walletTier: "explorer",
      entryMcapUsd: over.mcap ?? 3_000,
      entryLiquidityUsd: over.liq ?? 3_000,
      tokenAgeMinutes: over.age ?? 90,
      txEntryPriceUsd: null,
      liveEntryPriceUsd: 1,
      entrySlippagePct: null,
      signalLagSec: 60,
      peakPnlPct: over.peak ?? Math.max(0, pct),
      troughPnlPct: over.trough ?? Math.min(0, pct),
      holdMinutes: over.hold ?? 60,
      exitBucket: "sl",
      realizedPnlPct: pct,
    },
    ...(over.shadow ? { shadow: over.shadow } : {}),
  };
}
const bookWith = (positions: PaperCopyPosition[], extra: Partial<CopyBookState> = {}): CopyBookState => ({
  ...createEmptyBook(NOW),
  positions,
  ...extra,
});

describe("1. entry rug filter + shadow trades", () => {
  it("matches only age<60m AND mcap≥$15k AND liq<$100k, with all three recorded", () => {
    const f = (a: number | null, mc: number | null, l: number | null) =>
      matchesRugProfile({ tokenAgeMinutes: a, entryMcapUsd: mc, entryLiquidityUsd: l });
    expect(f(5, 122_150, 30_677)).toBe(true); // BUNTRUMP
    expect(f(23, 17_017, 11_493)).toBe(true); // Collectinu
    expect(f(18, 1_156_205, 145_849)).toBe(false); // HOOKED winner (deep pool)
    expect(f(31, 25_964, 12_760)).toBe(true); // Nibs winner (age 31m now inside the 60m window)
    expect(f(33.3, 150_709, 36_481)).toBe(true); // p/acc rug 2026-09-29 (missed 30m cutoff by 3 min)
    expect(f(59.99, 50_000, 50_000)).toBe(true);
    expect(f(60, 50_000, 50_000)).toBe(false);
    expect(RUG_FILTER_MAX_AGE_MIN).toBe(60);
    expect(f(10, 2_800, 2_817)).toBe(false); // bonding-curve micro
    expect(f(29.99, 15_000, 99_999)).toBe(true);
    expect(f(30, 15_000, 50_000)).toBe(true);
    expect(f(10, 14_999, 50_000)).toBe(false);
    expect(f(10, 50_000, 100_000)).toBe(false);
    expect(f(null, 50_000, 20_000)).toBe(false);
    expect(f(10, null, 20_000)).toBe(false);
    expect(f(10, 50_000, null)).toBe(false);
  });

  it("skips with its own reason, logs a shadow trade, and leaves cash/equity untouched", () => {
    const book = createEmptyBook(NOW);
    const before = equityOf(book);
    const r = openPaperCopy(book, buy(1, 1), 1, "dexscreener", "RUGGY", NOW, { entryContext: ctx(5, 100_000, 25_000) });
    expect(r.skipReason).toBe("rug_filter_fresh_thin_pool");
    expect(r.opened).toBeNull();
    expect(r.book.positions).toHaveLength(0);
    expect(r.book.cashUsd).toBe(book.cashUsd);
    expect(equityOf(r.book)).toEqual(before);
    const s = r.book.shadowPositions!;
    expect(s).toHaveLength(1);
    expect(s[0]!.shadow).toEqual({ reason: "rug_filter", skipReason: "rug_filter_fresh_thin_pool" });
    expect(s[0]!.sizeUsd).toBe(10);
    expect(s[0]!.learning!.tokenAgeMinutes).toBeCloseTo(5, 5);
    expect(s[0]!.learning!.entryLiquidityUsd).toBe(25_000);
    expect(r.book.seenSignatures).toHaveLength(1);
  });

  it("still opens deep-pool young tokens and older thin tokens", () => {
    const a = openPaperCopy(createEmptyBook(NOW), buy(1, 2), 1, "dexscreener", "HOOKED", NOW, { entryContext: ctx(18, 1_156_205, 145_849) });
    expect(a.opened).not.toBeNull();
    const b = openPaperCopy(createEmptyBook(NOW), buy(1, 3), 1, "dexscreener", "AI6", NOW, { entryContext: ctx(72, 194_213, 41_038) });
    expect(b.opened).not.toBeNull();
  });

  it("shadow dedupes by mint and caps concurrent open shadows", () => {
    let book = createEmptyBook(NOW);
    book = openPaperCopy(book, buy(1, 9), 1, "dexscreener", "A", NOW, { entryContext: ctx(5, 50_000, 20_000) }).book;
    book = openPaperCopy(book, buy(2, 9), 1, "dexscreener", "A", NOW, { entryContext: ctx(5, 50_000, 20_000) }).book;
    expect(book.shadowPositions).toHaveLength(1);
    for (let i = 0; i < MAX_OPEN_SHADOW_POSITIONS + 5; i++) {
      book = openPaperCopy(book, buy(3, 100 + i), 1, "dexscreener", "B", NOW, { entryContext: ctx(5, 50_000, 20_000) }).book;
    }
    expect(book.shadowPositions!.filter((p) => p.status === "open")).toHaveLength(MAX_OPEN_SHADOW_POSITIONS);
  });

  it("markShadowBook marks shadows like real bags (rug exit) without touching cash", async () => {
    let book = createEmptyBook(NOW);
    book = openPaperCopy(book, buy(1, 1), 1, "dexscreener", "R", NOW, { entryContext: ctx(5, 100_000, 25_000) }).book;
    book = openPaperCopy(book, buy(1, 2), 1, "dexscreener", "S", NOW, { entryContext: ctx(5, 100_000, 25_000) }).book;
    quotes.set(m(1), 0.03); // −97% rug
    quotes.set(m(2), 1.05);
    const cash = book.cashUsd;
    const later = new Date(NOW.getTime() + 15 * 60_000);
    const r = await markShadowBook({ ...book, winPct: WIN_PCT, lossPct: LOSS_PCT }, later, LEARNING_POLICY);
    expect(r.book.cashUsd).toBe(cash);
    expect(r.book.positions).toEqual(book.positions);
    const [a, b] = r.book.shadowPositions!;
    expect(a!.status).toBe("closed_loss");
    expect(a!.closeReason).toMatch(/rug_gap/);
    expect(a!.realizedPnlUsd).toBeCloseTo(-9.7, 6);
    expect(b!.status).toBe("open");
    expect(b!.unrealizedPnlPct).toBeCloseTo(0.05, 6);
    expect(equityOf(r.book).equityUsd).toBeCloseTo(equityOf(book).equityUsd, 9);
    const rep = shadowReport(r.book).find((g) => g.reason === "rug_filter")!;
    expect(rep).toMatchObject({ open: 1, closed: 1, rugs: 1, wins: 0 });
    expect(formatReport(analyzeBook(r.book))).toContain("Shadow trades");
  });

  it("holder stats: top-10 % pure calc; fetch is opt-in (null without COPYTRADE_HOLDER_STATS_RPC)", async () => {
    expect(top10PctFrom([500, 100, null, 50, ...Array(20).fill(1)], 1000)).toBeCloseTo((500 + 100 + 50 + 7) / 1000, 9);
    expect(top10PctFrom([10], 0)).toBeNull();
    expect(await getTop10HolderPct(m(1), undefined)).toBeNull();
    const r = openPaperCopy(createEmptyBook(NOW), buy(1, 4), 1, "dexscreener", "H", NOW, {
      entryContext: { ...ctx(60, 5_000, 5_000), top10HolderPct: 0.42, holderCount: null },
    });
    expect(r.opened!.learning!.top10HolderPct).toBe(0.42);
    expect(r.opened!.learning!.holderCount).toBeNull();
  });
});

describe("2. TP/SL reset, fixed rug label, replay v2", () => {
  it("base TP/SL is +12% / −15% with 50% partial + 10% trail kept", () => {
    expect(WIN_PCT).toBe(0.12);
    expect(LOSS_PCT).toBe(0.15);
    expect(LEARNING_POLICY.partialTpFraction).toBe(0.5);
    expect(LEARNING_POLICY.trailPct).toBe(0.1);
  });

  it("rug label is a fixed −30%, not 2× SL", () => {
    expect(RUG_GAP_PCT).toBe(0.3);
    const pos = openPaperCopy(createEmptyBook(NOW), buy(1, 1), 1, "dexscreener", "A", NOW).opened!;
    const later = new Date(NOW.getTime() + 20 * 60_000);
    const opts10 = { ...markOpts(createEmptyBook(NOW)), lossPct: 0.1 };
    const a = applyMark(pos, 0.79, "dexscreener", later, opts10); // −21% at SL 10 (MEOW-class)
    expect(a.closeReason).toBe("SL -10%");
    expect(a.learning!.exitBucket).toBe("sl");
    const b = applyMark(pos, 0.69, "dexscreener", later, opts10);
    expect(b.closeReason).toMatch(/^rug_gap/);
    // Inside open-grace: −25% at SL 15 stays open (soft), −31% exits as rug.
    const soon = new Date(NOW.getTime() + 60_000);
    const opts15 = markOpts({ ...createEmptyBook(NOW), winPct: 0.12, lossPct: 0.15 });
    expect(applyMark(pos, 0.75, "dexscreener", soon, opts15).status).toBe("open");
    expect(applyMark(pos, 0.69, "dexscreener", soon, opts15).closeReason).toMatch(/^rug_gap/);
  });

  it("replay v2 credits exits above TP at actual value, not the TP (HOOKED case)", () => {
    const hooked = closed(w(1), 5.06, { reason: "source_sell_follow cap", peak: 0.17, trough: 0 });
    expect(replayTradePct(hooked, 0.3, 0.1)).toBeCloseTo(0.506, 6); // marks never touched +30%
    // TP 12 touched at a mark: 50% at +12%, remainder at actual clamped to peak (17%).
    expect(replayTradePct(hooked, 0.12, 0.15)).toBeCloseTo(0.06 + 0.5 * 0.17, 6);
    const sl = closed(w(1), -1.35, { trough: -0.135 });
    expect(replayTradePct(sl, 0.12, 0.1)).toBeCloseTo(-0.15, 6); // −10% stop → −15% fill
    expect(replayTradePct(sl, 0.12, 0.15)).toBeCloseTo(-0.135, 6); // not breached → actual
    const worse = closed(w(1), -2.43, { trough: -0.243 });
    expect(replayTradePct(worse, 0.12, 0.15)).toBeCloseTo(-0.243, 6); // actual worse than model
  });

  it("stale persisted 30/10 tuning is replaced by pinned 12/15 below 50 non-rug closes", () => {
    const ps = Array.from({ length: 30 }, (_, i) => closed(w(i % 6), i % 3 ? -1.5 : 1.2));
    const stale = bookWith(ps, {
      winPct: 0.3,
      lossPct: 0.1,
      learningTuning: { computedAt: "x", learningClosed: 21, winPct: 0.3, lossPct: 0.1, promoted: [], demoted: [], notes: [] },
    });
    const t = computeLearningTuning(stale, NOW)!;
    expect(t.winPct).toBe(0.12);
    expect(t.lossPct).toBe(0.15);
    expect(t.tpSlFrozen).toBe(true);
    expect(t.nonRugQualifyingCloses).toBe(30);
  });

  it("needs ≥50 non-rug qualifying closes (rugs / outage-held / scrubs don't count) before retuning", () => {
    const base: PaperCopyPosition[] = [];
    for (let i = 0; i < 49; i++) base.push(closed(w(i % 5), 2.4, { peak: 0.35, trough: -0.02 }));
    for (let i = 0; i < 10; i++) base.push(closed(w(9), -9.8, { reason: "rug_gap past SL -15%" }));
    for (let i = 0; i < 5; i++) base.push(closed(w(9), -1, { hold: 5689 }));
    for (let i = 0; i < 5; i++) base.push(closed(w(9), -0.2, { reason: "scrub_inactive_source_wallet" }));
    const t49 = computeLearningTuning(bookWith(base), NOW)!;
    expect(t49.nonRugQualifyingCloses).toBe(49);
    expect(t49.tpSlFrozen).toBe(true);
    const t50 = computeLearningTuning(bookWith([...base, closed(w(1), 2.4, { peak: 0.35, trough: -0.02 })]), NOW)!;
    expect(t50.tpSlFrozen).toBe(false);
    expect(t50.winPct).toBe(0.3); // runners peaking +35% favour the wider TP under v2
  });

  it("outage-held = hold > MAX_HOLD + 1h", () => {
    expect(isOutageHeld(closed(w(1), -1, { hold: 5689 }))).toBe(true);
    expect(isOutageHeld(closed(w(1), -1, { hold: 365 }))).toBe(false);
    expect(isRugClose(closed(w(1), -2.04))).toBe(false); // −20.4% MEOW: not a rug any more
    expect(isRugClose(closed(w(1), -9.4))).toBe(true);
  });
});

describe("3. wallet suspension (replaces archive)", () => {
  const eightLosers = (wallet: string, wins = 1) =>
    Array.from({ length: 12 }, (_, i) => closed(wallet, i < wins ? 1 : -1.5));

  it("suspends at ≥12 qualifying closes with net<0 and WR<25%; 11 is not enough", () => {
    const active = [w(1), w(2), w(3), w(4), w(5)];
    const t8 = computeLearningTuning(bookWith([...eightLosers(w(1)), ...Array.from({ length: 12 }, () => closed(w(2), 1))]), NOW, { activeWallets: active })!;
    expect(t8.suspended).toEqual([w(1)]);
    expect(t8.demoted).toEqual([w(1)]);
    const seven = eightLosers(w(1)).slice(1); // 11 closes
    const t7 = computeLearningTuning(bookWith([...seven, ...Array.from({ length: 13 }, () => closed(w(2), 1))]), NOW, { activeWallets: active })!;
    expect(t7.suspended).toEqual([]);
    // 3/12 = 25% is not < 25%
    const t25 = computeLearningTuning(bookWith([...eightLosers(w(1), 3), ...Array.from({ length: 12 }, () => closed(w(2), 1))]), NOW, { activeWallets: active })!;
    expect(t25.suspended).toEqual([]);
  });

  it("excludes mark_unavailable, scrubs, outage-held, and filter-profile rugs; other rugs count", () => {
    const x = w(7);
    const ps = [
      ...Array.from({ length: 4 }, () => closed(x, -1.5)),
      closed(x, 0, { reason: "mark_unavailable 2h" }),
      closed(x, -0.5, { reason: "scrub_inactive_source_wallet" }),
      closed(x, -1.1, { hold: 5675, reason: "time-stop 6h" }),
      closed(x, -9.8, { reason: "rug_gap past SL -15%", age: 5, mcap: 122_000, liq: 30_000 }), // filter profile
      closed(x, -9.9, { reason: "rug_gap past SL -15%", age: 3222, mcap: 1_500_000, liq: 160_000 }), // not profile
    ];
    const s = walletSuspensionStats(bookWith(ps)).get(x)!;
    expect(s.n).toBe(5);
    expect(s.pnlUsd).toBeCloseTo(-15.9, 6);
    expect(isQualifyingLearningClose(ps[4]!)).toBe(false);
    expect(meetsSuspensionCriteria(s)).toBe(false);
  });

  it(`keeps a floor of ${MIN_ACTIVE_WALLETS} active wallets (least-bad stay active)`, () => {
    const active = [w(1), w(2), w(3), w(4), w(5), w(6), w(7)];
    const ps = active.flatMap((a, i) => Array.from({ length: 12 }, () => closed(a, -1 - i)));
    const t = computeLearningTuning(bookWith(ps), NOW, { activeWallets: active })!;
    expect(t.suspended).toEqual([w(7)]); // worst only; 6 stay active
    expect(t.notes.filter((n) => n.startsWith("floor keeps"))).toHaveLength(6);
  });

  it("suspended-wallet shadow closes count, so a recovering wallet is reinstated", () => {
    const x = w(1);
    const active = [x, w(2), w(3), w(4), w(5)];
    const filler = Array.from({ length: 12 }, () => closed(w(2), 1));
    const base = bookWith([...eightLosers(x), ...filler]);
    expect(computeLearningTuning(base, NOW, { activeWallets: active })!.suspended).toEqual([x]);
    const shadowWins = Array.from({ length: 6 }, () =>
      closed(x, 2.5, { shadow: { reason: "suspended_wallet", skipReason: "learning_suspended_wallet" } }),
    );
    const recovered = { ...base, shadowPositions: shadowWins };
    const s = walletSuspensionStats(recovered).get(x)!;
    expect(s.shadowN).toBe(6);
    expect(computeLearningTuning(recovered, NOW, { activeWallets: active })!.suspended).toEqual([]);
    // Rug-filter shadows never count toward wallet stats.
    const rugShadows = { ...base, shadowPositions: shadowWins.map((p) => ({ ...p, shadow: { reason: "rug_filter" as const, skipReason: "rug_filter_fresh_thin_pool" } })) };
    expect(walletSuspensionStats(rugShadows).get(x)!.shadowN).toBe(0);
  });

  it("re-evaluates tonight's 8 archived wallets on the 21:00 MDT book snapshot: none meets suspension", () => {
    const book = JSON.parse(readFileSync("fixtures/copytrade-book-20260928-2100.json", "utf8")) as CopyBookState;
    const labels = ["Cooker", "passthedutcher", "onlyljc", "Hash", "cap", "Rilsio", "LUKEY", "zeropnl"];
    const addr = new Map(TRACKED_WALLETS.map((t) => [t.label, t.address]));
    const stats = walletSuspensionStats(book);
    for (const l of labels) {
      const a = addr.get(l)!;
      expect(a, l).toBeDefined();
      expect(meetsSuspensionCriteria(stats.get(a)), l).toBe(false);
    }
    expect(stats.get(addr.get("Hash")!)!).toMatchObject({ n: 4, wins: 1 });
    expect(stats.get(addr.get("cap")!)!.pnlUsd).toBeCloseTo(2.92, 2);
    expect(stats.get(addr.get("onlyljc")!)).toBeUndefined(); // only close was a filter-profile rug
    const t = computeLearningTuning(book, NOW)!;
    expect(t.suspended).toEqual([]);
    expect(t.winPct).toBe(0.12);
    expect(t.lossPct).toBe(0.15);
  });
});

describe("2026-09-29 rug filter 60m + young/thin size cap", () => {
  const PW = w(77);
  const provenBook = (): CopyBookState =>
    bookWith([closed(PW, 5), closed(PW, 3)]);

  it("p/acc profile (33.3m, $150.7k mcap, $36.5k liq) is now skipped as a shadow trade", () => {
    const r = openPaperCopy(provenBook(), buy(77, 501), 1, "dexscreener", "p/acc", NOW, {
      entryContext: ctx(33.3, 150_709, 36_481),
    });
    expect(r.skipReason).toBe("rug_filter_fresh_thin_pool");
    expect(r.opened).toBeNull();
    expect(r.book.shadowPositions).toHaveLength(1);
  });

  it("matchesYoungThinPool: age<60m AND liq<$100k, both recorded, no mcap requirement", () => {
    const f = (a: number | null, l: number | null) =>
      matchesYoungThinPool({ tokenAgeMinutes: a, entryLiquidityUsd: l });
    expect(f(59, 99_999)).toBe(true);
    expect(f(60, 10_000)).toBe(false);
    expect(f(10, 100_000)).toBe(false);
    expect(f(null, 10_000)).toBe(false);
    expect(f(10, null)).toBe(false);
  });

  it("proven wallet is capped at $10 (tagged) in a young thin token the rug filter does not catch (mcap < $15k)", () => {
    const r = openPaperCopy(provenBook(), buy(77, 502), 1, "dexscreener", "MICRO", NOW, {
      entryContext: ctx(45, 8_000, 20_000),
    });
    expect(r.opened).not.toBeNull();
    expect(r.opened!.learning!.walletTier).toBe("proven");
    expect(r.opened!.sizeUsd).toBe(10);
    expect(r.opened!.sizeCapTag).toContain(SIZE_CAP_YOUNG_THIN_TAG);
    expect(r.opened!.sizeCapTag).toContain("$60→$10");
  });

  it("proven wallet keeps full size when the token is old or deep, and no tag is set", () => {
    const old = openPaperCopy(provenBook(), buy(77, 503), 1, "dexscreener", "OLD", NOW, {
      entryContext: ctx(75, 8_000, 60_000),
    });
    expect(old.opened!.sizeUsd).toBe(60);
    expect(old.opened!.sizeCapTag).toBeUndefined();
    const deep = openPaperCopy(provenBook(), buy(77, 504), 1, "dexscreener", "DEEP", NOW, {
      entryContext: ctx(45, 8_000, 250_000),
    });
    expect(deep.opened!.sizeUsd).toBe(60);
    expect(deep.opened!.sizeCapTag).toBeUndefined();
  });

  it("explorer $25 is also capped to $10 (tagged) in young thin tokens; old tokens keep $25", () => {
    const r = openPaperCopy(createEmptyBook(NOW), buy(78, 505), 1, "dexscreener", "EXP", NOW, {
      entryContext: ctx(45, 8_000, 20_000),
    });
    expect(r.opened!.sizeUsd).toBe(10);
    expect(r.opened!.sizeCapTag).toContain("$25→$10");
    const old = openPaperCopy(createEmptyBook(NOW), buy(78, 506), 1, "dexscreener", "EXPOLD", NOW, {
      entryContext: ctx(90, 8_000, 40_000),
    });
    expect(old.opened!.sizeUsd).toBe(25);
    expect(old.opened!.sizeCapTag).toBeUndefined();
  });
});
