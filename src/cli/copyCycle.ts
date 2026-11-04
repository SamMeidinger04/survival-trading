#!/usr/bin/env npx tsx
/**
 * CLI: npm run copy-cycle
 * Paper smart-wallet copy-trade cycle. $0 real money.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCopyCycle } from "../copytrade/cycle.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function main() {
  console.log("=== PAPER COPY-TRADE CYCLE (no real money) ===");
  console.log(`root: ${root}`);
  const { artifact, paths } = await runCopyCycle(root);
  console.log(artifact.summary);
  console.log(`wallets: ${artifact.walletsTracked.length}`);
  console.log(`new copies: ${artifact.newCopiesOpened}`);
  console.log(`equity: $${artifact.equityUsd.toFixed(2)}`);
  console.log(`artifact: ${paths.latest}`);
  console.log(`book: ${paths.book}`);
  console.log(`status: ${paths.statusMd}`);
  if (artifact.blockers.length) {
    console.log("blockers:");
    for (const b of artifact.blockers.slice(0, 10)) console.log(`  - ${b}`);
  }
}

main().catch((err) => {
  console.error("copy-cycle failed:", err);
  process.exitCode = 1;
});
