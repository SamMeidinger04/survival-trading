import { SolanaRpc } from "../src/copytrade/rpc.js";
import { DEFAULT_RPC, TRACKED_WALLETS } from "../src/copytrade/config.js";

async function main() {
  const url = process.env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC;
  console.log("rpc", url);
  const rpc = new SolanaRpc(url);
  const now = Date.now() / 1000;
  for (const w of TRACKED_WALLETS) {
    try {
      await new Promise((r) => setTimeout(r, 800));
      const arr = await rpc.getSignaturesForAddress(w.address, 20);
      let ok6 = 0;
      let newest: number | null = null;
      for (const s of arr) {
        if (s.err) continue;
        if (s.blockTime && (!newest || s.blockTime > newest)) newest = s.blockTime;
        if (s.blockTime && now - s.blockTime <= 6 * 3600) ok6++;
      }
      const ago = newest ? ((now - newest) / 60).toFixed(0) + "m" : "n/a";
      console.log(`${w.label}: ok6h=${ok6} newest~${ago} n=${arr.length}`);
    } catch (e) {
      console.log(`${w.label}: ERR ${e}`);
    }
  }
}
main();
