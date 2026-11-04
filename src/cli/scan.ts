#!/usr/bin/env node
import { scanPumpFun, scanPolymarket } from "../pipeline/run.js";

const market = (process.argv[2] ?? "both") as "pumpfun" | "polymarket" | "both";

async function main() {
  if (market === "pumpfun" || market === "both") {
    const r = await scanPumpFun(5);
    console.log("Pump.fun scan source:", r.source);
    console.log(
      r.research.slice(0, 3).map((x) => ({
        score: x.score,
        name: x.instrumentName,
        instrument: x.instrument.slice(0, 12) + "…",
      })),
    );
  }
  if (market === "polymarket" || market === "both") {
    const r = await scanPolymarket(5);
    console.log("Polymarket scan source:", r.source);
    console.log(
      r.research.slice(0, 3).map((x) => ({
        score: x.score,
        question: (x.instrumentName ?? "").slice(0, 80),
      })),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
