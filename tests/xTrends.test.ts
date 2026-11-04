import { describe, it, expect } from "vitest";
import {
  gatherXTrend,
  applyXTrendToResearch,
  __xTrendTestUtils,
  type FetchLike,
} from "../src/research/xTrends.js";
import { scorePumpCoin } from "../src/research/scorer.js";
import { PUMPFUN_FIXTURES } from "../src/markets/pumpfun/fixtures.js";
import { decideTrade } from "../src/strategy/autonomousAgent.js";
import { seedState } from "../src/state/store.js";

describe("xTrends public-web research", () => {
  it("classifies mention heat", () => {
    expect(__xTrendTestUtils.classifyHeat(0, 0)).toBe("none");
    expect(__xTrendTestUtils.classifyHeat(2, 0)).toBe("low");
    expect(__xTrendTestUtils.classifyHeat(6, 0)).toBe("medium");
    expect(__xTrendTestUtils.classifyHeat(15, 0)).toBe("high");
  });

  it("analyzeCorpus detects bullish and scam language", () => {
    const signal = __xTrendTestUtils.analyzeCorpus(
      {
        instrument: "mint1",
        instrumentName: "SDCAT (Survival Demo Cat)",
        symbol: "SDCAT",
        market: "pumpfun",
      },
      "$SDCAT pump.fun",
      "SDCAT is pumping on pump.fun trending viral gem alpha. Wait also honeypot rug pull scam warning avoid SDCAT.",
      ["https://example.com/thread"],
    );
    expect(signal.ok).toBe(true);
    expect(signal.bullishNotes.length + signal.scamRugWarnings.length).toBeGreaterThan(0);
    expect(signal.scoreDelta).toBeLessThan(0); // scam should dominate
    expect(signal.sourceUrls[0]).toContain("example.com");
  });

  it("gatherXTrend uses injected fetch and returns ok signal", async () => {
    const html = `
      <html><body>
        <a href="https://nitter.example/status/1">SDCAT moon pump viral on crypto twitter</a>
        SDCAT pump.fun trending bullish send it based gem alpha breakout
        ${" SDCAT mention filler text for length. ".repeat(20)}
      </body></html>
    `;
    const fetchImpl: FetchLike = async () =>
      new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });

    const trend = await gatherXTrend(
      {
        instrument: "DemoMint",
        instrumentName: "SDCAT (Survival Demo Cat)",
        symbol: "SDCAT",
        market: "pumpfun",
      },
      { fetchImpl, skipNitter: true },
    );
    expect(trend.ok).toBe(true);
    expect(trend.mentionHeat).not.toBe("unknown");
    expect(trend.scoreDelta).toBeGreaterThanOrEqual(0);
  });

  it("gatherXTrend returns graceful empty on fetch failure", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    const trend = await gatherXTrend(
      { instrument: "x", instrumentName: "X", symbol: "X", market: "pumpfun" },
      { fetchImpl, skipNitter: true },
    );
    expect(trend.ok).toBe(false);
    expect(trend.scoreDelta).toBe(0);
    expect(trend.mentionHeat).toBe("unknown");
  });

  it("applyXTrendToResearch boosts/penalizes score and evidence", () => {
    const base = scorePumpCoin(PUMPFUN_FIXTURES[0]!);
    const boosted = applyXTrendToResearch(base, {
      instrument: base.instrument,
      query: "q",
      fetchedAt: new Date().toISOString(),
      mentionHeat: "high",
      bullishNotes: ["trending viral"],
      bearishNotes: [],
      scamRugWarnings: [],
      sourceUrls: ["https://example.com"],
      snippets: [],
      scoreDelta: 8,
      summary: "hot",
      ok: true,
    });
    expect(boosted.score).toBe(Math.min(100, base.score + 8));
    expect(boosted.signals.some((s) => s.includes("X/social"))).toBe(true);

    const penalized = applyXTrendToResearch(base, {
      instrument: base.instrument,
      query: "q",
      fetchedAt: new Date().toISOString(),
      mentionHeat: "low",
      bullishNotes: [],
      bearishNotes: ["dump"],
      scamRugWarnings: ["rug pull", "honeypot"],
      sourceUrls: [],
      snippets: [],
      scoreDelta: -15,
      summary: "scammy",
      ok: true,
    });
    expect(penalized.score).toBe(Math.max(0, base.score - 15));
    expect(penalized.risks.some((r) => r.includes("scam/rug"))).toBe(true);
  });

  it("decideTrade skips when X scam warnings are severe", () => {
    const base = scorePumpCoin(PUMPFUN_FIXTURES[0]!);
    const withScam = applyXTrendToResearch(
      { ...base, score: 70 },
      {
        instrument: base.instrument,
        query: "q",
        fetchedAt: new Date().toISOString(),
        mentionHeat: "medium",
        bullishNotes: [],
        bearishNotes: ["dump"],
        scamRugWarnings: ["rug pull warning", "honeypot detected"],
        sourceUrls: [],
        snippets: [],
        scoreDelta: -12,
        summary: "scam",
        ok: true,
      },
    );
    const d = decideTrade(withScam, seedState(), { aggressiveness: "balanced" });
    expect(d.action).toBe("no_trade");
    if (d.action === "no_trade") expect(d.reason).toMatch(/scam\/rug/i);
  });
});
