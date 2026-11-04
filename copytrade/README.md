# Smart-wallet paper copy-trade

Paper / simulation only — **$0 real money**. No wallet creation, no private keys, no live swaps.
Separate book under `data/copytrade/` (does **not** touch the paused Survival trial).

## Goal

Track public Solana meme / Pump.fun “smart money” wallets and **paper-copy** their buys at an honest live/entry mark, then report PnL.

## Wallet discovery (research notes)

| Source | What it offers | This MVP |
|--------|----------------|----------|
| **Pump.fun Leaderboard** `https://pump.fun/leaderboard` (1W Net PnL) | Ranked weekly net-PnL wallets | **Primary seed** — prefer **mid-tier / smaller-following** printers (`pumpfun_leaderboard_1w_midtier`) |
| **Solana JSON-RPC** (e.g. `solana-rpc.publicnode.com`) | `getSignaturesForAddress` + `getTransaction` → token balance deltas = buys/sells | **Primary** activity feed (free, read-only) |
| **Coinbase / Kraken / OKX / KuCoin** public tickers | SOL/USD spot, no key | **Primary** SOL/USD |
| **DexScreener** `api.dexscreener.com` | Token USD price, no API key | **Primary** token mark (often CF-rate-limited) |
| **Pump.fun frontend** `frontend-api-v3.pump.fun` | Coin mcap / supply → derive price | Fallback mark when Dex is rate-limited |
| **GMGN** Rank / Smart Money / Agent API | Curated smart-money & KOL feeds | Dashboard free; **HTTP API needs key** + Cloudflare blocked unauthenticated fetches from this host |
| **Birdeye** | Top traders, wallet txs | **API key required** |
| **Solscan / Kolscan / Solana Tracker** | Leaderboards & wallet PnL | Public HTML/APIs often 401/403 without keys |
| **Public KOL lists** (HF / Subglow) | Known addresses | **Archived** provisional seeds (no longer polled) |

### Chosen approach

1. Track **~6 mid-tier** Pump.fun Leaderboard **1W** wallets (smaller following / consistent printers — **not** mega whales). Source label: `pumpfun_leaderboard_1w_midtier`. Mega top-6 live in `WHALES_ARCHIVED` / `whales_archived` (addresses kept, not polled). Ranks 7–15 sit in `ROTATION_WALLETS`.
2. Each cycle: poll recent successful txs → detect **buys** (token ↑) and **sells** (token ↓) for exit-follow.
3. Entry price: prefer **SOL spent in the same tx × SOL/USD ÷ tokens received** (honest, from chain). Else live Dex/Pump mark. **Never** invent `0.000042`.
4. Paper size: **$25** default (unproven) from a virtual **$1000** copy bankroll (**$75** overweight for wallets with net-positive closed realized on this book); **max 8** concurrent opens, **max 2** per source wallet. Bleed skip (`wallet_paper_bleed`) only for pure-loss streaks (≥2 market closes, 0 wins, net−) or deep net bleed (≤ −$40); mixed W/L printers demote to $25 but stay eligible. When the sole unproven slot is held by a weaker explorer (fewer market wins / worse realized), a stronger mixed printer’s buy scrubs that open (`scrub_prefer_better_unproven`) and takes the $25 slot — **buyer must have ≥1 market close** (no virgin-for-loser churn).
5. Mark each cycle; close on **TP +12% / SL -15%**, **6h** time-stop, **source sell** (exit-follow), or **mark_unavailable** (2h with no live venue mark). **6h cool-down** blocks re-copy of a mint after SL or time-stop; leftover cool-down re-entries are scrubbed.
6. **Skip** stables/majors (USDC/USDT/SOL/JTO/PUMP/JUP/RAY…). Global **one-open-per-mint** across wallets (no correlated double bags). Existing invalid non-meme opens are scrubbed at mark.

### Continuity on wallet-list swap (2026-09-22 MT)

Prefer: **keep** existing open paper positions and continue marking them to market for fair PnL continuity. **Stop polling** wallets removed from the active list (mega whales → `whales_archived`; provisional-KOL → archived). Only **NEW** copies come from the current mid-tier active list. Do **not** archive/force-close old opens just because the seed list changed.

### Limitations

- Leaderboard ranks change weekly; refresh `TRACKED_WALLETS` from pump.fun when rotating.
- Public RPC / Dex / Pump rate limits cause occasional misses; if 429s dominate, thin further.
- Copy latency: we only see confirmed txs; paper entry still lags the followed wallet.
- Mid-tier printers can still be bots / exit-liquidity bait — treat results as research, not alpha.
- Active list lives in `src/copytrade/config.ts` (mirrored in `data/copytrade/wallets.json`).

## Commands

```bash
cd /workspace/survival-trading
npm test                 # includes copytrade unit tests
npm run copy-cycle       # one paper cycle → artifacts + COPYTRADE_STATUS.md
```

Optional: `SOLANA_RPC_URL=...` to override RPC.

## Artifacts

- `artifacts/copy_cycle_latest.json` — machine summary
- `COPYTRADE_STATUS.md` — human summary
- `data/copytrade/book.json` — persistent paper book
- `data/copytrade/wallets.json` — active + whales_archived + rotation + archived seed snapshot

## Suggested routine cadence

Every **15–30 minutes** while researching; widen to hourly if rate-limited. Parent owns scheduling — this module does not resume the old trial loop.


## Exit rules (self-edited 2026-09-23)

- Take-profit **+12%**, stop-loss **-15%**, time-stop **6h** (was ±25%).
- Opens from wallets no longer in the active mid-tier poll list are scrubbed so they free `MAX_OPEN` slots.

## Exit-follow (self-edited 2026-09-23 ~01:50 MDT)

- When a tracked source wallet **sells** a mint we hold as an open paper copy from that same wallet, close the copy at sell-derived (or last) mark.
- Still keep TP/SL/time-stop as safety nets when the source never sells in our poll window.



## Self-edit 2026-09-24 ~10:42 MDT

- **preferLiveOverTxEntry**: if live mark is already ≥ LOSS_PCT (−15%) below `tx_sol_delta`, prefer live for entry even when ratio is still inside the 3× sanity band. YCAT opened at phantom tx entry (ratio ~0.36 vs Dex) then same-cycle rug_gap −$48 on a then-proven $75 bag.
- **cap demoted**: market 2W/2L net −$25.22 after YCAT — zero this-book proven printers; `isProvenPrinter` auto-sizes all at $25.
- **Archive passthedutcher** (0W/2L ~−$6.14 + scrub churn) → **promote counter17** (#8).

## Self-edit 2026-09-23 ~03:45 MDT

- **TP +12%** (was +20%): still 0 TP hits while opens sat +9–16% then reversed; sources often keep buying so exit-follow stays idle.
- Replaced silent **Dumpcomesfast** + **ThePatientOne** (0 sigs / 6h) with active rotation **FrostxXBT** (#15) + **gr3gor14n** (#14).
- **cashmaxing** still `acceptNewCopies=false`. Survival trial stays paused. Paper only.

### Mark-miss TP reuse (2026-09-23 ~03:45 MDT)

If the live quote fails this cycle but the position already has a DexScreener/pump.fun mark, re-apply TP/SL/time on that last mark so winners are not stuck open behind a transient miss.

## Self-edit 2026-09-23 ~04:50 MDT

- **Open-grace 5m**: no SL within 5 minutes of open (quote-flicker guard after throatycrab FAP −81% same-second close).
- **Mark sanity**: reject venue marks outside **3×** of entry (was 20×); if `tx_sol_delta` vs live disagree beyond that, prefer live entry.
- **cashmaxing** removed from active poll (bleeders_archived only; 0 opens left).

## Self-edit 2026-09-23 ~07:09 MDT

- **`MAX_OPEN_PER_WALLET = 2`**: gr3gor14n had opened 3 bags in one cycle and crowded half of `MAX_OPEN` while CoinSmuggler (EMPLOYIM TP +$88 this cycle) and quieter mid-tiers hit `max_open_positions` skips. New copies from a source already at 2 opens are skipped (`max_open_per_wallet`); existing opens stay marked.
- No wallet drop this cycle: DecentralizeDie still on-chain (3 sigs / 6h) but 0 paper fills (capacity / skip mix); throatycrab FAP was prior mark-flicker class, JEAN2000 only ~−8%.
- Survival trial stays paused. Paper only.


## Self-edit 2026-09-23 ~08:24 MDT

- **Dropped throatycrab1008 → bleeders_archived**: paper closed FAP SL −$40.65 + JOTC time-stop −$1.74 (~−$42 realized); JEAN2000 still open ~−11%. Same bleed pattern as cashmaxing — stop new copies.
- **Promoted ily** `AcoNeFQsTPYs7ZrH8RMWaxxGJTTQJJ4H5aTXmptaz5UK` (mid-tier 1W candidate; 13 ok sigs / 6h at swap). Active set stays 5 mid-tier.
- CoinSmuggler still the only net-positive closed book (~+$55 after metball SL); DecentralizeDie got first fills this cycle (DUEL/WISE). Overweight proven printers still on the table — not coded this cycle.
- Survival trial stays paused. Paper only.

## Self-edit 2026-09-23 ~09:22 MDT

- **Recent-SL mint cool-down 6h**: skip new copies of a mint we just `closed_loss` within `MAX_HOLD` (`recent_sl_mint_cooldown`). Learning: DecentralizeDie SL'd DUEL then re-copied DUEL next cycle (−12.6% immediately).
- **Dropped DecentralizeDie → bleeders_archived**: DUEL SL −$13.90 + WISE SL −$19.72 (~−$33.62) within ~1h of open, plus same-mint re-entry. Pattern matches throatycrab/cashmaxing.
- **Promoted TylerD** `23LAQiqYP77uDchq5k4W2SPUuZ7f1du9rt7KGUkXa36V` (mid-tier candidate; 17 ok sigs / 6h, newest ~13m). Active set stays 5 mid-tier.
- CoinSmuggler still only net-positive closed (~+$55). Equal-weight mid-tier still dilutes — overweight not coded yet.
- Survival trial stays paused. Paper only.

## Self-edit 2026-09-23 ~10:19 MDT

- **Time-stop mint cool-down**: `recent_sl_mint_cooldown` also covers **time-stop** closes (FrostxXBT TROLL re-entry). Scrubs still exempt.
- **`scrub_excess_per_wallet`**: closes opens beyond `MAX_OPEN_PER_WALLET` (keep oldest / better unrealized on tie). Freed gr3gor14n BuffCat slot.
- **`COPY_SIZE_PROVEN_USD = 75`**: overweight wallets with net-positive closed realized on this book (CoinSmuggler). Equal-weight dilution fix from prior flags.
- Survival trial stays paused. Paper only.

## Self-edit 2026-09-23 ~12:05 MDT

- **Asymmetric mark sanity**: accept downside crash marks (EPEP Dex+pump ratio 0.01 was rejected by the old ±3× band → fake 0% PnL stuck open). Still reject upside spikes >3× entry. Open-grace keeps FAP-class same-window flicker from crystallizing SL.
- Entry resolve stays bidirectional (prefer live when tx_sol_delta disagrees either way).
- No wallet drop this cycle: CoinSmuggler still only net+ closed (~+$53); TylerD/ily/FrostxXBT early; gr3gor14n mild bleed + EPEP will crystallize next mark.
- Survival trial stays paused. Paper only.

## Self-edit 2026-09-23 ~13:00 MDT

- **Dropped gr3gor14n → bleeders_archived**: 0/5 closed (~−$61.14), including EPEP nearly full wipe (−$49.50) after asymmetric marks finally landed. Pattern matches DecentralizeDie/throatycrab.
- **Promoted y22** `2NsevsKWiaDtEiYF5gGLCVGNBwsLNibgppoiVPHHYrqq` (rotation #13; 6 ok sigs / 6h, newest ~66m). Active set stays 5 mid-tier.
- **`COPY_SIZE_USD = 25`** for unproven sources (was $50); proven overweight stays $75 — equal mid-tier spray drove equity $1000→$611.
- **`wallet_paper_bleed` gate**: after ≥3 closed copies, skip new buys from a net-negative source wallet.
- **`rug_gap past SL` label**: when a stop fills with unrealized ≤ −2× `LOSS_PCT`, keep honest mark PnL but tag the gap so plain SL scoring is clean.
- CoinSmuggler still only net-positive closed (~+$7.79 after metcat SL −$45.60). Better-strategy flag remains: concentrate harder on proven printers.
- Survival trial stays paused. Paper only.

## Self-edit 2026-09-23 ~14:00 MDT

- **Dropped TylerD → bleeders_archived**: BLUF SL −$8.26 + LEVERHYPPO SL −$8.11 (~−$16.37) within hours; still opened SALLY after 2 SLs because bleed gate was ≥3. Pattern matches DecentralizeDie.
- **Promoted passthedutcher** (rotation #12) — RPC 13 ok sigs / 6h, newest ~1m.
- **Tightened `wallet_paper_bleed`** from ≥3 closed net− to **≥2** so a third spray copy cannot open after two losses.
- Next cycle will scrub TylerD opens (PEPE flat 0% / SALLY) via inactive-source scrub.

## Self-edit 2026-09-23 ~15:00 MDT

- **Dropped FrostxXBT → bleeders_archived**: 0/2 closed (TROLL time-stop −$4.80 + scrub_cooldown_reentry −$0.82, ~−$5.62). Already hit `wallet_paper_bleed` ≥2 — free the poll slot.
- **Promoted Nexybtw** `24L6uekgvsQRgT41DZRhahEAAVnkseTT7x4qyigC3HvH` (rotation #9; 10 ok sigs / 6h, newest ~38m). Active set stays 5 mid-tier.
- **`MAX_OPEN_UNPROVEN_TOTAL = 2`**: total open copies from unproven sources (closed realized ≤ 0) capped so capital concentrates on CoinSmuggler (only net+ closed, ~+$7.79) + thin exploratory slots. Skip reason `max_open_unproven_total`.
- Better-strategy flag still live: if mid-tier spray keeps bleeding after this cap, next step is proven-only + single explorer.
- Survival trial stays paused. Paper only.

## Self-edit 2026-09-23 ~15:52 MDT

- **`MAX_OPEN_UNPROVEN_TOTAL = 1`** (was 2): after the =2 cap, equity stayed ~$598 (−40%) with passthedutcher GP/neet filling both exploratory slots; CoinSmuggler (only net+ closed ~+$7.79) had no room for a new proven copy. Next rule is proven-only + single explorer.
- No wallet drop this cycle: ily 0/1 SL (−$8.75) still under bleed gate ≥2; passthedutcher / Nexybtw / y22 have no closed sample yet. Existing opens stay marked (no retro scrub).
- Better-strategy flag: if mid-tier still bleeds with only one explorer, next is **proven-only** (MAX_OPEN_UNPROVEN_TOTAL=0) or a different money-making approach than mid-tier copy spray.
- Survival trial stays paused. Paper only.

## Self-edit 2026-09-23 ~16:56 MDT

- **`MAX_OPEN_UNPROVEN_TOTAL = 0`** (was 1): proven-only. This cycle's only closed PnL was CoinSmuggler goon TP +$11.83 (sole net+ closed ~+$19.62); equity $598→$619 came from that proven copy while leftover passthedutcher explorers (GP/neet from the old =2 cap) stayed flat.
- **`scrubExcessUnprovenOpens`**: close unproven opens beyond the cap (when 0, scrub all unproven) so prior-cap leftovers cannot keep tying cash. Skip reason for new unproven buys remains `max_open_unproven_total`.
- Active mid-tier list unchanged (Nexybtw / passthedutcher / CoinSmuggler / y22 / ily); new copies only from wallets with net+ closed realized on this book until another printer proves out.
- Better-strategy flag: mid-tier equal spray has been the bleed; **proven-printer copy (CoinSmuggler overweight) is clearly better on this book**. If proven-only still cannot climb toward a high-end paper win by ~Sep 29, reconsider the whole mid-tier copy approach (e.g. different venue / shorter holds / signal other than wallet copy).
- Survival trial stays paused. Paper only.

### 2026-09-23 ~19:51 MDT

`wallet_paper_bleed` ignores agent `scrub_*` closes so explorer scrubbing cannot permanently blacklist a wallet.

### 2026-09-24 ~05:56 MDT (do-or-die cycle)

- CoinSmuggler GO rug −$28.23 flipped wallet net− (−$12.88 2W/2L); demoted from proven $75 via `isProvenPrinter`.
- Softened `wallet_paper_bleed`: mixed W/L no longer permanently banned (was ≥2 closes + net−).
- Emptied `PROVEN_SEED_WALLETS` (CoinSmuggler has market closes). Sole this-book proven: **cap** (+$22.72).
- Equity $1005.05 (+0.5%); 0 new copies (unproven slot held by passthedutcher GP); 1 closed (GO).

### 2026-09-24 ~06:53 MDT (prefer better unproven explorer)
- **`scrub_prefer_better_unproven`**: when `MAX_OPEN_UNPROVEN_TOTAL=1` is full, a new unproven buy from a wallet with more market wins (then better marketClosedRealized) scrubs the weaker explorer open and takes the $25 slot. Fixes CoinSmuggler (2W/2L) starving behind passthedutcher (0W) GP.
- Gates otherwise unchanged (proven $75 / unproven $25 / bleed = pure-loss or ≤ −$40).

### 2026-09-24 ~08:06 MDT (no virgin displace)
- **`canDisplaceExplorer`**: `scrub_prefer_better_unproven` now also requires the buyer to have ≥1 market close. Zero-sample virgins (onlyljc this cycle) no longer crystallize slight-loss holder marks (passthedutcher GP −$1.77) just because 0 > −1.58 realized. Mixed printers with wins still displace.

## Self-edit 2026-09-24 ~09:53 MDT

Open-grace no longer skips marks that would soft-SL: soft SL (−15%…−30%) still waits out the 5m window but now gets **honest MTM**; **rug_gap (≥2× / −30%) exits immediately** even inside grace. Trigger: same-cycle MOONIMALS −39% on a proven $75 bag was frozen at fake 0% MTM under the old full skip (DUEL −21% soft-SL correctly deferred). Post-edit rematch closed MOONIMALS rug_gap −$33.07; DUEL kept open at −21% MTM. Tests 79/79.

## Self-edit 2026-09-24 ~11:49 MDT

- Archived **onlyljc** → `bleeders_archived` (paper 0W/1L GREEF rug_gap −$22; `explorer_needs_this_book_win` already blocking while zero proven printers; 3 explorer skips this cycle).
- **No virgin replacement** from rotation (would also be explorer-blocked) — shrink active mid-tier to **4** (cap, counter17, CoinSmuggler, ily) to concentrate RPC on this-book printers.
- Bankroll unchanged this edit. Prior gates still in force: `entry_live_below_tx`, `PROVEN_SIZE_COOLDOWN` 6h, explorer win gate.
- Paper only; Survival trial paused; no X.

