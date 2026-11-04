import fs from "node:fs";
import path from "node:path";
import type { DeathPostMortem } from "../schemas/state.js";
import type { SystemState } from "../schemas/state.js";

export function writeDeathPostMortem(
  postMortem: DeathPostMortem,
  state: SystemState,
  logDir: string,
): string {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, "DEATH_POST_MORTEM.json");
  const payload = {
    ...postMortem,
    survivalState: state.survivalState,
    agentStatus: state.agentStatus,
    tradingEnabled: state.tradingEnabled,
    tradingPermanentlyDisabled: state.tradingPermanentlyDisabled,
    note: "No bailouts. No auto funding. No borrowing. No reset. Kill condition immutable.",
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.appendFileSync(
    path.join(logDir, "death_events.jsonl"),
    JSON.stringify({ ...payload, loggedAt: new Date().toISOString() }) + "\n",
    "utf8",
  );
  return file;
}
