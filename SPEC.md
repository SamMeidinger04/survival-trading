# Survival Trading System — Build Spec (v1)

## Mission
Build and operate a self-funding trading system with a finite bankroll. Research markets, find opportunities, track positions, manage risk, maintain detailed logs, preserve capital.

**Hard rule:** You may not modify, remove, bypass, or weaken hard-coded risk controls. Encode them as immutable constants / sealed module that other code cannot override at runtime.

## Bankroll & markets
- Starting bankroll: **$100 USD** experimental. Never add funds automatically.
- **Pump.fun** — eventual live-trading side. For v1: read-only market scanning + **simulated** trades only. No wallet, no signing, no live execution.
- **Polymarket** — scanner, research, probability model, **paper-trading** only. **Do not** implement live Polymarket execution.

## Hard risk rules (immutable)
1. Starting bankroll: $100
2. Never add additional funds automatically
3. No leverage or borrowing
4. Pump.fun max position: **2%** of current bankroll per trade
5. Polymarket simulated max position: **6%** of current bankroll per trade
6. Maximum **5** open positions total
7. Never increase position size simply to recover a loss
8. No martingale
9. No wash trading, fake volume, coordinated wallets, spoofing, or market manipulation
10. Every trade requires an **exit plan before entry**
11. If bankroll falls **25%** from peak → cut max position sizes in half
12. If bankroll falls **40%** from peak → stop opening positions; require human approval to continue
13. If bankroll reaches **$0** → permanently disable trading
14. Risk rules module must refuse mutation / bypass

## Pipeline (implement end-to-end in simulation)
Market data → research → opportunity scoring → trade proposal → hard risk validation → execution/simulation → position monitoring → trade logging → bankroll update → survival check

Use **structured JSON** for all trade proposals (schemas, not free-form text).

## Persistent logs (JSONL or JSON files under `data/logs/`)
- market research
- proposed trades
- approved trades
- rejected trades
- open positions
- closed positions
- realized P&L
- unrealized P&L
- current bankroll
- peak bankroll
- drawdown
- win rate
- performance by strategy and market type

## Tech requirements
- Before writing major components, **verify current official SDKs/docs** (web search / fetch). Do not rely on outdated examples.
- Pump.fun: current official Pump.fun / Solana tooling; read-only scanning + sim trades.
- Polymarket: current official public API/SDK; research + paper trading only.
- Prefer TypeScript or Python; pick one stack and stick to it. Include `README.md`, `package.json` or `pyproject.toml`, lockfile if feasible.
- CLI or scripts to: run scanners (read-only), propose a trade (JSON), validate via risk engine, simulate fill, update bankroll/logs, print survival status.
- Include unit tests for the risk engine covering: position limits, max open positions, drawdown 25%/40%, zero bankroll halt, missing exit plan rejection, no martingale / no loss-chasing size increase.
- Seed state: bankroll=$100, peak=$100, no positions.
- Demo script that produces **one example Pump.fun simulated trade** and **one example Polymarket paper trade** (can use fixture/mock market data if live APIs are flaky, but wire real client interfaces and document how live read-only calls work).

## Explicitly out of scope for v1
- No wallet creation or connection
- No live signing / autonomous real-money execution
- No live Polymarket execution
- No automatic fund deposits

## Deliverables in final report
1. Folder structure created
2. Packages installed
3. How the risk engine works
4. One example Pump.fun simulated trade (show JSON proposal + log outcome)
5. One example Polymarket simulated trade (show JSON proposal + log outcome)
6. What still needs to be built before any real money can be used

Save demo output / example JSON under `artifacts/` so it can be copied back.
