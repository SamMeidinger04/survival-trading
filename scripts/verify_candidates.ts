/**
 * Read-only on-chain verification of candidate copy wallets (paper only).
 * For each address: count ok signatures in last 6h, newest age, and decode up
 * to N recent txs to confirm real token swap activity (buy/sell deltas).
 * Usage: npx tsx scripts/verify_candidates.ts label:ADDRESS [label:ADDRESS ...]
 */
import { SolanaRpc, sleep } from "../src/copytrade/rpc.js";
import { DEFAULT_RPC } from "../src/copytrade/config.js";
import { getSolUsd } from "../src/copytrade/prices.js";
import { extractBuysFromTx, extractSellsFromTx } from "../src/copytrade/walletActivity.js";

async function main() {
  const rpc = new SolanaRpc(process.env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC);
  const solUsd = (await getSolUsd()).priceUsd;
  const now = Date.now() / 1000;
  const decodeN = Number(process.env.DECODE_N ?? 6);
  for (const arg of process.argv.slice(2)) {
    const [label, address] = arg.split(":");
    try {
      await sleep(700);
      const sigs = await rpc.getSignaturesForAddress(address!, 40);
      const ok = sigs.filter((s) => !s.err);
      const ok6 = ok.filter((s) => s.blockTime && now - s.blockTime <= 6 * 3600).length;
      const newest = ok.reduce((m, s) => Math.max(m, s.blockTime ?? 0), 0);
      let buys = 0, sells = 0;
      const mints = new Set<string>();
      let exampleSig = "";
      for (const s of ok.slice(0, decodeN)) {
        await sleep(450);
        const tx = await rpc.getTransaction(s.signature);
        if (!tx) continue;
        const w = { address: address!, label: label!, justification: "", source: "manual" as const, provisional: true };
        const b = extractBuysFromTx(w, s.signature, tx, solUsd);
        const se = extractSellsFromTx(w, s.signature, tx, solUsd);
        buys += b.length; sells += se.length;
        for (const e of [...b, ...se]) { mints.add(e.mint); if (!exampleSig) exampleSig = s.signature; }
      }
      console.log(JSON.stringify({ label, address, ok40: ok.length, ok6h: ok6,
        newestMinAgo: newest ? Math.round((now - newest) / 60) : null,
        decoded: Math.min(decodeN, ok.length), buys, sells, distinctMints: mints.size, exampleSig }));
    } catch (e) {
      console.log(JSON.stringify({ label, address, error: String(e) }));
    }
  }
}
main();
