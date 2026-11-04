import { beforeEach, describe, expect, it } from "vitest";
import {
  alreadyCopied,
  applyMark,
  closeOnSourceSells,
  canDisplaceExplorer,
  compareExplorerScore,
  createEmptyBook,
  hasAnyProvenPrinter,
  openPaperCopy,
  scrubCooldownViolatingOpens,
  scrubExcessPerWalletOpens,
  scrubExcessUnprovenOpens,
  scrubInactiveSourceOpens,
  shouldUseProvenSize,
  sizeForCopy,
  unprovenExplorerScore,
} from "../src/copytrade/paperBook.js";
import {
  COPY_SIZE_PROVEN_USD,
  COPY_SIZE_USD,
  isAcceptableLiveMarkRatio,
  liveDisagreesWithTxEntry,
  preferLiveOverTxEntry,
  shouldRefuseUnderwaterTxEntry,
  PROVEN_SIZE_COOLDOWN_MS,
  LOSS_PCT,
  WIN_PCT,
  LEGACY_POLICY,
  setActivePolicy,
} from "../src/copytrade/config.js";
import { extractBuysFromTx, extractSellsFromTx } from "../src/copytrade/walletActivity.js";
import type { ParsedTx } from "../src/copytrade/rpc.js";
import type { TrackedWallet, WalletBuyEvent, WalletSellEvent } from "../src/copytrade/types.js";

// Pre-learning-mode tests pin the LEGACY gate stack explicitly; learning-mode
// behaviour is covered in tests/copytrade.learning.test.ts.
beforeEach(() => setActivePolicy(LEGACY_POLICY));

const wallet: TrackedWallet = {
  address: "Wallet1111111111111111111111111111111111111",
  label: "Test",
  justification: "unit",
  source: "manual",
  provisional: true,
};

function buy(over: Partial<WalletBuyEvent> = {}): WalletBuyEvent {
  return {
    walletAddress: wallet.address,
    walletLabel: wallet.label,
    signature: "sig-abc-111",
    blockTime: 1_700_000_000,
    mint: "Mint111111111111111111111111111111111111111",
    tokenAmount: 1_000,
    solSpent: 0.1,
    entryPriceUsd: 0.01,
    observedAt: new Date().toISOString(),
    ...over,
  };
}

/** Seed a tiny closed win so the default test wallet is "proven" under proven-only mode. */
function bookWithProvenSeed(): ReturnType<typeof createEmptyBook> {
  const book = createEmptyBook();
  return {
    ...book,
    positions: [
      {
        id: "seed-proven-win",
        openedAt: "2026-09-01T00:00:00.000Z",
        closedAt: "2026-09-01T01:00:00.000Z",
        sourceWallet: wallet.address,
        sourceWalletLabel: wallet.label,
        sourceSignature: "sig-seed-proven",
        mint: "SeedMint111111111111111111111111111111111",
        symbol: "SEED",
        sizeUsd: 25,
        entryPriceUsd: 1,
        entryPriceSource: "dexscreener",
        quantity: 25,
        markPriceUsd: 1.2,
        markSource: "dexscreener",
        markAt: "2026-09-01T01:00:00.000Z",
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        status: "closed_win",
        closeReason: "TP +12%",
        realizedPnlUsd: 5,
      },
    ],
  };
}


describe("sizeForCopy", () => {
  it("caps at configured size and available cash", () => {
    expect(sizeForCopy(1000, 50)).toBe(50);
    expect(sizeForCopy(30, 50)).toBe(30);
    expect(sizeForCopy(0.5, 50)).toBeNull();
  });
});

describe("dedupe already-copied txs", () => {
  it("detects seen signatures", () => {
    expect(alreadyCopied(["a", "b"], "b")).toBe(true);
    expect(alreadyCopied(["a"], "z")).toBe(false);
  });

  it("refuses to open a second copy for the same signature", () => {
    let book = bookWithProvenSeed();
    const first = openPaperCopy(book, buy(), 0.01, "tx_sol_delta", "TEST");
    expect(first.opened).not.toBeNull();
    book = first.book;
    const second = openPaperCopy(book, buy(), 0.01, "tx_sol_delta", "TEST");
    expect(second.opened).toBeNull();
    expect(second.skipReason).toBe("already_copied_tx");
  });

  it("skips already-open same mint globally (any wallet)", () => {
    let book = bookWithProvenSeed();
    const first = openPaperCopy(book, buy({ signature: "sig-1" }), 0.01, "dexscreener", "TEST");
    book = first.book!;
    const second = openPaperCopy(
      book,
      buy({ signature: "sig-2" }),
      0.01,
      "dexscreener",
      "TEST",
    );
    expect(second.opened).toBeNull();
    expect(second.skipReason).toBe("already_open_same_mint");
  });

  it("skips already-open same mint from a different wallet", () => {
    let book = bookWithProvenSeed();
    const first = openPaperCopy(book, buy({ signature: "sig-1" }), 0.01, "dexscreener", "TEST");
    book = first.book!;
    const second = openPaperCopy(
      book,
      buy({
        signature: "sig-2",
        walletAddress: "OtherWallet111111111111111111111111111111",
        walletLabel: "Other",
      }),
      0.01,
      "dexscreener",
      "TEST",
    );
    expect(second.opened).toBeNull();
    expect(second.skipReason).toBe("already_open_same_mint");
  });

  it("skips re-entry of a mint stop-lossed within cool-down", () => {
    let book = bookWithProvenSeed();
    const first = openPaperCopy(book, buy({ signature: "sig-sl-1" }), 1, "dexscreener", "DUEL");
    expect(first.opened).not.toBeNull();
    book = first.book!;
    const openedAt = new Date("2026-09-23T14:00:00.000Z");
    book = {
      ...book,
      positions: book.positions.map((p) =>
        p.id === first.opened!.id
          ? {
              ...p,
              openedAt: openedAt.toISOString(),
              status: "closed_loss" as const,
              closedAt: "2026-09-23T14:30:00.000Z",
              closeReason: "SL -15%",
              realizedPnlUsd: -7.5,
              unrealizedPnlUsd: 0,
            }
          : p,
      ),
      cashUsd: book.cashUsd + 42.5,
    };
    const retry = openPaperCopy(
      book,
      buy({ signature: "sig-sl-2" }),
      1,
      "dexscreener",
      "DUEL",
      new Date("2026-09-23T15:00:00.000Z"),
    );
    expect(retry.opened).toBeNull();
    expect(retry.skipReason).toBe("recent_sl_mint_cooldown");
  });

  it("skips re-entry of a mint time-stopped within cool-down", () => {
    let book = bookWithProvenSeed();
    const first = openPaperCopy(book, buy({ signature: "sig-ts-1" }), 1, "dexscreener", "TROLL");
    expect(first.opened).not.toBeNull();
    book = first.book!;
    book = {
      ...book,
      positions: book.positions.map((p) =>
        p.id === first.opened!.id
          ? {
              ...p,
              openedAt: "2026-09-23T09:00:00.000Z",
              status: "closed_time" as const,
              closedAt: "2026-09-23T15:00:00.000Z",
              closeReason: "time-stop 6h",
              realizedPnlUsd: -4.8,
              unrealizedPnlUsd: 0,
            }
          : p,
      ),
      cashUsd: book.cashUsd + 45.2,
    };
    const retry = openPaperCopy(
      book,
      buy({ signature: "sig-ts-2" }),
      1,
      "dexscreener",
      "TROLL",
      new Date("2026-09-23T16:00:00.000Z"),
    );
    expect(retry.opened).toBeNull();
    expect(retry.skipReason).toBe("recent_sl_mint_cooldown");
  });

  it("skips re-entry of a mint prefer-scrubbed within cool-down", () => {
    let book = bookWithProvenSeed();
    const first = openPaperCopy(book, buy({ signature: "sig-pref-1" }), 1, "dexscreener", "GP");
    expect(first.opened).not.toBeNull();
    book = first.book!;
    book = {
      ...book,
      positions: book.positions.map((p) =>
        p.id === first.opened!.id
          ? {
              ...p,
              openedAt: "2026-09-24T10:53:00.000Z",
              status: "closed_time" as const,
              closedAt: "2026-09-24T14:06:00.000Z",
              closeReason: "scrub_prefer_better_unproven",
              realizedPnlUsd: -1.77,
              unrealizedPnlUsd: 0,
            }
          : p,
      ),
      cashUsd: book.cashUsd + 23.23,
    };
    const retry = openPaperCopy(
      book,
      buy({ signature: "sig-pref-2" }),
      1,
      "dexscreener",
      "GP",
      new Date("2026-09-24T15:02:00.000Z"),
    );
    expect(retry.opened).toBeNull();
    expect(retry.skipReason).toBe("recent_sl_mint_cooldown");
  });


  it("scrubs opens that re-entered a mint inside cool-down", () => {
    let book = bookWithProvenSeed();
    const first = openPaperCopy(book, buy({ signature: "sig-cd-1" }), 1, "dexscreener", "TROLL");
    expect(first.opened).not.toBeNull();
    book = first.book!;
    book = {
      ...book,
      positions: book.positions.map((p) =>
        p.id === first.opened!.id
          ? {
              ...p,
              openedAt: "2026-09-23T09:00:00.000Z",
              status: "closed_time" as const,
              closedAt: "2026-09-23T15:00:00.000Z",
              closeReason: "time-stop 6h",
              realizedPnlUsd: -4.8,
              unrealizedPnlUsd: 0,
            }
          : p,
      ),
      cashUsd: book.cashUsd + 45.2,
    };
    const reinjected = {
      ...first.opened!,
      id: "troll-reentry",
      openedAt: "2026-09-23T15:00:00.000Z",
      status: "open" as const,
      sourceSignature: "sig-cd-2",
      unrealizedPnlUsd: -0.8,
      unrealizedPnlPct: -0.016,
    };
    book = {
      ...book,
      cashUsd: book.cashUsd - 50,
      positions: [...book.positions, reinjected],
    };
    const scrubbed = scrubCooldownViolatingOpens(book, new Date("2026-09-23T16:00:00.000Z"));
    expect(scrubbed.closed.length).toBe(1);
    expect(scrubbed.closed[0].id).toBe("troll-reentry");
    expect(scrubbed.closed[0].closeReason).toBe("scrub_cooldown_reentry");
    expect(scrubbed.book.positions.filter((p) => p.status === "open").length).toBe(0);
  });

  it("overweights proven net-positive source wallets", () => {
    let book = bookWithProvenSeed();
    const first = openPaperCopy(book, buy({ signature: "sig-p1", mint: "MintWin111111111111111111111111111111111111" }), 1, "dexscreener", "WIN");
    expect(first.opened).not.toBeNull();
    book = first.book!;
    book = {
      ...book,
      positions: book.positions.map((p) =>
        p.id === first.opened!.id
          ? {
              ...p,
              status: "closed_win" as const,
              closedAt: "2026-09-23T12:00:00.000Z",
              closeReason: "TP +12%",
              realizedPnlUsd: 55,
              unrealizedPnlUsd: 0,
            }
          : p,
      ),
      cashUsd: book.cashUsd + 105,
    };
    // Open well after PROVEN_SIZE_COOLDOWN_MS from the TP close.
    const next = openPaperCopy(
      book,
      buy({ signature: "sig-p2", mint: "MintNext11111111111111111111111111111111111" }),
      0.01,
      "dexscreener",
      "NEXT",
      new Date("2026-09-24T12:00:00.000Z"),
    );
    expect(next.opened).not.toBeNull();
    expect(next.opened!.sizeUsd).toBe(COPY_SIZE_PROVEN_USD);
  });

  it("scrubs excess opens beyond per-wallet cap", () => {
    let book = bookWithProvenSeed();
    // Force 3 opens by temporarily bypassing cap via direct book mutation after 2 opens.
    const a = openPaperCopy(book, buy({ signature: "sig-e1", mint: "MintE1111111111111111111111111111111111111" }), 0.01, "dexscreener", "E1");
    book = a.book!;
    const b = openPaperCopy(book, buy({ signature: "sig-e2", mint: "MintE2111111111111111111111111111111111111" }), 0.01, "dexscreener", "E2");
    book = b.book!;
    // Inject a third open as if opened before the cap existed.
    const injected = {
      ...b.opened!,
      id: "injected-excess",
      mint: "MintE3111111111111111111111111111111111111",
      symbol: "E3",
      sourceSignature: "sig-e3",
      openedAt: "2026-09-23T12:00:00.000Z",
      unrealizedPnlUsd: -3,
    };
    book = {
      ...book,
      cashUsd: book.cashUsd - 50,
      positions: [...book.positions, injected],
    };
    expect(book.positions.filter((p) => p.status === "open").length).toBe(3);
    const scrubbed = scrubExcessPerWalletOpens(book, new Date("2026-09-23T16:00:00.000Z"));
    expect(scrubbed.closed.length).toBe(1);
    expect(scrubbed.closed[0].closeReason).toBe("scrub_excess_per_wallet");
    expect(scrubbed.book.positions.filter((p) => p.status === "open").length).toBe(2);
  });

  it("scrubs excess unproven opens beyond cap (proven-only when 0)", () => {
    // Pure inject: default wallet has no closed history → unproven. Avoid openPaperCopy
    // because MAX_OPEN_UNPROVEN_TOTAL=0 blocks first unproven open.
    const template = {
      id: "u1",
      openedAt: "2026-09-23T12:00:00.000Z",
      sourceWallet: wallet.address,
      sourceWalletLabel: wallet.label,
      sourceSignature: "sig-u1",
      mint: "MintU1111111111111111111111111111111111111",
      symbol: "U1",
      sizeUsd: 25,
      entryPriceUsd: 0.01,
      entryPriceSource: "dexscreener" as const,
      quantity: 2500,
      markPriceUsd: 0.01,
      markSource: "dexscreener" as const,
      markAt: "2026-09-23T12:00:00.000Z",
      unrealizedPnlUsd: -0.5,
      unrealizedPnlPct: -0.02,
      status: "open" as const,
    };
    const book = {
      ...createEmptyBook(),
      cashUsd: 950,
      positions: [
        template,
        {
          ...template,
          id: "u2",
          mint: "MintU2111111111111111111111111111111111111",
          symbol: "U2",
          sourceSignature: "sig-u2",
          unrealizedPnlUsd: -1,
        },
      ],
    };
    expect(book.positions.filter((p) => p.status === "open").length).toBe(2);
    const scrubbed = scrubExcessUnprovenOpens(
      book,
      new Date("2026-09-23T17:00:00.000Z"),
      0,
    );
    expect(scrubbed.closed.length).toBe(2);
    expect(
      scrubbed.closed.every((c) => c.closeReason === "scrub_excess_unproven"),
    ).toBe(true);
    expect(scrubbed.book.positions.filter((p) => p.status === "open").length).toBe(0);
  });

  it("caps open copies per source wallet", () => {
    let book = bookWithProvenSeed();
    const a = openPaperCopy(
      book,
      buy({ signature: "sig-w1", mint: "MintA11111111111111111111111111111111111111" }),
      0.01,
      "dexscreener",
      "A",
    );
    expect(a.opened).not.toBeNull();
    book = a.book!;
    const b = openPaperCopy(
      book,
      buy({ signature: "sig-w2", mint: "MintB11111111111111111111111111111111111111" }),
      0.01,
      "dexscreener",
      "B",
    );
    expect(b.opened).not.toBeNull();
    book = b.book!;
    const c = openPaperCopy(
      book,
      buy({ signature: "sig-w3", mint: "MintC11111111111111111111111111111111111111" }),
      0.01,
      "dexscreener",
      "C",
    );
    expect(c.opened).toBeNull();
    expect(c.skipReason).toBe("max_open_per_wallet");
    // Different wallet can still open while first is capped (must be proven under proven-only).
    book = {
      ...book,
      positions: [
        ...book.positions,
        {
          id: "seed-other-win",
          openedAt: "2026-09-01T00:00:00.000Z",
          closedAt: "2026-09-01T01:00:00.000Z",
          sourceWallet: "OtherWallet111111111111111111111111111111",
          sourceWalletLabel: "Other",
          sourceSignature: "sig-seed-other",
          mint: "SeedOtherMint11111111111111111111111111111",
          symbol: "SEEDO",
          sizeUsd: 25,
          entryPriceUsd: 1,
          entryPriceSource: "dexscreener",
          quantity: 25,
          markPriceUsd: 1.2,
          markSource: "dexscreener",
          markAt: "2026-09-01T01:00:00.000Z",
          unrealizedPnlUsd: 0,
          unrealizedPnlPct: 0,
          status: "closed_win",
          closeReason: "TP +12%",
          realizedPnlUsd: 5,
        },
      ],
    };
    const other = openPaperCopy(
      book,
      buy({
        signature: "sig-other",
        mint: "MintD11111111111111111111111111111111111111",
        walletAddress: "OtherWallet111111111111111111111111111111",
        walletLabel: "Other",
      }),
      0.01,
      "dexscreener",
      "D",
    );
    expect(other.opened).not.toBeNull();
  });

  it("skips stables and major non-meme mints", () => {
    const book = bookWithProvenSeed();
    const usdc = openPaperCopy(
      book,
      buy({
        signature: "sig-usdc",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }),
      1,
      "dexscreener",
      "USDC",
    );
    expect(usdc.opened).toBeNull();
    expect(usdc.skipReason).toBe("skip_non_meme");
  });
});

describe("applyMark win/loss/time", () => {
  it("closes win at +25%", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "tx_sol_delta", "T").opened!;
    const marked = applyMark(opened, 1.25, "test", new Date(), {
      winPct: 0.25,
      lossPct: 0.25,
      maxHoldHours: 6,
    });
    expect(marked.status).toBe("closed_win");
    expect(marked.realizedPnlUsd).toBeCloseTo(18.75, 5); // proven $75 size → 75 qty at $1
  });

  it("closes loss at -25% after open-grace", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "tx_sol_delta", "T").opened!;
    const later = new Date(new Date(opened.openedAt).getTime() + 6 * 60_000);
    const marked = applyMark(opened, 0.75, "test", later, {
      winPct: 0.25,
      lossPct: 0.25,
      maxHoldHours: 6,
    });
    expect(marked.status).toBe("closed_loss");
  });

  it("time-stops after max hold hours", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "tx_sol_delta", "T").opened!;
    const later = new Date(Date.now() + 7 * 3_600_000);
    const marked = applyMark(opened, 1.05, "test", later, {
      winPct: 0.25,
      lossPct: 0.25,
      maxHoldHours: 6,
    });
    expect(marked.status).toBe("closed_time");
  });

  it("stays open inside bands", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "tx_sol_delta", "T").opened!;
    const marked = applyMark(opened, 1.1, "test", new Date(), {
      winPct: 0.25,
      lossPct: 0.25,
      maxHoldHours: 6,
    });
    expect(marked.status).toBe("open");
    expect(marked.unrealizedPnlPct).toBeCloseTo(0.1, 5);
  });
});

describe("config exit bands", () => {
  it("defaults book to tightened TP/SL", () => {
    const book = bookWithProvenSeed();
    expect(book.winPct).toBe(WIN_PCT);
    expect(book.lossPct).toBe(LOSS_PCT);
    expect(WIN_PCT).toBe(0.12);
    expect(LOSS_PCT).toBe(0.15);
  });
});

describe("scrubInactiveSourceOpens", () => {
  it("closes opens whose source wallet is not active", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "tx_sol_delta", "T").opened!;
    const withOpen = {
      ...book,
      positions: [opened],
      cashUsd: book.cashUsd - opened.sizeUsd,
    };
    const { book: next, closed } = scrubInactiveSourceOpens(
      withOpen,
      ["SomeOtherActiveWallet111111111111111111111"],
    );
    expect(closed).toHaveLength(1);
    expect(next.positions[0].status).toBe("closed_time");
    expect(next.positions[0].closeReason).toBe("scrub_inactive_source_wallet");
    expect(next.cashUsd).toBeCloseTo(1000, 5); // size returned (flat mark)
  });

  it("keeps opens from active wallets", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "tx_sol_delta", "T").opened!;
    const withOpen = {
      ...book,
      positions: [opened],
      cashUsd: book.cashUsd - opened.sizeUsd,
    };
    const { book: next, closed } = scrubInactiveSourceOpens(withOpen, [
      wallet.address,
    ]);
    expect(closed).toHaveLength(0);
    expect(next.positions[0].status).toBe("open");
  });
});

describe("extractBuysFromTx", () => {
  it("detects token buy when balance rises and SOL falls", () => {
    const mint = "TokenMint11111111111111111111111111111111111";
    const tx: ParsedTx = {
      blockTime: 1_700_000_100,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [2e9],
        postBalances: [1.5e9],
        preTokenBalances: [
          {
            mint,
            owner: wallet.address,
            uiTokenAmount: { uiAmount: 0, decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            mint,
            owner: wallet.address,
            uiTokenAmount: { uiAmount: 1000, decimals: 6 },
          },
        ],
      },
      transaction: {
        message: { accountKeys: [wallet.address] },
      },
    };
    const events = extractBuysFromTx(wallet, "sigXYZ", tx, 100);
    expect(events).toHaveLength(1);
    expect(events[0].tokenAmount).toBe(1000);
    expect(events[0].solSpent).toBeCloseTo(0.5, 6);
    expect(events[0].entryPriceUsd).toBeCloseTo(0.05, 6); // 0.5 SOL * $100 / 1000
  });
});

describe("closeOnSourceSells exit-follow", () => {
  it("closes open copy when source sells same mint", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "tx_sol_delta", "T").opened!;
    const withOpen = {
      ...book,
      positions: [opened],
      cashUsd: book.cashUsd - opened.sizeUsd,
    };
    const sell: WalletSellEvent = {
      walletAddress: wallet.address,
      walletLabel: wallet.label,
      signature: "sig-sell-1",
      blockTime: 1_700_000_200,
      mint: opened.mint,
      tokenAmount: 100,
      solReceived: 0.05,
      exitPriceUsd: 1.1,
      observedAt: new Date().toISOString(),
    };
    const { book: next, closed } = closeOnSourceSells(withOpen, [sell]);
    expect(closed).toHaveLength(1);
    expect(next.positions[0].status).toBe("closed_win");
    expect(next.positions[0].closeReason).toMatch(/source_sell_follow/);
    expect(next.cashUsd).toBeCloseTo(1000 + 7.5, 5); // +10% on proven $75
  });

  it("ignores sells for different mint or wallet", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "tx_sol_delta", "T").opened!;
    const withOpen = {
      ...book,
      positions: [opened],
      cashUsd: book.cashUsd - opened.sizeUsd,
    };
    const sell: WalletSellEvent = {
      walletAddress: wallet.address,
      walletLabel: wallet.label,
      signature: "sig-sell-2",
      blockTime: 1_700_000_200,
      mint: "OtherMint111111111111111111111111111111111",
      tokenAmount: 100,
      solReceived: 0.05,
      exitPriceUsd: 1.1,
      observedAt: new Date().toISOString(),
    };
    const { closed } = closeOnSourceSells(withOpen, [sell]);
    expect(closed).toHaveLength(0);
  });
});

describe("extractSellsFromTx", () => {
  it("detects token sell when balance falls and SOL rises", () => {
    const mint = "TokenMint11111111111111111111111111111111111";
    const tx: ParsedTx = {
      blockTime: 1_700_000_100,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1e9],
        postBalances: [1.4e9],
        preTokenBalances: [
          {
            mint,
            owner: wallet.address,
            uiTokenAmount: { uiAmount: 1000, decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            mint,
            owner: wallet.address,
            uiTokenAmount: { uiAmount: 0, decimals: 6 },
          },
        ],
      },
      transaction: {
        message: { accountKeys: [wallet.address] },
      },
    };
    const events = extractSellsFromTx(wallet, "sigSELL", tx, 100);
    expect(events).toHaveLength(1);
    expect(events[0].tokenAmount).toBe(1000);
    expect(events[0].solReceived).toBeCloseTo(0.4, 6);
    expect(events[0].exitPriceUsd).toBeCloseTo(0.04, 6);
  });
});

describe("open-grace SL protection", () => {
  it("soft SL inside grace keeps open with honest MTM (−20%)", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "pumpfun_mcap", "SOFT").opened!;
    const now = new Date(new Date(opened.openedAt).getTime() + 30_000); // 30s later
    const marked = applyMark(opened, 0.8, "pumpfun_mcap", now, {
      winPct: WIN_PCT,
      lossPct: LOSS_PCT,
      maxHoldHours: 6,
    });
    expect(marked.status).toBe("open");
    expect(marked.unrealizedPnlPct).toBeCloseTo(-0.2, 5);
  });

  it("rug_gap inside grace exits immediately (−80%, MOONIMALS-class)", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "pumpfun_mcap", "FAP").opened!;
    const now = new Date(new Date(opened.openedAt).getTime() + 30_000); // 30s later
    const marked = applyMark(opened, 0.2, "pumpfun_mcap", now, {
      winPct: WIN_PCT,
      lossPct: LOSS_PCT,
      maxHoldHours: 6,
    });
    expect(marked.status).toBe("closed_loss");
    expect(marked.closeReason).toMatch(/rug_gap past SL/);
    expect(marked.realizedPnlUsd!).toBeCloseTo(-0.8 * opened.sizeUsd, 5);
  });

  it("does SL after grace when mark stays below lossPct", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "pumpfun_mcap", "FAP").opened!;
    const now = new Date(new Date(opened.openedAt).getTime() + 6 * 60_000); // 6m
    const marked = applyMark(opened, 0.2, "pumpfun_mcap", now, {
      winPct: WIN_PCT,
      lossPct: LOSS_PCT,
      maxHoldHours: 6,
    });
    expect(marked.status).toBe("closed_loss");
    // −80% is past 2× the −15% band → rug_gap label (still matches /SL/)
    expect(marked.closeReason).toMatch(/rug_gap past SL/);
  });

  it("plain SL label when mark is just past the stop band", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 1, "dexscreener", "SOFT").opened!;
    const now = new Date(new Date(opened.openedAt).getTime() + 6 * 60_000);
    const marked = applyMark(opened, 0.84, "dexscreener", now, {
      winPct: WIN_PCT,
      lossPct: LOSS_PCT,
      maxHoldHours: 6,
    });
    expect(marked.status).toBe("closed_loss");
    expect(marked.closeReason).toBe("SL -15%");
  });
});

describe("asymmetric mark sanity", () => {
  it("accepts downside crash ratios (rugs must mark through)", () => {
    expect(isAcceptableLiveMarkRatio(0.01)).toBe(true);
    expect(isAcceptableLiveMarkRatio(0.2)).toBe(true);
    expect(isAcceptableLiveMarkRatio(1)).toBe(true);
    expect(isAcceptableLiveMarkRatio(3)).toBe(true);
  });

  it("rejects upside spikes above MARK_SANITY_MAX_RATIO", () => {
    expect(isAcceptableLiveMarkRatio(3.01)).toBe(false);
    expect(isAcceptableLiveMarkRatio(20)).toBe(false);
    expect(isAcceptableLiveMarkRatio(0)).toBe(false);
    expect(isAcceptableLiveMarkRatio(-1)).toBe(false);
  });

  it("entry resolve still treats either-way disagreement as prefer-live", () => {
    expect(liveDisagreesWithTxEntry(0.01)).toBe(true);
    expect(liveDisagreesWithTxEntry(20)).toBe(true);
    expect(liveDisagreesWithTxEntry(1)).toBe(false);
    expect(liveDisagreesWithTxEntry(2.5)).toBe(false);
  });

  it("YCAT-class: prefer live when already ≥ LOSS_PCT below tx even inside 3× band", () => {
    // ratio ~0.36 is inside 1/3…3 so liveDisagrees is false, but underwater ≥15%
    expect(liveDisagreesWithTxEntry(0.36)).toBe(false);
    expect(preferLiveOverTxEntry(0.36)).toBe(true);
    expect(preferLiveOverTxEntry(0.90)).toBe(false); // −10% noise — keep tx
    expect(preferLiveOverTxEntry(0.85)).toBe(true); // exactly −15%
    expect(preferLiveOverTxEntry(1.2)).toBe(false);
    expect(preferLiveOverTxEntry(0.01)).toBe(true); // also fails 3× band
  });

  it("SLs a −99% rug after open-grace (EPEP-class)", () => {
    const book = bookWithProvenSeed();
    const opened = openPaperCopy(book, buy(), 0.0004122, "dexscreener", "EPEP").opened!;
    const now = new Date(new Date(opened.openedAt).getTime() + 6 * 60_000);
    const marked = applyMark(opened, 0.0000035, "dexscreener", now, {
      winPct: WIN_PCT,
      lossPct: LOSS_PCT,
      maxHoldHours: 6,
    });
    expect(marked.status).toBe("closed_loss");
    expect(marked.closeReason).toMatch(/rug_gap past SL/);
    expect(marked.realizedPnlUsd!).toBeLessThan(-20); // nearly full $25 size loss, not fake 0%
  });
});

describe("wallet_paper_bleed gate", () => {
  it("skips new copies after ≥2 closed net-negative from same wallet", () => {
    const book = createEmptyBook();
    const base = buy();
    // fabricate ≥2 closed losses on SAME wallet but DISTINCT mints (avoid cool-down)
    const closed = [0, 1].map((i) => ({
      id: `c${i}`,
      openedAt: "2026-09-23T10:00:00.000Z",
      closedAt: "2026-09-23T11:00:00.000Z",
      sourceWallet: wallet.address,
      sourceWalletLabel: wallet.label,
      sourceSignature: `sig-closed-${i}`,
      mint: `MintBleedHistory1111111111111111111111${i}`,
      symbol: `B${i}`,
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 0.85,
      markSource: "dexscreener" as const,
      markAt: "2026-09-23T11:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_loss" as const,
      closeReason: "SL -15%",
      realizedPnlUsd: -10,
    }));
    const withHistory = {
      ...book,
      positions: closed,
      seenSignatures: closed.map((p) => p.sourceSignature),
      cashUsd: book.cashUsd,
    };
    const nextBuy = {
      ...base,
      signature: "sig-new-bleed-check",
      mint: "MintFreshBleedCheck11111111111111111111",
    };
    const result = openPaperCopy(withHistory, nextBuy, 1, "dexscreener", "B");
    expect(result.opened).toBeNull();
    expect(result.skipReason).toBe("wallet_paper_bleed");
  });

  it("does not bleed-block a mixed W/L printer that flipped slightly net−", () => {
    // Learning 2026-09-24: CoinSmuggler 2W/2L net −$12.88 must stay eligible at
    // unproven $25 (isProvenPrinter demotes); only pure-loss or deep bleed bans.
    const book = createEmptyBook();
    const base = buy();
    const closed = [
      {
        id: "win1",
        openedAt: "2026-09-24T03:00:00.000Z",
        closedAt: "2026-09-24T04:00:00.000Z",
        sourceWallet: wallet.address,
        sourceWalletLabel: wallet.label,
        sourceSignature: "sig-mixed-win-1",
        mint: "MintMixedWin11111111111111111111111111",
        symbol: "W1",
        sizeUsd: 75,
        entryPriceUsd: 1,
        entryPriceSource: "dexscreener" as const,
        quantity: 75,
        markPriceUsd: 1.12,
        markSource: "dexscreener" as const,
        markAt: "2026-09-24T04:00:00.000Z",
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        status: "closed_win" as const,
        closeReason: "TP +12%",
        realizedPnlUsd: 55,
      },
      {
        id: "loss1",
        openedAt: "2026-09-24T03:00:00.000Z",
        closedAt: "2026-09-24T04:00:00.000Z",
        sourceWallet: wallet.address,
        sourceWalletLabel: wallet.label,
        sourceSignature: "sig-mixed-loss-1",
        mint: "MintMixedLoss1111111111111111111111111",
        symbol: "L1",
        sizeUsd: 75,
        entryPriceUsd: 1,
        entryPriceSource: "dexscreener" as const,
        quantity: 75,
        markPriceUsd: 0.33,
        markSource: "dexscreener" as const,
        markAt: "2026-09-24T04:00:00.000Z",
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        status: "closed_loss" as const,
        closeReason: "rug_gap past SL -15%",
        realizedPnlUsd: -50,
      },
      {
        id: "win2",
        openedAt: "2026-09-24T06:00:00.000Z",
        closedAt: "2026-09-24T07:00:00.000Z",
        sourceWallet: wallet.address,
        sourceWalletLabel: wallet.label,
        sourceSignature: "sig-mixed-win-2",
        mint: "MintMixedWin22222222222222222222222222",
        symbol: "W2",
        sizeUsd: 75,
        entryPriceUsd: 1,
        entryPriceSource: "dexscreener" as const,
        quantity: 75,
        markPriceUsd: 1.12,
        markSource: "dexscreener" as const,
        markAt: "2026-09-24T07:00:00.000Z",
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        status: "closed_win" as const,
        closeReason: "TP +12%",
        realizedPnlUsd: 9,
      },
      {
        id: "loss2",
        openedAt: "2026-09-24T10:00:00.000Z",
        closedAt: "2026-09-24T11:00:00.000Z",
        sourceWallet: wallet.address,
        sourceWalletLabel: wallet.label,
        sourceSignature: "sig-mixed-loss-2",
        mint: "MintMixedLoss2222222222222222222222222",
        symbol: "L2",
        sizeUsd: 75,
        entryPriceUsd: 1,
        entryPriceSource: "dexscreener" as const,
        quantity: 75,
        markPriceUsd: 0.62,
        markSource: "dexscreener" as const,
        markAt: "2026-09-24T11:00:00.000Z",
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        status: "closed_loss" as const,
        closeReason: "rug_gap past SL -15%",
        realizedPnlUsd: -28,
      },
    ];
    const withHistory = {
      ...book,
      positions: closed,
      seenSignatures: closed.map((p) => p.sourceSignature),
      cashUsd: book.cashUsd,
    };
    const nextBuy = {
      ...base,
      signature: "sig-mixed-still-eligible",
      mint: "MintMixedEligible111111111111111111111",
    };
    const result = openPaperCopy(withHistory, nextBuy, 1, "dexscreener", "OK");
    expect(result.skipReason).not.toBe("wallet_paper_bleed");
    expect(result.opened).not.toBeNull();
    // demoted: net− so unproven size, not $75
    expect(result.opened!.sizeUsd).toBe(25);
  });

  it("does not bleed-block after scrub_excess closes only (agent-forced)", () => {
    const book = createEmptyBook();
    const base = buy();
    const closed = [0, 1].map((i) => ({
      id: `scrub${i}`,
      openedAt: "2026-09-23T21:00:00.000Z",
      closedAt: "2026-09-23T23:00:00.000Z",
      sourceWallet: wallet.address,
      sourceWalletLabel: wallet.label,
      sourceSignature: `sig-scrub-${i}`,
      mint: `MintScrubOnly111111111111111111111111${i}`,
      symbol: `S${i}`,
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 0.99,
      markSource: "dexscreener" as const,
      markAt: "2026-09-23T23:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_time" as const,
      closeReason: "scrub_excess_unproven",
      realizedPnlUsd: i === 0 ? -0.55 : 0.55,
    }));
    // Other proven printer keeps virgin explorers eligible; this asserts scrub≠bleed.
    const provenOther = {
      id: "other-proven",
      openedAt: "2026-09-01T00:00:00.000Z",
      closedAt: "2026-09-01T01:00:00.000Z",
      sourceWallet: "OtherProvenWallet111111111111111111111111",
      sourceWalletLabel: "otherProven",
      sourceSignature: "sig-other-proven",
      mint: "MintOtherProven11111111111111111111111",
      symbol: "OP",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 1.2,
      markSource: "dexscreener" as const,
      markAt: "2026-09-01T01:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_win" as const,
      closeReason: "TP +12%",
      realizedPnlUsd: 5,
    };
    const withHistory = {
      ...book,
      positions: [...closed, provenOther],
      seenSignatures: [...closed.map((p) => p.sourceSignature), provenOther.sourceSignature],
      cashUsd: book.cashUsd,
    };
    const nextBuy = {
      ...base,
      signature: "sig-after-scrub-bleed-check",
      mint: "MintAfterScrubBleed1111111111111111111",
    };
    const result = openPaperCopy(withHistory, nextBuy, 1, "dexscreener", "OK");
    expect(result.skipReason).not.toBe("wallet_paper_bleed");
    expect(result.skipReason).not.toBe("explorer_needs_this_book_win");
    expect(result.opened).not.toBeNull();
  });

  it("does not overweight size after scrub-only positive realized", () => {
    const book = createEmptyBook();
    const base = buy();
    const scrubWin = {
      id: "scrub-fake-proven",
      openedAt: "2026-09-23T21:00:00.000Z",
      closedAt: "2026-09-23T23:00:00.000Z",
      sourceWallet: wallet.address,
      sourceWalletLabel: wallet.label,
      sourceSignature: "sig-scrub-fake-proven",
      mint: "MintScrubFakeProven11111111111111111111",
      symbol: "SFP",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 1.2,
      markSource: "dexscreener" as const,
      markAt: "2026-09-23T23:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_time" as const,
      closeReason: "scrub_excess_unproven",
      realizedPnlUsd: 5,
    };
    // Other proven printer keeps virgin explorers eligible; this asserts scrub≠proven size.
    const provenOther = {
      id: "other-proven",
      openedAt: "2026-09-01T00:00:00.000Z",
      closedAt: "2026-09-01T01:00:00.000Z",
      sourceWallet: "OtherProvenWallet111111111111111111111111",
      sourceWalletLabel: "otherProven",
      sourceSignature: "sig-other-proven",
      mint: "MintOtherProven11111111111111111111111",
      symbol: "OP",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 1.2,
      markSource: "dexscreener" as const,
      markAt: "2026-09-01T01:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_win" as const,
      closeReason: "TP +12%",
      realizedPnlUsd: 5,
    };
    const withHistory = {
      ...book,
      positions: [scrubWin, provenOther],
      seenSignatures: [scrubWin.sourceSignature, provenOther.sourceSignature],
      cashUsd: book.cashUsd,
    };
    const nextBuy = {
      ...base,
      signature: "sig-after-scrub-size-check",
      mint: "MintAfterScrubSize11111111111111111111",
    };
    const result = openPaperCopy(withHistory, nextBuy, 1, "dexscreener", "OK");
    expect(result.opened).not.toBeNull();
    // Must stay unproven $25 — scrub +$5 must not grant COPY_SIZE_PROVEN_USD ($75)
    expect(result.opened!.sizeUsd).toBe(25);
  });
});

describe("prefer better unproven explorer", () => {
  it("scrubs weaker unproven open so a mixed printer can take the slot", () => {
    // Learning 2026-09-24 ~06:53: CoinSmuggler-like 2W mixed blocked while
    // 0W explorer held the only MAX_OPEN_UNPROVEN slot.
    const weakWallet = "WeakExplorer11111111111111111111111111111";
    const strongWallet = "StrongMixed11111111111111111111111111111";
    const book = createEmptyBook();
    const weakLoss = {
      id: "weak-closed",
      openedAt: "2026-09-24T03:00:00.000Z",
      closedAt: "2026-09-24T04:00:00.000Z",
      sourceWallet: weakWallet,
      sourceWalletLabel: "weak",
      sourceSignature: "sig-weak-loss",
      mint: "MintWeakLoss11111111111111111111111111",
      symbol: "WL",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 0.9,
      markSource: "dexscreener" as const,
      markAt: "2026-09-24T04:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_time" as const,
      closeReason: "time-stop 6h",
      realizedPnlUsd: -1.5,
    };
    const weakOpen = {
      id: "weak-open",
      openedAt: "2026-09-24T10:00:00.000Z",
      sourceWallet: weakWallet,
      sourceWalletLabel: "weak",
      sourceSignature: "sig-weak-open",
      mint: "MintWeakOpen11111111111111111111111111",
      symbol: "WO",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 0.9,
      markSource: "dexscreener" as const,
      markAt: "2026-09-24T12:00:00.000Z",
      unrealizedPnlUsd: -2.5,
      unrealizedPnlPct: -0.1,
      status: "open" as const,
    };
    const strongCloses = [
      {
        id: "s-win1",
        openedAt: "2026-09-24T03:00:00.000Z",
        closedAt: "2026-09-24T04:00:00.000Z",
        sourceWallet: strongWallet,
        sourceWalletLabel: "strong",
        sourceSignature: "sig-strong-win-1",
        mint: "MintStrongWin111111111111111111111111",
        symbol: "SW1",
        sizeUsd: 75,
        entryPriceUsd: 1,
        entryPriceSource: "dexscreener" as const,
        quantity: 75,
        markPriceUsd: 1.12,
        markSource: "dexscreener" as const,
        markAt: "2026-09-24T04:00:00.000Z",
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        status: "closed_win" as const,
        closeReason: "TP +12%",
        realizedPnlUsd: 30,
      },
      {
        id: "s-win2",
        openedAt: "2026-09-24T04:00:00.000Z",
        closedAt: "2026-09-24T05:00:00.000Z",
        sourceWallet: strongWallet,
        sourceWalletLabel: "strong",
        sourceSignature: "sig-strong-win-2",
        mint: "MintStrongWin222222222222222222222222",
        symbol: "SW2",
        sizeUsd: 75,
        entryPriceUsd: 1,
        entryPriceSource: "dexscreener" as const,
        quantity: 75,
        markPriceUsd: 1.12,
        markSource: "dexscreener" as const,
        markAt: "2026-09-24T05:00:00.000Z",
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        status: "closed_win" as const,
        closeReason: "TP +12%",
        realizedPnlUsd: 25,
      },
      {
        id: "s-loss1",
        openedAt: "2026-09-24T05:00:00.000Z",
        closedAt: "2026-09-24T06:00:00.000Z",
        sourceWallet: strongWallet,
        sourceWalletLabel: "strong",
        sourceSignature: "sig-strong-loss-1",
        mint: "MintStrongLoss1111111111111111111111",
        symbol: "SL1",
        sizeUsd: 75,
        entryPriceUsd: 1,
        entryPriceSource: "dexscreener" as const,
        quantity: 75,
        markPriceUsd: 0.85,
        markSource: "dexscreener" as const,
        markAt: "2026-09-24T06:00:00.000Z",
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        status: "closed_loss" as const,
        closeReason: "rug_gap past SL -15%",
        realizedPnlUsd: -40,
      },
      {
        id: "s-loss2",
        openedAt: "2026-09-24T06:00:00.000Z",
        closedAt: "2026-09-24T07:00:00.000Z",
        sourceWallet: strongWallet,
        sourceWalletLabel: "strong",
        sourceSignature: "sig-strong-loss-2",
        mint: "MintStrongLoss2222222222222222222222",
        symbol: "SL2",
        sizeUsd: 75,
        entryPriceUsd: 1,
        entryPriceSource: "dexscreener" as const,
        quantity: 75,
        markPriceUsd: 0.85,
        markSource: "dexscreener" as const,
        markAt: "2026-09-24T07:00:00.000Z",
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        status: "closed_loss" as const,
        closeReason: "rug_gap past SL -15%",
        realizedPnlUsd: -28,
      },
    ];
    const withSlot = {
      ...book,
      positions: [weakLoss, weakOpen, ...strongCloses],
      seenSignatures: [
        weakLoss.sourceSignature,
        weakOpen.sourceSignature,
        ...strongCloses.map((p) => p.sourceSignature),
      ],
      cashUsd: book.cashUsd - 25,
    };
    const weakScore = unprovenExplorerScore(withSlot, weakWallet);
    const strongScore = unprovenExplorerScore(withSlot, strongWallet);
    expect(compareExplorerScore(strongScore, weakScore)).toBeGreaterThan(0);

    const nextBuy = {
      ...buy(),
      walletAddress: strongWallet,
      walletLabel: "strong",
      signature: "sig-strong-new-buy",
      mint: "MintStrongNew1111111111111111111111111",
    };
    const result = openPaperCopy(withSlot, nextBuy, 1, "dexscreener", "NEW");
    expect(result.opened).not.toBeNull();
    expect(result.opened!.sourceWallet).toBe(strongWallet);
    expect(result.opened!.sizeUsd).toBe(25); // demoted unproven
    const scrubbed = result.book.positions.find((p) => p.id === "weak-open");
    expect(scrubbed?.status).not.toBe("open");
    expect(scrubbed?.closeReason).toBe("scrub_prefer_better_unproven");
  });

  it("does not scrub when buyer is not a stronger explorer", () => {
    const holder = "HolderExplorer111111111111111111111111111";
    const weaker = "WeakerBuyer11111111111111111111111111111";
    const book = createEmptyBook();
    const holderWin = {
      id: "h-win",
      openedAt: "2026-09-24T03:00:00.000Z",
      closedAt: "2026-09-24T04:00:00.000Z",
      sourceWallet: holder,
      sourceWalletLabel: "holder",
      sourceSignature: "sig-holder-win",
      mint: "MintHolderWin111111111111111111111111",
      symbol: "HW",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 1.12,
      markSource: "dexscreener" as const,
      markAt: "2026-09-24T04:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_win" as const,
      closeReason: "TP +12%",
      realizedPnlUsd: 10,
    };
    const holderLoss = {
      id: "h-loss",
      openedAt: "2026-09-24T05:00:00.000Z",
      closedAt: "2026-09-24T06:00:00.000Z",
      sourceWallet: holder,
      sourceWalletLabel: "holder",
      sourceSignature: "sig-holder-loss",
      mint: "MintHolderLoss1111111111111111111111",
      symbol: "HL",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 0.8,
      markSource: "dexscreener" as const,
      markAt: "2026-09-24T06:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_loss" as const,
      closeReason: "SL -15%",
      realizedPnlUsd: -20,
    };
    const holderOpen = {
      id: "h-open",
      openedAt: "2026-09-24T10:00:00.000Z",
      sourceWallet: holder,
      sourceWalletLabel: "holder",
      sourceSignature: "sig-holder-open",
      mint: "MintHolderOpen11111111111111111111111",
      symbol: "HO",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 1,
      markSource: "dexscreener" as const,
      markAt: "2026-09-24T12:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "open" as const,
    };
    const withSlot = {
      ...book,
      positions: [holderWin, holderLoss, holderOpen],
      seenSignatures: [
        holderWin.sourceSignature,
        holderLoss.sourceSignature,
        holderOpen.sourceSignature,
      ],
      cashUsd: book.cashUsd - 25,
    };
    const nextBuy = {
      ...buy(),
      walletAddress: weaker,
      walletLabel: "weaker",
      signature: "sig-weaker-buy",
      mint: "MintWeakerNew1111111111111111111111111",
    };
    const result = openPaperCopy(withSlot, nextBuy, 1, "dexscreener", "W");
    expect(result.opened).toBeNull();
    // Zero proven + weaker has 0 wins → explorer gate (still does not scrub holder).
    expect(result.skipReason).toBe("explorer_needs_this_book_win");
    expect(result.book.positions.find((p) => p.id === "h-open")?.status).toBe(
      "open",
    );
  });

  it("does not scrub for a virgin buyer over a slight-loss holder", () => {
    // Learning 2026-09-24 ~08:06 MDT: onlyljc (0 closes) must not crystallize
    // passthedutcher GP mark loss just because 0 > -1.58 realized.
    const holder = "SlightLossHolder1111111111111111111111111";
    const virgin = "VirginBuyer111111111111111111111111111111";
    const book = createEmptyBook();
    const holderLoss = {
      id: "sl-loss",
      openedAt: "2026-09-24T03:00:00.000Z",
      closedAt: "2026-09-24T09:00:00.000Z",
      sourceWallet: holder,
      sourceWalletLabel: "holder",
      sourceSignature: "sig-sl-loss",
      mint: "MintSlightLoss111111111111111111111111",
      symbol: "WAGMI",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 0.936,
      markSource: "dexscreener" as const,
      markAt: "2026-09-24T09:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_time" as const,
      closeReason: "time-stop 6h",
      realizedPnlUsd: -1.58,
    };
    const holderOpen = {
      id: "sl-open",
      openedAt: "2026-09-24T10:00:00.000Z",
      sourceWallet: holder,
      sourceWalletLabel: "holder",
      sourceSignature: "sig-sl-open",
      mint: "MintSlightOpen111111111111111111111111",
      symbol: "GP",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 0.93,
      markSource: "dexscreener" as const,
      markAt: "2026-09-24T14:00:00.000Z",
      unrealizedPnlUsd: -1.75,
      unrealizedPnlPct: -0.07,
      status: "open" as const,
    };
    const withSlot = {
      ...book,
      positions: [holderLoss, holderOpen],
      seenSignatures: [holderLoss.sourceSignature, holderOpen.sourceSignature],
      cashUsd: book.cashUsd - 25,
    };
    const holderScore = unprovenExplorerScore(withSlot, holder);
    const virginScore = unprovenExplorerScore(withSlot, virgin);
    expect(compareExplorerScore(virginScore, holderScore)).toBeGreaterThan(0);
    expect(canDisplaceExplorer(virginScore, holderScore)).toBe(false);

    const result = openPaperCopy(
      withSlot,
      {
        ...buy(),
        walletAddress: virgin,
        walletLabel: "virgin",
        signature: "sig-virgin-buy",
        mint: "MintVirginNew11111111111111111111111111",
      },
      1,
      "dexscreener",
      "GREEF",
    );
    expect(result.opened).toBeNull();
    // Learning 2026-09-24 ~11:21 MDT: with zero proven printers, virgin explorers
    // are refused before the unproven-slot check (onlyljc GREEF-class spray).
    expect(result.skipReason).toBe("explorer_needs_this_book_win");
    expect(result.book.positions.find((p) => p.id === "sl-open")?.status).toBe(
      "open",
    );
  });
});

describe("refuse underwater tx entry", () => {
  it("refuses YCAT-class live≤(1−LOSS_PCT)×tx ratios", () => {
    expect(shouldRefuseUnderwaterTxEntry(0.36)).toBe(true);
    expect(shouldRefuseUnderwaterTxEntry(0.85)).toBe(true);
    expect(shouldRefuseUnderwaterTxEntry(0.90)).toBe(false);
    expect(shouldRefuseUnderwaterTxEntry(1.0)).toBe(false);
    expect(shouldRefuseUnderwaterTxEntry(0.01)).toBe(true);
  });
});

describe("proven size cooldown after TP / rug_gap", () => {
  it("uses $25 after a recent TP even when still net+ proven", () => {
    const book = bookWithProvenSeed();
    const now = new Date("2026-09-24T16:00:00.000Z");
    const recentTp = {
      id: "recent-tp",
      openedAt: "2026-09-24T15:00:00.000Z",
      closedAt: "2026-09-24T15:53:00.000Z",
      sourceWallet: wallet.address,
      sourceWalletLabel: wallet.label,
      sourceSignature: "sig-recent-tp",
      mint: "MintRecentTp11111111111111111111111111",
      symbol: "SDOG",
      sizeUsd: 75,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 75,
      markPriceUsd: 1.12,
      markSource: "dexscreener" as const,
      markAt: "2026-09-24T15:53:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_win" as const,
      closeReason: "TP +12%",
      realizedPnlUsd: 33,
    };
    const withTp = {
      ...book,
      positions: [...book.positions, recentTp],
      seenSignatures: [...book.seenSignatures, recentTp.sourceSignature],
    };
    expect(shouldUseProvenSize(withTp, wallet.address, now)).toBe(false);
    const result = openPaperCopy(
      withTp,
      buy({
        signature: "sig-post-tp-moonimals",
        mint: "MintMoonimals111111111111111111111111",
      }),
      1,
      "dexscreener",
      "MOONIMALS",
      now,
    );
    expect(result.opened).not.toBeNull();
    expect(result.opened!.sizeUsd).toBe(COPY_SIZE_USD);
  });

  it("uses $25 after a recent rug_gap even when still net+ proven", () => {
    const book = bookWithProvenSeed();
    const now = new Date("2026-09-24T16:30:00.000Z");
    const recentRug = {
      id: "recent-rug",
      openedAt: "2026-09-24T15:50:00.000Z",
      closedAt: "2026-09-24T15:57:00.000Z",
      sourceWallet: wallet.address,
      sourceWalletLabel: wallet.label,
      sourceSignature: "sig-recent-rug",
      mint: "MintRecentRug111111111111111111111111",
      symbol: "MOON",
      sizeUsd: 75,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 75,
      markPriceUsd: 0.56,
      markSource: "dexscreener" as const,
      markAt: "2026-09-24T15:57:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_loss" as const,
      closeReason: "rug_gap past SL -15%",
      realizedPnlUsd: -33,
    };
    // Keep net+ via seed +$5 and a large older TP outside cooldown window.
    const oldTp = {
      id: "old-tp",
      openedAt: "2026-09-23T10:00:00.000Z",
      closedAt: "2026-09-23T11:00:00.000Z",
      sourceWallet: wallet.address,
      sourceWalletLabel: wallet.label,
      sourceSignature: "sig-old-tp",
      mint: "MintOldTp1111111111111111111111111111",
      symbol: "OLD",
      sizeUsd: 75,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 75,
      markPriceUsd: 1.12,
      markSource: "dexscreener" as const,
      markAt: "2026-09-23T11:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_win" as const,
      closeReason: "TP +12%",
      realizedPnlUsd: 40,
    };
    const withRug = {
      ...book,
      positions: [...book.positions, oldTp, recentRug],
      seenSignatures: [
        ...book.seenSignatures,
        oldTp.sourceSignature,
        recentRug.sourceSignature,
      ],
    };
    expect(shouldUseProvenSize(withRug, wallet.address, now)).toBe(false);
    const result = openPaperCopy(
      withRug,
      buy({
        signature: "sig-post-rug-ycat",
        mint: "MintYcatFollow11111111111111111111111",
      }),
      1,
      "dexscreener",
      "YCAT",
      now,
    );
    expect(result.opened).not.toBeNull();
    expect(result.opened!.sizeUsd).toBe(COPY_SIZE_USD);
  });

  it("restores $75 after proven-size cooldown elapses", () => {
    const book = bookWithProvenSeed();
    const tpAt = new Date("2026-09-24T08:00:00.000Z");
    const now = new Date(tpAt.getTime() + PROVEN_SIZE_COOLDOWN_MS + 60_000);
    const cooledTp = {
      id: "cooled-tp",
      openedAt: "2026-09-24T07:00:00.000Z",
      closedAt: tpAt.toISOString(),
      sourceWallet: wallet.address,
      sourceWalletLabel: wallet.label,
      sourceSignature: "sig-cooled-tp",
      mint: "MintCooledTp1111111111111111111111111",
      symbol: "COOL",
      sizeUsd: 75,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 75,
      markPriceUsd: 1.12,
      markSource: "dexscreener" as const,
      markAt: tpAt.toISOString(),
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_win" as const,
      closeReason: "TP +12%",
      realizedPnlUsd: 20,
    };
    const withTp = {
      ...book,
      positions: [...book.positions, cooledTp],
      seenSignatures: [...book.seenSignatures, cooledTp.sourceSignature],
    };
    expect(shouldUseProvenSize(withTp, wallet.address, now)).toBe(true);
    const result = openPaperCopy(
      withTp,
      buy({
        signature: "sig-after-cool",
        mint: "MintAfterCool111111111111111111111111",
      }),
      1,
      "dexscreener",
      "NEXT",
      now,
    );
    expect(result.opened).not.toBeNull();
    expect(result.opened!.sizeUsd).toBe(COPY_SIZE_PROVEN_USD);
  });
});

describe("explorer discipline when zero proven printers", () => {
  it("blocks virgin explorers when the book has no proven printer", () => {
    const book = createEmptyBook();
    expect(hasAnyProvenPrinter(book)).toBe(false);
    const result = openPaperCopy(
      book,
      buy({
        signature: "sig-virgin-explorer",
        mint: "MintVirginExplorer1111111111111111111",
      }),
      1,
      "dexscreener",
      "GREEF",
    );
    expect(result.opened).toBeNull();
    expect(result.skipReason).toBe("explorer_needs_this_book_win");
  });

  it("allows a demoted mixed printer with ≥1 this-book win to fill $25 slot", () => {
    const book = createEmptyBook();
    const win = {
      id: "mixed-win",
      openedAt: "2026-09-24T04:00:00.000Z",
      closedAt: "2026-09-24T05:00:00.000Z",
      sourceWallet: wallet.address,
      sourceWalletLabel: wallet.label,
      sourceSignature: "sig-mixed-win",
      mint: "MintMixedWin1111111111111111111111111",
      symbol: "SHART",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 1.12,
      markSource: "dexscreener" as const,
      markAt: "2026-09-24T05:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_win" as const,
      closeReason: "TP +12%",
      realizedPnlUsd: 10,
    };
    const loss = {
      id: "mixed-loss",
      openedAt: "2026-09-24T06:00:00.000Z",
      closedAt: "2026-09-24T07:00:00.000Z",
      sourceWallet: wallet.address,
      sourceWalletLabel: wallet.label,
      sourceSignature: "sig-mixed-loss",
      mint: "MintMixedLoss111111111111111111111111",
      symbol: "GO",
      sizeUsd: 25,
      entryPriceUsd: 1,
      entryPriceSource: "dexscreener" as const,
      quantity: 25,
      markPriceUsd: 0.2,
      markSource: "dexscreener" as const,
      markAt: "2026-09-24T07:00:00.000Z",
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      status: "closed_loss" as const,
      closeReason: "rug_gap past SL -15%",
      realizedPnlUsd: -20,
    };
    const withMixed = {
      ...book,
      positions: [win, loss],
      seenSignatures: [win.sourceSignature, loss.sourceSignature],
    };
    expect(hasAnyProvenPrinter(withMixed)).toBe(false); // net −$10
    const result = openPaperCopy(
      withMixed,
      buy({
        signature: "sig-mixed-retry",
        mint: "MintMixedRetry11111111111111111111111",
      }),
      1,
      "dexscreener",
      "RETRY",
    );
    expect(result.opened).not.toBeNull();
    expect(result.opened!.sizeUsd).toBe(COPY_SIZE_USD);
  });
});

// ============================================================================
// LEARNING MODE (2026-09-24): many small exploratory copies, data-quality gates
// kept, feature tags, partial TP + trail, auto promote/demote + TP/SL tune.
// ============================================================================
import {
  LEARNING_MODE,
  LEARNING_POLICY,
  LEARNING_EXPLORER_SIZE_USD,
  READMIT_SIZE_CAP_USD,
  YOUNG_THIN_SIZE_CAP_USD,
  LEARNING_PROVEN_SIZE_USD,
  getActivePolicy,
  TRACKED_WALLETS,
  BLEEDERS_ARCHIVED,
} from "../src/copytrade/config.js";
import {
  buildLearningFeatures,
  closePosition,
  decideEntry,
  isProvenPrinter,
  markOpts,
  settleCashDelta,
  exitBucketOf,
  equityOf,
} from "../src/copytrade/paperBook.js";
import {
  analyzeBook,
  computeLearningTuning,
  replayTradePct,
  tokenAgeBucket,
  liquidityBucket,
} from "../src/copytrade/learning.js";
import type { CopyBookState, PaperCopyPosition } from "../src/copytrade/types.js";

function mkWallet(n: number): string {
  return `LWallet${String(n).padStart(3, "0")}`.padEnd(44, "1");
}
function mkMint(n: number): string {
  return `LMint${String(n).padStart(4, "0")}`.padEnd(44, "1");
}
function lbuy(w: number, m: number, over: Partial<WalletBuyEvent> = {}): WalletBuyEvent {
  return buy({
    walletAddress: mkWallet(w),
    walletLabel: `w${w}`,
    signature: `lsig-${w}-${m}-${Math.random().toString(36).slice(2, 8)}`,
    mint: mkMint(m),
    ...over,
  });
}
function closedPos(
  wallet: string,
  over: Partial<PaperCopyPosition> & {
    pnl: number;
    peak?: number;
    trough?: number;
    bucket?: string;
    policy?: "learning" | "legacy";
  },
): PaperCopyPosition {
  const size = over.sizeUsd ?? 10;
  const pct = over.pnl / size;
  return {
    id: `c-${Math.random().toString(36).slice(2)}`,
    openedAt: "2026-09-24T10:00:00.000Z",
    closedAt: over.closedAt ?? "2026-09-24T11:00:00.000Z",
    sourceWallet: wallet,
    sourceWalletLabel: over.sourceWalletLabel ?? wallet.slice(0, 8),
    sourceSignature: `s-${Math.random()}`,
    mint: over.mint ?? `M${Math.random().toString(36).slice(2)}`.padEnd(44, "1"),
    symbol: "X",
    sizeUsd: size,
    entryPriceUsd: 1,
    entryPriceSource: "dexscreener",
    quantity: size,
    markPriceUsd: 1 + pct,
    markSource: "dexscreener",
    markAt: "2026-09-24T11:00:00.000Z",
    unrealizedPnlUsd: 0,
    unrealizedPnlPct: pct,
    status: over.pnl > 0 ? "closed_win" : "closed_loss",
    closeReason: over.closeReason ?? (over.pnl > 0 ? "TP +12%" : "SL -15%"),
    realizedPnlUsd: over.pnl,
    learning:
      over.policy === "legacy"
        ? undefined
        : {
            policy: "learning",
            walletTier: "explorer",
            entryMcapUsd: 50_000,
            entryLiquidityUsd: 20_000,
            tokenAgeMinutes: 90,
            txEntryPriceUsd: 1,
            liveEntryPriceUsd: 1,
            entrySlippagePct: 0,
            signalLagSec: 30,
            peakPnlPct: over.peak ?? Math.max(0, pct),
            troughPnlPct: over.trough ?? Math.min(0, pct),
            holdMinutes: 60,
            exitBucket: over.bucket ?? exitBucketOf(over.closeReason ?? (over.pnl > 0 ? "TP +12%" : "SL -15%")),
            realizedPnlPct: pct,
          },
  };
}

describe("learning mode policy", () => {
  beforeEach(() => setActivePolicy(LEARNING_POLICY));

  it("is ON by default with $25 explorer / $60 proven, max open 12 and an exposure ceiling", () => {
    expect(LEARNING_MODE).toBe(true);
    expect(getActivePolicy().name).toBe("learning");
    expect(LEARNING_EXPLORER_SIZE_USD).toBe(25);
    expect(LEARNING_PROVEN_SIZE_USD).toBe(60);
    expect(LEARNING_POLICY.explorerSizeUsd).toBe(25);
    expect(LEARNING_POLICY.provenSizeUsd).toBe(60);
    expect(LEARNING_POLICY.maxOpenPositions).toBe(12);
    expect(LEARNING_POLICY.maxExposurePctOfEquity).toBe(0.6);
    expect(YOUNG_THIN_SIZE_CAP_USD).toBe(10);
    expect(LEARNING_POLICY.maxOpenPerWallet).toBe(5);
    expect(LEARNING_POLICY.maxOpenUnprovenTotal).toBeGreaterThan(1);
    expect(LEARNING_POLICY.requireBookWinForExplorer).toBe(false);
    expect(LEARNING_POLICY.allowExplorerDisplace).toBe(false);
    expect(LEARNING_POLICY.underwaterRefusePct).toBe(0.25);
  });

  it("lets a virgin wallet open at $25 even with zero proven printers", () => {
    const book = createEmptyBook();
    expect(hasAnyProvenPrinter(book)).toBe(false);
    const r = openPaperCopy(book, lbuy(1, 1), 1, "dexscreener", "V");
    expect(r.skipReason).toBeUndefined();
    expect(r.opened!.sizeUsd).toBe(25);
    expect(r.opened!.learning?.walletTier).toBe("explorer");
  });

  it("opens explorers until the exposure ceiling / max open; proven shares the pool at $60", () => {
    let book = createEmptyBook();
    // 60% of $1000 = $600 ceiling → 12 × $25 = $300 fits; all 12 open, 13th hits max open.
    for (let i = 0; i < 12; i++) {
      const r = openPaperCopy(book, lbuy(i, i), 1, "dexscreener", `E${i}`);
      expect(r.opened, `explorer ${i}`).not.toBeNull();
      expect(r.opened!.sizeUsd).toBe(25);
      book = r.book;
    }
    const thirteenth = openPaperCopy(book, lbuy(50, 50), 1, "dexscreener", "E50");
    expect(thirteenth.skipReason).toBe("max_open_unproven_total");
    expect(thirteenth.book.positions.filter((p) => p.status === "open")).toHaveLength(12);
    // With room (10 explorers), a proven wallet (net+ ≥2 closes) opens at $60.
    book = createEmptyBook();
    for (let i = 0; i < 10; i++) {
      const r = openPaperCopy(book, lbuy(i, i), 1, "dexscreener", `E${i}`);
      book = r.book;
    }
    const pw = mkWallet(900);
    book = {
      ...book,
      positions: [
        ...book.positions,
        closedPos(pw, { pnl: 5 }),
        closedPos(pw, { pnl: 3 }),
      ],
    };
    const p1 = openPaperCopy(book, lbuy(900, 901), 1, "dexscreener", "P1");
    expect(p1.opened!.sizeUsd).toBe(60);
    expect(p1.opened!.learning?.walletTier).toBe("proven");
    book = p1.book;
    const p2 = openPaperCopy(book, lbuy(900, 902), 1, "dexscreener", "P2");
    expect(p2.opened).not.toBeNull();
    book = p2.book;
    const p3 = openPaperCopy(book, lbuy(900, 903), 1, "dexscreener", "P3");
    expect(p3.skipReason).toBe("max_open_positions");
  });

  it("total open exposure never exceeds 60% of equity or cash: shrinks to the room, then skips", () => {
    // Small book: equity $200 → ceiling $120.
    let book: CopyBookState = { ...createEmptyBook(), cashUsd: 200, bankrollUsd: 200 };
    const sizes: number[] = [];
    let skip: string | undefined;
    for (let i = 0; i < 12; i++) {
      const r = openPaperCopy(book, lbuy(i, i), 1, "dexscreener", `X${i}`);
      if (!r.opened) { skip = r.skipReason; break; }
      sizes.push(r.opened.sizeUsd);
      book = r.book;
      const cost = book.positions.filter((p) => p.status === "open").reduce((a, p) => a + p.sizeUsd, 0);
      expect(cost).toBeLessThanOrEqual(120 + 1e-9);
      expect(book.cashUsd).toBeGreaterThanOrEqual(0);
    }
    expect(sizes.slice(0, 4)).toEqual([25, 25, 25, 25]);
    expect(sizes[4]).toBe(20); // room left = $20 → shrunk
    expect(skip).toBe("max_open_exposure");
    // Never above available cash.
    const tiny: CopyBookState = { ...createEmptyBook(), cashUsd: 30, bankrollUsd: 1000 };
    const t = openPaperCopy(tiny, lbuy(1, 1), 1, "dexscreener", "T");
    expect(t.opened!.sizeUsd).toBe(18); // 60% × $30 equity
    const dust: CopyBookState = { ...createEmptyBook(), cashUsd: 12, bankrollUsd: 1000 };
    expect(openPaperCopy(dust, lbuy(1, 2), 1, "dexscreener", "D").skipReason).toBe("max_open_exposure");
  });

  it("liquidity tiers: $25 explorer needs liq ≥ $20k, $60 proven needs ≥ $50k (else steps down)", () => {
    const now = new Date("2026-09-24T12:00:00.000Z");
    const ctxL = (liq: number | null) => ({
      txEntryPriceUsd: null, liveEntryPriceUsd: 1, mcapUsd: 500_000, liquidityUsd: liq,
      createdAtMs: now.getTime() - 5 * 3600_000,
    });
    const ex = (liq: number | null, n: number) =>
      openPaperCopy(createEmptyBook(), lbuy(n, n), 1, "dexscreener", "L", now, { entryContext: ctxL(liq) }).opened!;
    expect(ex(60_000, 1).sizeUsd).toBe(25);
    expect(ex(20_000, 2).sizeUsd).toBe(25);
    const thin = ex(19_999, 3);
    expect(thin.sizeUsd).toBe(10);
    expect(thin.sizeCapTag).toContain("size_cap_thin_liquidity");
    expect(ex(null, 4).sizeUsd).toBe(10);
    const pw = mkWallet(77);
    const pbook: CopyBookState = {
      ...createEmptyBook(),
      positions: [closedPos(pw, { pnl: 5, closedAt: "2026-09-20T00:00:00.000Z" }), closedPos(pw, { pnl: 5, closedAt: "2026-09-20T01:00:00.000Z" })],
    };
    const pr = (liq: number) =>
      openPaperCopy(pbook, lbuy(77, 1), 1, "dexscreener", "P", now, { entryContext: ctxL(liq) }).opened!;
    expect(pr(80_000).sizeUsd).toBe(60);
    expect(pr(50_000).sizeUsd).toBe(60);
    expect(pr(30_000).sizeUsd).toBe(25);
    expect(pr(10_000).sizeUsd).toBe(10);
  });

  it("bigger bags keep the safety gates: skip lists, young/thin $10 cap, rug filter, suspended → shadow", () => {
    const usdc = openPaperCopy(createEmptyBook(), lbuy(1, 1), 1, "dexscreener", "USDC");
    expect(usdc.opened).toBeNull();
    expect(YOUNG_THIN_SIZE_CAP_USD).toBe(10);
  });

  it("caps opens per wallet at 5", () => {
    let book = createEmptyBook();
    for (let m = 0; m < 5; m++) {
      const r = openPaperCopy(book, lbuy(7, m), 1, "dexscreener", `M${m}`);
      expect(r.opened).not.toBeNull();
      book = r.book;
    }
    const sixth = openPaperCopy(book, lbuy(7, 99), 1, "dexscreener", "M99");
    expect(sixth.skipReason).toBe("max_open_per_wallet");
  });

  it("proven needs net+ AND ≥2 market closes; one lucky win stays explorer $25", () => {
    const w = mkWallet(3);
    const one = { ...createEmptyBook(), positions: [closedPos(w, { pnl: 8 })] };
    expect(isProvenPrinter(one, w)).toBe(false);
    expect(openPaperCopy(one, lbuy(3, 1), 1, "dexscreener", "A").opened!.sizeUsd).toBe(25);
    const two = { ...one, positions: [...one.positions, closedPos(w, { pnl: -2, closedAt: "2026-09-24T03:00:00.000Z" })] };
    expect(isProvenPrinter(two, w)).toBe(true);
  });

  it("proven size cooldown after a recent TP drops back to $25", () => {
    const w = mkWallet(4);
    const now = new Date("2026-09-24T12:00:00.000Z");
    const book: CopyBookState = {
      ...createEmptyBook(),
      positions: [
        closedPos(w, { pnl: 5, closedAt: "2026-09-24T02:00:00.000Z" }),
        closedPos(w, { pnl: 4, closedAt: "2026-09-24T11:00:00.000Z" }), // TP 1h ago
      ],
    };
    const r = openPaperCopy(book, lbuy(4, 1), 1, "dexscreener", "A", now);
    expect(r.opened!.sizeUsd).toBe(25);
    const later = new Date("2026-09-24T15:30:00.000Z"); // >3h learning cooldown
    const r2 = openPaperCopy(book, lbuy(4, 2), 1, "dexscreener", "B", later);
    expect(r2.opened!.sizeUsd).toBe(60);
  });

  it("sizeCapUsd hard-caps a wallet at its cap ($10 here) even when proven", () => {
    const w = mkWallet(5);
    const book = {
      ...createEmptyBook(),
      positions: [
        closedPos(w, { pnl: 5, closedAt: "2026-09-20T00:00:00.000Z" }),
        closedPos(w, { pnl: 5, closedAt: "2026-09-20T01:00:00.000Z" }),
      ],
    };
    const r = openPaperCopy(book, lbuy(5, 1), 1, "dexscreener", "A", new Date(), { sizeCapUsd: 10 });
    expect(r.opened!.sizeUsd).toBe(10);
  });

  it("keeps a short (2h) per-mint cooldown after SL", () => {
    const mint = mkMint(42);
    const book = {
      ...createEmptyBook(),
      positions: [closedPos(mkWallet(9), { pnl: -2, mint, closedAt: "2026-09-24T10:00:00.000Z" })],
    };
    const at1h = openPaperCopy(book, lbuy(8, 42), 1, "dexscreener", "X", new Date("2026-09-24T11:00:00.000Z"));
    expect(at1h.skipReason).toBe("recent_sl_mint_cooldown");
    const at3h = openPaperCopy(book, lbuy(8, 42), 1, "dexscreener", "X", new Date("2026-09-24T13:00:00.000Z"));
    expect(at3h.opened).not.toBeNull();
  });

  it("still blocks a second open on the same mint", () => {
    let book = createEmptyBook();
    book = openPaperCopy(book, lbuy(1, 5), 1, "dexscreener", "A").book;
    const dup = openPaperCopy(book, lbuy(2, 5), 1, "dexscreener", "A");
    expect(dup.skipReason).toBe("already_open_same_mint");
  });

  it("learning: pure-loss bleed ban retired (suspension owns it); deep bleed ≤ −$40 on qualifying closes kept", () => {
    const w = mkWallet(6);
    const four = {
      ...createEmptyBook(),
      positions: [1, 2, 3, 4].map(() => closedPos(w, { pnl: -1.5 })),
    };
    expect(openPaperCopy(four, lbuy(6, 2), 1, "dexscreener", "B").opened).not.toBeNull();
    const deep = {
      ...createEmptyBook(),
      positions: [1, 2, 3, 4, 5].map(() => closedPos(w, { pnl: -9 })),
    };
    expect(openPaperCopy(deep, lbuy(6, 3), 1, "dexscreener", "C").skipReason).toBe("wallet_paper_bleed");
    // Outage-held losses don't count toward deep bleed.
    const outage = {
      ...createEmptyBook(),
      positions: [1, 2, 3, 4, 5].map(() => {
        const c = closedPos(w, { pnl: -9 });
        return { ...c, learning: { ...c.learning!, holdMinutes: 5689 } };
      }),
    };
    expect(openPaperCopy(outage, lbuy(6, 4), 1, "dexscreener", "D").opened).not.toBeNull();
  });

  it("entry_live_below_tx loosened to 25% (legacy 15%)", () => {
    expect(decideEntry(1, 0.8, LEARNING_POLICY.underwaterRefusePct)).toBe("live");
    expect(decideEntry(1, 0.74, LEARNING_POLICY.underwaterRefusePct)).toBe("refuse");
    expect(decideEntry(1, 0.8, LEGACY_POLICY.underwaterRefusePct)).toBe("refuse");
    expect(decideEntry(1, 1.02, 0.25)).toBe("tx");
    expect(decideEntry(1, 4, 0.25)).toBe("live"); // upside band fail → prefer live
    expect(decideEntry(1, null, 0.25)).toBe("tx");
  });

  it("tags positions with learning features (mcap, liquidity, age, slippage, lag)", () => {
    const now = new Date("2026-09-24T12:00:00.000Z");
    const b = lbuy(1, 1, { blockTime: Math.floor(now.getTime() / 1000) - 45, entryPriceUsd: 1 });
    const r = openPaperCopy(createEmptyBook(), b, 1.1, "dexscreener", "F", now, {
      entryContext: {
        txEntryPriceUsd: 1,
        liveEntryPriceUsd: 1.1,
        mcapUsd: 80_000,
        liquidityUsd: 25_000,
        createdAtMs: now.getTime() - 90 * 60_000, // >60m: outside the rug filter / young-thin cap
      },
    });
    const f = r.opened!.learning!;
    expect(f.policy).toBe("learning");
    expect(f.entryMcapUsd).toBe(80_000);
    expect(f.entryLiquidityUsd).toBe(25_000);
    expect(f.tokenAgeMinutes).toBeCloseTo(90, 5);
    expect(f.entrySlippagePct).toBeCloseTo(0.1, 5);
    expect(f.signalLagSec).toBeCloseTo(45, 0);
    expect(tokenAgeBucket(f.tokenAgeMinutes)).toBe("30m-2h");
    expect(liquidityBucket(f.entryLiquidityUsd)).toBe("$10k-50k");
  });

  it("closePosition records hold time, exit bucket, and realized % on learning positions", () => {
    const opened = openPaperCopy(createEmptyBook(), lbuy(1, 1), 1, "dexscreener", "H", new Date("2026-09-24T10:00:00.000Z")).opened!;
    const marked = applyMark(opened, 0.5, "dexscreener", new Date("2026-09-24T10:30:00.000Z"), markOpts(createEmptyBook()));
    expect(marked.status).toBe("closed_loss");
    expect(marked.learning!.exitBucket).toBe("rug_gap");
    expect(marked.learning!.holdMinutes).toBeCloseTo(30, 5);
    expect(marked.learning!.realizedPnlPct).toBeCloseTo(-0.5, 5);
    expect(marked.learning!.troughPnlPct).toBeCloseTo(-0.5, 5);
  });

  it("scrubExcessUnprovenOpens no longer scrubs a single legacy explorer open (KNOTS)", () => {
    let book = createEmptyBook();
    book = openPaperCopy(book, lbuy(1, 1), 1, "dexscreener", "KNOTS").book;
    const r = scrubExcessUnprovenOpens(book);
    expect(r.closed).toHaveLength(0);
  });
});

describe("learning exits: partial TP + trailing remainder", () => {
  beforeEach(() => setActivePolicy(LEARNING_POLICY));
  const t0 = new Date("2026-09-24T10:00:00.000Z");
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);

  function openTen() {
    const book = createEmptyBook(t0);
    const r = openPaperCopy(book, lbuy(1, 1), 1, "dexscreener", "PT", t0, { sizeCapUsd: 10 }); // fixed $10 keeps the exit math readable
    return { book: r.book, pos: r.opened! };
  }

  it("banks 50% at +12% and keeps the remainder open with a trail anchor", () => {
    const { book, pos } = openTen();
    const opts = markOpts(book);
    const m = applyMark(pos, 1.15, "dexscreener", at(10), opts);
    expect(m.status).toBe("open");
    expect(m.partialTakenAt).toBeDefined();
    expect(m.quantity).toBeCloseTo(5, 6);
    expect(m.sizeUsd).toBeCloseTo(5, 6);
    expect(m.partialRealizedPnlUsd).toBeCloseTo(0.75, 6);
    expect(m.trailPeakPriceUsd).toBeCloseTo(1.15, 6);
    // Cash: half cost ($5) + partial PnL ($0.75) returns now.
    expect(settleCashDelta(pos, m)).toBeCloseTo(5.75, 6);
  });

  it("remainder trails from peak and closes as a win; cash + equity reconcile", () => {
    const { book, pos } = openTen();
    const opts = markOpts(book);
    const startCash = book.cashUsd; // 990 after $10 open
    let cash = startCash;
    const a = applyMark(pos, 1.15, "dexscreener", at(10), opts);
    cash += settleCashDelta(pos, a);
    const b = applyMark(a, 1.5, "dexscreener", at(20), opts); // new peak
    cash += settleCashDelta(a, b);
    expect(b.status).toBe("open");
    expect(b.trailPeakPriceUsd).toBeCloseTo(1.5, 6);
    // Mid-state equity: cash + remaining cost + unrealized == start equity + gains
    const mid = equityOf({ ...book, cashUsd: cash, positions: [b] });
    expect(mid.equityUsd).toBeCloseTo(1000 + 0.75 + 2.5, 6);
    expect(mid.realizedPnlUsd).toBeCloseTo(0.75, 6);
    const c = applyMark(b, 1.34, "dexscreener", at(30), opts); // < 1.5 × 0.9 = 1.35
    cash += settleCashDelta(b, c);
    expect(c.status).toBe("closed_win");
    expect(c.closeReason).toMatch(/^trail_stop/);
    expect(c.learning!.exitBucket).toBe("trail_after_partial");
    // total = 0.75 (partial) + 5 × 0.34 (remainder) = 2.45
    expect(c.realizedPnlUsd).toBeCloseTo(2.45, 6);
    expect(c.learning!.realizedPnlPct).toBeCloseTo(0.245, 6);
    expect(cash).toBeCloseTo(startCash + 10 + 2.45, 6);
    expect(c.learning!.peakPnlPct).toBeCloseTo(0.5, 6);
  });

  it("breakeven floor: remainder exits at entry, total still positive", () => {
    const { book, pos } = openTen();
    const opts = markOpts(book);
    const a = applyMark(pos, 1.12, "dexscreener", at(10), opts);
    const b = applyMark(a, 1.0, "dexscreener", at(20), opts);
    expect(b.status).toBe("closed_win");
    expect(b.realizedPnlUsd).toBeCloseTo(0.6, 6);
  });

  it("rug_gap on the remainder exits immediately", () => {
    const { book, pos } = openTen();
    const opts = markOpts(book);
    const a = applyMark(pos, 1.2, "dexscreener", at(10), opts);
    const b = applyMark(a, 0.4, "dexscreener", at(11), opts);
    expect(b.status).not.toBe("open");
    expect(b.closeReason).toMatch(/rug_gap/);
    expect(b.realizedPnlUsd).toBeCloseTo(1.0 - 3.0, 6);
  });

  it("legacy policy still closes 100% at TP", () => {
    setActivePolicy(LEGACY_POLICY);
    const book = createEmptyBook(t0);
    const pos = openPaperCopy(bookWithProvenSeed(), lbuy(1, 1), 1, "dexscreener", "L", t0).opened!;
    const m = applyMark(pos, 1.15, "dexscreener", at(10), markOpts(book));
    expect(m.status).toBe("closed_win");
    expect(m.partialTakenAt).toBeUndefined();
  });

  it("positions without learning tags (pre-existing KNOTS) still mark cleanly", () => {
    const { book, pos } = openTen();
    const legacy = { ...pos, learning: undefined };
    const m = applyMark(legacy, 1.05, "dexscreener", at(10), markOpts(book));
    expect(m.status).toBe("open");
    expect(m.learning).toBeUndefined();
    const done = closePosition(m, at(11), "closed_time", "time-stop 6h");
    expect(done.learning).toBeUndefined();
    expect(done.realizedPnlUsd).toBeCloseTo(0.5, 6);
  });
});

describe("learning analysis + auto-tune", () => {
  beforeEach(() => setActivePolicy(LEARNING_POLICY));
  const good = mkWallet(100);
  const bad = mkWallet(101);
  const mixed = mkWallet(102);

  function tunedBook(): CopyBookState {
    const ps: PaperCopyPosition[] = [];
    for (let i = 0; i < 8; i++)
      ps.push(closedPos(good, { pnl: 1.2, peak: 0.31, trough: -0.02, sourceWalletLabel: "good" }));
    for (let i = 0; i < 6; i++)
      ps.push(closedPos(bad, { pnl: -5, peak: 0.02, trough: -0.5, closeReason: "rug_gap past SL -15%", sourceWalletLabel: "bad" }));
    for (let i = 0; i < 6; i++)
      ps.push(closedPos(mixed, { pnl: -0.5, peak: 0.05, trough: -0.12, closeReason: "time-stop 6h", sourceWalletLabel: "mixed" }));
    return { ...createEmptyBook(), positions: ps };
  }

  it("does nothing below 20 learning closes (legacy closes do not count)", () => {
    const book = tunedBook();
    const few = { ...book, positions: book.positions.slice(0, 19) };
    expect(computeLearningTuning(few)).toBeNull();
    const withLegacy = {
      ...few,
      positions: [...few.positions, closedPos(good, { pnl: 1, policy: "legacy" })],
    };
    expect(computeLearningTuning(withLegacy)).toBeNull();
  });

  it("promotes net+ wallets; TP/SL pinned at base +12/−15 below 50 non-rug closes; <8 closes never suspends", () => {
    const t = computeLearningTuning(tunedBook(), new Date(), { activeWallets: [good, bad, mixed] })!;
    expect(t.learningClosed).toBe(20);
    expect(t.promoted).toEqual([good]);
    expect(t.suspended).toEqual([]); // bad/mixed have only 6 closes each
    expect(t.tpSlFrozen).toBe(true);
    expect(t.replayVersion).toBe(2);
    expect(t.winPct).toBeCloseTo(0.12, 6);
    expect(t.lossPct).toBeCloseTo(0.15, 6);
  });

  it("replay v2: stop fills with 5pp overshoot; rugs at actual; stop first when both touched", () => {
    const p = closedPos(bad, { pnl: -5, peak: 0.4, trough: -0.5, closeReason: "rug_gap past SL -15%" });
    expect(replayTradePct(p, 0.12, 0.15)).toBeCloseTo(-0.5, 6);
    const q = closedPos(good, { pnl: -1.5, peak: 0.4, trough: -0.15 });
    expect(replayTradePct(q, 0.12, 0.15)).toBeCloseTo(-0.2, 6); // −15% stop → −20% fill
    // Wider SL not breached → TP touched: 50% at +12%, remainder clamped to breakeven (actual −15%).
    expect(replayTradePct(q, 0.12, 0.2)).toBeCloseTo(0.06, 6);
  });

  it("auto-tune state drives promote/suspend gates in openPaperCopy (suspended → shadow)", () => {
    const book = tunedBook();
    const t = computeLearningTuning(book, new Date(), { activeWallets: [good, bad, mixed] })!;
    const tuned = { ...book, learningTuning: { ...t, suspended: [bad], demoted: [bad] } };
    expect(isProvenPrinter(tuned, good)).toBe(true);
    const r = openPaperCopy(tuned, lbuy(101, 1), 1, "dexscreener", "B");
    expect(r.skipReason).toBe("learning_suspended_wallet");
    expect(r.opened).toBeNull();
    expect(r.book.shadowPositions).toHaveLength(1);
    expect(r.book.shadowPositions![0]!.shadow!.reason).toBe("suspended_wallet");
    expect(r.book.cashUsd).toBe(tuned.cashUsd);
    const g = openPaperCopy(tuned, lbuy(100, 2), 1, "dexscreener", "G", new Date("2026-09-25T00:00:00.000Z"));
    expect(g.opened!.sizeUsd).toBe(60);
  });

  it("analyzeBook groups by wallet / exit / age / liquidity and suggests", () => {
    const r = analyzeBook(tunedBook());
    expect(r.totalClosed).toBe(20);
    expect(r.byWallet.map((g) => g.key)).toEqual(["good", "mixed", "bad"]);
    expect(r.byExit.find((g) => g.key === "rug_gap")!.n).toBe(6);
    expect(r.byTokenAge[0]!.key).toBe("30m-2h");
    expect(r.byLiquidity[0]!.key).toBe("$10k-50k");
    expect(r.suggestions.some((s) => s.includes("wallet good: looks profitable"))).toBe(true);
    expect(r.suggestions.some((s) => s.includes("wallet bad: bleeding"))).toBe(true);
    expect(r.suggestions.some((s) => s.startsWith("Auto-tune"))).toBe(true);
  });

  it("buildLearningFeatures tolerates missing context", () => {
    const f = buildLearningFeatures(LEARNING_POLICY, "explorer", buy({ blockTime: null, entryPriceUsd: null }), 1, undefined, new Date());
    expect(f.tokenAgeMinutes).toBeNull();
    expect(f.entrySlippagePct).toBeNull();
    expect(f.signalLagSec).toBeNull();
  });
});

describe("learning wallet roster", () => {
  it("restores tonight's 8 archived wallets at the $25 re-admit cap alongside the core printers", () => {
    const byLabel = new Map(TRACKED_WALLETS.map((w) => [w.label, w]));
    for (const l of ["passthedutcher", "onlyljc", "Cooker", "Hash", "cap", "Rilsio", "LUKEY", "zeropnl"]) {
      expect(byLabel.has(l), l).toBe(true);
      expect(byLabel.get(l)!.sizeCapUsd).toBe(READMIT_SIZE_CAP_USD);
      expect(READMIT_SIZE_CAP_USD).toBe(25);
      expect(BLEEDERS_ARCHIVED.some((w) => w.label === l)).toBe(false);
    }
    for (const l of ["counter17", "CoinSmuggler", "ily", "EustazZ"]) expect(byLabel.has(l)).toBe(true);
    expect(TRACKED_WALLETS.length).toBeGreaterThanOrEqual(4);
    const adds = TRACKED_WALLETS.filter((w) => w.source === "kolscan_leaderboard_midtier");
    expect(adds.length).toBeGreaterThanOrEqual(1);
    const addrs = TRACKED_WALLETS.map((w) => w.address);
    expect(new Set(addrs).size).toBe(addrs.length);
    for (const a of addrs) expect(a).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
  it("learning unproven cap matches max open so explorers are not frozen without proven", () => {
    expect(LEARNING_POLICY.maxOpenUnprovenTotal).toBe(LEARNING_POLICY.maxOpenPositions);
  });
});

describe("learning data-quality fixes", () => {
  beforeEach(() => setActivePolicy(LEARNING_POLICY));
  it("skips tokenized equities by venue name (HIMS Backpack Securities)", () => {
    const r = openPaperCopy(createEmptyBook(), lbuy(1, 1), 29.23, "dexscreener", "HIMS", new Date(), {
      entryContext: {
        txEntryPriceUsd: null,
        liveEntryPriceUsd: 29.23,
        mcapUsd: null,
        liquidityUsd: null,
        createdAtMs: null,
        tokenName: "Hims & Hers Health - Backpack Securities",
      },
    });
    expect(r.skipReason).toBe("skip_non_meme");
  });
  it("skips Cooker HYPE mint (dollar-priced major / weird pair)", () => {
    const r = openPaperCopy(
      createEmptyBook(),
      lbuy(1, 1, { mint: "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g" }),
      88.42,
      "dexscreener",
      "HYPE",
    );
    expect(r.opened).toBeNull();
    expect(r.skipReason).toBe("skip_non_meme");
  });
  it("skips LUKEY BONK mint (bluechip major, not mid-tier pump)", () => {
    const r = openPaperCopy(
      createEmptyBook(),
      lbuy(1, 1, { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" }),
      0.000003722,
      "tx_sol_delta",
      "Bonk",
    );
    expect(r.opened).toBeNull();
    expect(r.skipReason).toBe("skip_non_meme");
  });
  it("skips Cooker dogwifhat ($WIF) mint (bluechip major, not mid-tier pump)", () => {
    const r = openPaperCopy(
      createEmptyBook(),
      lbuy(1, 1, { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" }),
      0.2402,
      "dexscreener",
      "$WIF",
    );
    expect(r.opened).toBeNull();
    expect(r.skipReason).toBe("skip_non_meme");
  });
  it("skips $WIF by symbol even without mint list hit", () => {
    const r = openPaperCopy(createEmptyBook(), lbuy(1, 3), 0.24, "dexscreener", "$WIF");
    expect(r.opened).toBeNull();
    expect(r.skipReason).toBe("skip_non_meme");
  });
  it("skips dollar-priced entries at or above SKIP_MAX_ENTRY_PRICE_USD", () => {
    const r = openPaperCopy(createEmptyBook(), lbuy(1, 2), 12.5, "dexscreener", "WEIRD");
    expect(r.opened).toBeNull();
    expect(r.skipReason).toBe("skip_non_meme");
  });
  it("does not score phantom tx prices (3× band fail) as entry slippage", () => {
    const f = buildLearningFeatures(LEARNING_POLICY, "explorer", buy({ entryPriceUsd: 5e-8 }), 4.3e-6, {
      txEntryPriceUsd: 5e-8,
      liveEntryPriceUsd: 4.3e-6,
      mcapUsd: 4300,
      liquidityUsd: null,
      createdAtMs: null,
    }, new Date());
    expect(f.entrySlippagePct).toBeNull();
    expect(f.txEntryPriceUsd).toBe(5e-8);
  });
});
