/**
 * Poll tracked wallets for recent token BUYs and SELLs via public Solana RPC.
 * Buy = positive non-WSOL token balance delta for the wallet owner.
 * Sell = negative non-WSOL token balance delta (exit-follow signal).
 * Entry/exit price ≈ |native SOL delta| * SOL/USD / |token delta| when SOL moves with the trade.
 */

import {
  SIGS_PER_WALLET,
  SOL_MINT,
  TX_DECODE_LIMIT,
  TRACKED_WALLETS,
} from "./config.js";
import { getSolUsd } from "./prices.js";
import {
  SolanaRpc,
  accountPubkeys,
  sleep,
  type ParsedTx,
} from "./rpc.js";
import type {
  TrackedWallet,
  WalletBuyEvent,
  WalletSellEvent,
} from "./types.js";

function tokenMap(
  rows: ParsedTx["meta"]["preTokenBalances"],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of rows ?? []) {
    if (!b.owner) continue;
    const key = `${b.owner}|${b.mint}`;
    m.set(key, Number(b.uiTokenAmount.uiAmount ?? 0));
  }
  return m;
}

export function extractBuysFromTx(
  wallet: TrackedWallet,
  signature: string,
  tx: ParsedTx,
  solUsd: number,
): WalletBuyEvent[] {
  if (tx.meta.err) return [];
  const keys = accountPubkeys(tx);
  const idx = keys.indexOf(wallet.address);
  if (idx < 0) return [];

  const solDelta =
    (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
  const pre = tokenMap(tx.meta.preTokenBalances);
  const post = tokenMap(tx.meta.postTokenBalances);
  const allKeys = new Set([...pre.keys(), ...post.keys()]);
  const events: WalletBuyEvent[] = [];

  for (const key of allKeys) {
    const [owner, mint] = key.split("|");
    if (owner !== wallet.address) continue;
    if (mint === SOL_MINT) continue;
    const delta = (post.get(key) ?? 0) - (pre.get(key) ?? 0);
    if (!(delta > 0)) continue;

    let entryPriceUsd: number | null = null;
    let solSpent: number | null = null;
    if (solDelta < 0) {
      solSpent = -solDelta;
      entryPriceUsd = (solSpent * solUsd) / delta;
      if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
        entryPriceUsd = null;
      }
    }

    events.push({
      walletAddress: wallet.address,
      walletLabel: wallet.label,
      signature,
      blockTime: tx.blockTime ?? null,
      mint,
      tokenAmount: delta,
      solSpent,
      entryPriceUsd,
      observedAt: new Date().toISOString(),
    });
  }
  return events;
}

/** Detect token sells (balance ↓) for exit-follow of open paper copies. */
export function extractSellsFromTx(
  wallet: TrackedWallet,
  signature: string,
  tx: ParsedTx,
  solUsd: number,
): WalletSellEvent[] {
  if (tx.meta.err) return [];
  const keys = accountPubkeys(tx);
  const idx = keys.indexOf(wallet.address);
  if (idx < 0) return [];

  const solDelta =
    (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
  const pre = tokenMap(tx.meta.preTokenBalances);
  const post = tokenMap(tx.meta.postTokenBalances);
  const allKeys = new Set([...pre.keys(), ...post.keys()]);
  const events: WalletSellEvent[] = [];

  for (const key of allKeys) {
    const [owner, mint] = key.split("|");
    if (owner !== wallet.address) continue;
    if (mint === SOL_MINT) continue;
    const delta = (post.get(key) ?? 0) - (pre.get(key) ?? 0);
    if (!(delta < 0)) continue;
    const sold = -delta;

    let exitPriceUsd: number | null = null;
    let solReceived: number | null = null;
    if (solDelta > 0) {
      solReceived = solDelta;
      exitPriceUsd = (solReceived * solUsd) / sold;
      if (!Number.isFinite(exitPriceUsd) || exitPriceUsd <= 0) {
        exitPriceUsd = null;
      }
    }

    events.push({
      walletAddress: wallet.address,
      walletLabel: wallet.label,
      signature,
      blockTime: tx.blockTime ?? null,
      mint,
      tokenAmount: sold,
      solReceived,
      exitPriceUsd,
      observedAt: new Date().toISOString(),
    });
  }
  return events;
}

export async function pollWalletBuys(
  rpc: SolanaRpc,
  wallets: TrackedWallet[] = TRACKED_WALLETS,
  opts: {
    sinceUnixSec: number;
    seenSignatures: Set<string>;
  },
): Promise<{
  buys: WalletBuyEvent[];
  sells: WalletSellEvent[];
  blockers: string[];
}> {
  const blockers: string[] = [];
  let solUsd: number;
  try {
    solUsd = (await getSolUsd()).priceUsd;
  } catch (e) {
    blockers.push(String(e));
    return { buys: [], sells: [], blockers };
  }

  const buys: WalletBuyEvent[] = [];
  const sells: WalletSellEvent[] = [];

  for (const wallet of wallets) {
    let sigs: Awaited<ReturnType<SolanaRpc["getSignaturesForAddress"]>>;
    try {
      sigs = await rpc.getSignaturesForAddress(wallet.address, SIGS_PER_WALLET);
    } catch (e) {
      blockers.push(`${wallet.label}: signatures failed — ${String(e)}`);
      continue;
    }

    const candidates = sigs.filter((s) => {
      if (s.err != null) return false;
      if (opts.seenSignatures.has(s.signature)) return false;
      if (s.blockTime != null && s.blockTime < opts.sinceUnixSec) return false;
      return true;
    });

    let decoded = 0;
    for (const s of candidates) {
      if (decoded >= TX_DECODE_LIMIT) break;
      await sleep(450);
      try {
        const tx = await rpc.getTransaction(s.signature);
        decoded++;
        if (!tx) continue;
        buys.push(...extractBuysFromTx(wallet, s.signature, tx, solUsd));
        sells.push(...extractSellsFromTx(wallet, s.signature, tx, solUsd));
      } catch (e) {
        blockers.push(
          `${wallet.label}: tx ${s.signature.slice(0, 12)}… — ${String(e)}`,
        );
      }
    }
    await sleep(900);
  }

  return { buys, sells, blockers };
}
