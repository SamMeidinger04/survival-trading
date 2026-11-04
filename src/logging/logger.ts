import fs from "node:fs";
import path from "node:path";

const DEFAULT_LOG_DIR = path.resolve(
  process.env.SURVIVAL_DATA_DIR ?? path.join(process.cwd(), "data"),
  "logs",
);

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export class TradeLogger {
  readonly logDir: string;

  constructor(logDir: string = DEFAULT_LOG_DIR) {
    this.logDir = logDir;
    ensureDir(this.logDir);
  }

  private file(name: string): string {
    return path.join(this.logDir, name);
  }

  appendJsonl(filename: string, record: unknown): void {
    ensureDir(this.logDir);
    const line = JSON.stringify({ ...asObj(record), loggedAt: new Date().toISOString() }) + "\n";
    fs.appendFileSync(this.file(filename), line, "utf8");
  }

  writeJson(filename: string, record: unknown): void {
    ensureDir(this.logDir);
    fs.writeFileSync(this.file(filename), JSON.stringify(record, null, 2) + "\n", "utf8");
  }

  logResearch(note: unknown): void {
    this.appendJsonl("market_research.jsonl", note);
  }

  logXTrends(payload: unknown): void {
    this.appendJsonl("x_trends.jsonl", payload);
  }

  logProposed(proposal: unknown): void {
    this.appendJsonl("proposed_trades.jsonl", proposal);
  }

  logApproved(payload: unknown): void {
    this.appendJsonl("approved_trades.jsonl", payload);
  }

  logRejected(payload: unknown): void {
    this.appendJsonl("rejected_trades.jsonl", payload);
  }

  logOpenPositions(positions: unknown): void {
    this.writeJson("open_positions.json", positions);
  }

  logClosedPosition(position: unknown): void {
    this.appendJsonl("closed_positions.jsonl", position);
  }

  logRealizedPnl(entry: unknown): void {
    this.appendJsonl("realized_pnl.jsonl", entry);
  }

  logUnrealizedPnl(entry: unknown): void {
    this.appendJsonl("unrealized_pnl.jsonl", entry);
  }

  logBankroll(snapshot: unknown): void {
    this.appendJsonl("bankroll.jsonl", snapshot);
    this.writeJson("current_bankroll.json", snapshot);
  }

  logPerformance(snapshot: unknown): void {
    this.writeJson("performance.json", snapshot);
  }

  logSurvival(snapshot: unknown): void {
    this.appendJsonl("survival.jsonl", snapshot);
    this.writeJson("survival_status.json", snapshot);
  }
}

function asObj(record: unknown): Record<string, unknown> {
  if (record && typeof record === "object") return record as Record<string, unknown>;
  return { value: record };
}

export function computePerformance(state: {
  closedPositions: Array<{ realizedPnlUsd: number; market: string; strategy: string }>;
  openPositions: Array<{ unrealizedPnlUsd: number }>;
  bankrollUsd: number;
  peakBankrollUsd: number;
}): {
  winRate: number;
  wins: number;
  losses: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  byMarket: Record<string, { trades: number; pnl: number; wins: number }>;
  byStrategy: Record<string, { trades: number; pnl: number; wins: number }>;
  drawdownPct: number;
} {
  const closed = state.closedPositions;
  const wins = closed.filter((p) => p.realizedPnlUsd > 0).length;
  const losses = closed.filter((p) => p.realizedPnlUsd <= 0).length;
  const realizedPnlUsd = closed.reduce((s, p) => s + p.realizedPnlUsd, 0);
  const unrealizedPnlUsd = state.openPositions.reduce((s, p) => s + (p.unrealizedPnlUsd ?? 0), 0);
  const byMarket: Record<string, { trades: number; pnl: number; wins: number }> = {};
  const byStrategy: Record<string, { trades: number; pnl: number; wins: number }> = {};

  for (const p of closed) {
    byMarket[p.market] ??= { trades: 0, pnl: 0, wins: 0 };
    byMarket[p.market].trades += 1;
    byMarket[p.market].pnl += p.realizedPnlUsd;
    if (p.realizedPnlUsd > 0) byMarket[p.market].wins += 1;

    byStrategy[p.strategy] ??= { trades: 0, pnl: 0, wins: 0 };
    byStrategy[p.strategy].trades += 1;
    byStrategy[p.strategy].pnl += p.realizedPnlUsd;
    if (p.realizedPnlUsd > 0) byStrategy[p.strategy].wins += 1;
  }

  const drawdownPct =
    state.peakBankrollUsd > 0
      ? ((state.peakBankrollUsd - state.bankrollUsd) / state.peakBankrollUsd) * 100
      : 0;

  return {
    winRate: closed.length === 0 ? 0 : wins / closed.length,
    wins,
    losses,
    realizedPnlUsd,
    unrealizedPnlUsd,
    byMarket,
    byStrategy,
    drawdownPct,
  };
}
