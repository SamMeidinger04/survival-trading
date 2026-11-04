# Survival Trading

**Autonomous paper-trading research system** in TypeScript: risk-bounded capital allocation, market research, and smart-wallet copy-trade simulation across Pump.fun and Polymarket-style venues.

> **Simulation / paper / read-only only.** No wallets, no signing, no live order placement. Starting capital is simulated; nothing here moves real money.

## Why this exists

Most “trading bots” are either black-box scripts or dashboards with no risk model. This project treats trading as an **engineering problem**:

- An autonomous agent proposes size, venue, and timing
- An immutable **risk engine** enforces hard capital and holding-period boundaries the agent cannot weaken
- A pipeline **propose → validate → simulate fill → sync equity** keeps every decision auditable
- A **copy-trade** layer tracks mid-tier smart wallets, paper-mirrors entries, and learns from exits

## Architecture

```
research (web / social heat) ──┐
smart-wallet activity (RPC) ───┼──► strategy agent ──► risk validate ──► paper book
fixtures / market clients ─────┘                              │
                                                              ▼
                                                         equity + post-mortem logs
```

| Module | Role |
|--------|------|
| `src/strategy/` | Autonomous sizing & trade decisions (1%–100% of controlled equity) |
| `src/risk/` | Immutable boundaries: no leverage, no external funding, ≤48h holds, death at $0 equity |
| `src/pipeline/` | Propose → validate → sim fill → equity sync |
| `src/copytrade/` | Mid-tier wallet discovery, qualification, paper book, TP/SL/time-stop exits, learning mode |
| `src/research/` | Public-web trend/heat scoring (fails soft when blocked) |
| `src/markets/` | Pump.fun + Polymarket clients/fixtures |
| `tests/` | Vitest suites for autonomy, risk, pipeline, copy-trade rules |

## Headline results (paper only)

Tracked in `COPYTRADE_STATUS.md` from live paper cycles:

- **Starting capital:** $100 simulated equity
- **Latest paper book equity:** ~$610 (cash + marks; includes open positions)
- **Learning mode:** win-rate / PnL breakdowns by wallet, exit reason, token age, liquidity, slippage (`npm run copy-learn`)
- **Risk posture:** no leverage, no deposits/bailouts, forced time-stops, agent marked `DEAD` if equity ≤ $0 (no revival)

These numbers are **simulation outcomes**, not live P&L. They exist to stress-test allocation logic under real market data feeds.

## Quick start

```bash
npm install
npm test
npm run demo
npm run status
npm run copy-cycle    # paper smart-wallet copy cycle ($0 real)
npm run copy-learn    # analyze paper book performance
npm run autonomy-live # read-only scan + paper proposals
```

Node **≥ 20** required.

## Design constraints (immutable)

| Boundary | Rule |
|----------|------|
| Starting capital | $100 cash/equity |
| External funding | Forbidden |
| Leverage / borrowing | Forbidden |
| Holding period | ≤ 48 hours |
| Death | `total_equity ≤ $0` → trading disabled permanently |

Informational labels (`NORMAL` / `CAUTION` / `CRITICAL`) never change position limits — only **DEAD** stops the agent.

## Stack

TypeScript · Zod schemas · Vitest · Playwright-core (read-only market/browser helpers) · JSONL audit logs

## Author

[Samuel Meidinger](https://github.com/SamMeidinger04) — Calgary, AB · Cybersecurity (SAIT BTech)

## License

MIT
