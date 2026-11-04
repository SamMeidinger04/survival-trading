/**
 * X / social trend research via PUBLIC web sources only.
 * No X login, no posting, no official X API, no MCP connector.
 *
 * Sources (best-effort): Bing HTML, DuckDuckGo HTML, optional Nitter mirrors.
 * Graceful empty result when web fails / is blocked.
 */

export type MentionHeat = "none" | "low" | "medium" | "high" | "unknown";

export type XTrendSignal = {
  instrument: string;
  instrumentName?: string;
  query: string;
  fetchedAt: string;
  mentionHeat: MentionHeat;
  bullishNotes: string[];
  bearishNotes: string[];
  scamRugWarnings: string[];
  sourceUrls: string[];
  snippets: string[];
  scoreDelta: number;
  summary: string;
  ok: boolean;
  error?: string;
};

export type XTrendCandidate = {
  instrument: string;
  instrumentName?: string;
  symbol?: string;
  market: "pumpfun" | "polymarket";
};

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const NITTER_MIRRORS = [
  "https://nitter.privacydev.net",
  "https://nitter.poast.org",
];

const BULLISH_RE =
  /\b(moon|pumping|bullish|ape|aping|send\s*it|breakout|trending|viral|alpha|gem|based)\b/i;
const BEARISH_RE =
  /\b(dump|bearish|fade|overhyped|dead\s*coin|rug|rugged|scam|honeypot|exit\s*scam|warning|avoid)\b/i;
const SCAM_RE =
  /\b(rug\s*pull|rugged|honeypot|scam|fraud|phishing|drain|malicious|fake\s*token)\b/i;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUrls(html: string, limit = 8): string[] {
  const urls = new Set<string>();
  const re = /https?:\/\/[^\s"'<>]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && urls.size < limit) {
    const u = m[0].replace(/[),.;]+$/, "");
    if (/duckduckgo|google\.|gstatic|schema\.org|w3\.org|bing\.com\/sa|live\.com\/Web/i.test(u)) continue;
    urls.add(u);
  }
  return [...urls];
}

function snippetsFromText(text: string, needle: string, limit = 5): string[] {
  const lower = text.toLowerCase();
  const key = needle.toLowerCase();
  const out: string[] = [];
  let idx = 0;
  while (out.length < limit) {
    const found = lower.indexOf(key, idx);
    if (found < 0) break;
    const start = Math.max(0, found - 80);
    const end = Math.min(text.length, found + key.length + 120);
    out.push(text.slice(start, end).trim());
    idx = found + key.length;
  }
  return out;
}

function classifyHeat(hitCount: number, scamHits: number): MentionHeat {
  if (scamHits > 0 && hitCount === 0) return "low";
  if (hitCount >= 12) return "high";
  if (hitCount >= 5) return "medium";
  if (hitCount >= 1) return "low";
  return "none";
}

function buildQuery(c: XTrendCandidate): string {
  if (c.market === "pumpfun") {
    const sym = c.symbol ?? c.instrumentName?.split(/\s+/)[0] ?? c.instrument.slice(0, 12);
    return `$${sym} pump.fun twitter OR "crypto twitter" OR nitter`;
  }
  const q = (c.instrumentName ?? c.instrument).slice(0, 80);
  return `"${q}" polymarket twitter OR "crypto twitter"`;
}

async function fetchText(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs = 8_000,
): Promise<{ ok: boolean; status: number; text: string; url: string }> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "SurvivalTradingPaperBot/1.0 (+research; no-login; paper-only)",
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, url };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      text: "",
      url,
    };
  }
}

function analyzeCorpus(
  c: XTrendCandidate,
  query: string,
  corpus: string,
  sourceUrls: string[],
): XTrendSignal {
  const label =
    c.symbol ??
    c.instrumentName?.replace(/\s*\(.*\)\s*$/, "") ??
    c.instrument.slice(0, 24);
  const snippets = [
    ...snippetsFromText(corpus, label),
    ...snippetsFromText(corpus, "pump.fun"),
    ...snippetsFromText(corpus, "twitter"),
  ].slice(0, 6);

  const bullishNotes: string[] = [];
  const bearishNotes: string[] = [];
  const scamRugWarnings: string[] = [];

  for (const s of snippets.length ? snippets : [corpus.slice(0, 400)]) {
    if (BULLISH_RE.test(s)) bullishNotes.push(s.slice(0, 160));
    if (BEARISH_RE.test(s)) bearishNotes.push(s.slice(0, 160));
    if (SCAM_RE.test(s)) scamRugWarnings.push(s.slice(0, 160));
  }

  // Also scan full corpus counts
  const bullHits = (corpus.match(new RegExp(BULLISH_RE.source, "gi")) ?? []).length;
  const bearHits = (corpus.match(new RegExp(BEARISH_RE.source, "gi")) ?? []).length;
  const scamHits = (corpus.match(new RegExp(SCAM_RE.source, "gi")) ?? []).length;
  const tickerHits = (corpus.toLowerCase().match(new RegExp(label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;

  const mentionHeat = classifyHeat(tickerHits + bullHits, scamHits);

  let scoreDelta = 0;
  if (mentionHeat === "high") scoreDelta += 8;
  else if (mentionHeat === "medium") scoreDelta += 4;
  else if (mentionHeat === "low") scoreDelta += 1;

  scoreDelta += Math.min(6, bullHits) - Math.min(6, bearHits);
  if (scamHits > 0) scoreDelta -= Math.min(20, 8 + scamHits * 3);

  scoreDelta = Math.max(-25, Math.min(15, scoreDelta));

  const summaryParts = [
    `X/social web scan for ${label}: heat=${mentionHeat}`,
    `bull≈${bullHits} bear≈${bearHits} scam≈${scamHits}`,
    `scoreDelta=${scoreDelta}`,
  ];
  if (scamRugWarnings.length) summaryParts.push("SCAM/RUG signals present");

  return {
    instrument: c.instrument,
    instrumentName: c.instrumentName,
    query,
    fetchedAt: new Date().toISOString(),
    mentionHeat,
    bullishNotes: [...new Set(bullishNotes)].slice(0, 5),
    bearishNotes: [...new Set(bearishNotes)].slice(0, 5),
    scamRugWarnings: [...new Set(scamRugWarnings)].slice(0, 5),
    sourceUrls: sourceUrls.slice(0, 8),
    snippets: snippets.slice(0, 5),
    scoreDelta,
    summary: summaryParts.join("; "),
    ok: true,
  };
}

/**
 * Gather short social/X trend signals from public web HTML.
 * Inject `fetchImpl` in tests.
 */
export async function gatherXTrend(
  candidate: XTrendCandidate,
  opts?: { fetchImpl?: FetchLike; skipNitter?: boolean },
): Promise<XTrendSignal> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const query = buildQuery(candidate);
  const empty = (error: string): XTrendSignal => ({
    instrument: candidate.instrument,
    instrumentName: candidate.instrumentName,
    query,
    fetchedAt: new Date().toISOString(),
    mentionHeat: "unknown",
    bullishNotes: [],
    bearishNotes: [],
    scamRugWarnings: [],
    sourceUrls: [],
    snippets: [],
    scoreDelta: 0,
    summary: `X/social research unavailable: ${error}`,
    ok: false,
    error,
  });

  try {
    const pages: { url: string; text: string }[] = [];
    const sourceUrls: string[] = [];
    const errors: string[] = [];

    // Primary: Bing HTML (public; works in many datacenter egresses)
    const bingUrl =
      "https://www.bing.com/search?q=" + encodeURIComponent(query);
    const bing = await fetchText(bingUrl, fetchImpl, 12_000);
    if (bing.ok && bing.text.length > 80) {
      pages.push({ url: bing.url, text: stripHtml(bing.text) });
      sourceUrls.push(bingUrl);
      sourceUrls.push(...extractUrls(bing.text));
    } else {
      errors.push(`bing status=${bing.status}`);
    }

    // Secondary: DuckDuckGo HTML (often blocked)
    const ddgUrl =
      "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
    const ddg = await fetchText(ddgUrl, fetchImpl);
    if (ddg.ok && ddg.text.length > 80) {
      pages.push({ url: ddg.url, text: stripHtml(ddg.text) });
      sourceUrls.push(ddgUrl);
      sourceUrls.push(...extractUrls(ddg.text));
    } else if (ddg.status) {
      errors.push(`ddg status=${ddg.status}`);
    }

    if (!opts?.skipNitter) {
      const sym =
        candidate.symbol ??
        candidate.instrumentName?.match(/\b([A-Z0-9]{2,12})\b/)?.[1] ??
        "crypto";
      for (const mirror of NITTER_MIRRORS.slice(0, 1)) {
        const nitterUrl = `${mirror}/search?f=tweets&q=${encodeURIComponent("$" + sym + " OR " + sym + " pump")}`;
        const nit = await fetchText(nitterUrl, fetchImpl, 6_000);
        if (nit.ok && nit.text.length > 80 && !/instance has been rate limited|Make sure you have javascript/i.test(nit.text)) {
          pages.push({ url: nit.url, text: stripHtml(nit.text) });
          sourceUrls.push(nitterUrl);
          break;
        }
      }
    }

    if (!pages.length) {
      return empty(
        "no public web results (blocked, empty, or timeout)" +
          (errors.length ? ` [${errors.join("; ")}]` : ""),
      );
    }

    const corpus = pages.map((p) => p.text).join("\n");
    return analyzeCorpus(candidate, query, corpus, [...new Set(sourceUrls)]);
  } catch (e) {
    return empty(e instanceof Error ? e.message : String(e));
  }
}

export async function gatherXTrendsForCandidates(
  candidates: XTrendCandidate[],
  opts?: { fetchImpl?: FetchLike; concurrency?: number; skipNitter?: boolean },
): Promise<XTrendSignal[]> {
  const out: XTrendSignal[] = [];
  const concurrency = opts?.concurrency ?? 2;
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const part = await Promise.all(
      batch.map((c) => gatherXTrend(c, opts)),
    );
    out.push(...part);
  }
  return out;
}

/** Apply X trend delta to a research score and evidence lists (pure). */
export function applyXTrendToResearch<
  T extends {
    score: number;
    signals: string[];
    risks: string[];
    summary: string;
    raw?: Record<string, unknown>;
  },
>(note: T, trend: XTrendSignal): T & { score: number } {
  const signals = [...note.signals];
  const risks = [...note.risks];
  if (trend.ok) {
    signals.push(`X/social heat=${trend.mentionHeat} (Δ${trend.scoreDelta})`);
    for (const b of trend.bullishNotes.slice(0, 2)) signals.push(`X bullish: ${b.slice(0, 100)}`);
    for (const b of trend.bearishNotes.slice(0, 2)) risks.push(`X bearish: ${b.slice(0, 100)}`);
    for (const s of trend.scamRugWarnings.slice(0, 3)) risks.push(`X scam/rug warning: ${s.slice(0, 100)}`);
  } else {
    risks.push(`X/social research failed: ${trend.error ?? "unknown"}`);
  }
  const score = Math.max(0, Math.min(100, note.score + (trend.ok ? trend.scoreDelta : 0)));
  return {
    ...note,
    score,
    signals,
    risks,
    summary: `${note.summary} | ${trend.summary}`,
    raw: { ...(note.raw ?? {}), xTrend: trend },
  };
}

/** Exported for unit tests — classification helpers */
export const __xTrendTestUtils = {
  stripHtml,
  classifyHeat,
  analyzeCorpus,
  buildQuery,
};
