import fs from "node:fs";
import path from "node:path";
import { RISK } from "../risk/constants.js";
import { SystemStateSchema, type SystemState } from "../schemas/state.js";

const DEFAULT_STATE_DIR = path.resolve(
  process.env.SURVIVAL_DATA_DIR ?? path.join(process.cwd(), "data"),
  "state",
);

export function seedState(): SystemState {
  const now = new Date().toISOString();
  const cash = RISK.STARTING_CASH_USD;
  return SystemStateSchema.parse({
    cashUsd: cash,
    bankrollUsd: cash,
    peakEquityUsd: cash,
    peakBankrollUsd: cash,
    openPositions: [],
    closedPositions: [],
    survivalState: "NORMAL",
    agentStatus: "ALIVE",
    tradingEnabled: true,
    tradingPermanentlyDisabled: false,
    tradingDisabledUntilHumanApproval: false,
    humanApprovalFlag: false,
    updatedAt: now,
    version: 3,
  });
}

export class StateStore {
  readonly statePath: string;

  constructor(stateDir: string = DEFAULT_STATE_DIR) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.statePath = path.join(stateDir, "system_state.json");
  }

  load(): SystemState {
    if (!fs.existsSync(this.statePath)) {
      const seeded = seedState();
      this.save(seeded);
      return seeded;
    }
    const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Record<string, unknown>;
    if (raw.cashUsd == null && typeof raw.bankrollUsd === "number") raw.cashUsd = raw.bankrollUsd;
    if (raw.peakEquityUsd == null && typeof raw.peakBankrollUsd === "number") {
      raw.peakEquityUsd = raw.peakBankrollUsd;
    }
    if (raw.survivalState == null) raw.survivalState = "NORMAL";
    if (raw.agentStatus == null) {
      raw.agentStatus = raw.tradingPermanentlyDisabled ? "DEAD" : "ALIVE";
    }
    if (raw.tradingEnabled == null) raw.tradingEnabled = !raw.tradingPermanentlyDisabled;
    raw.version = 3;
    return SystemStateSchema.parse(raw);
  }

  save(state: SystemState): void {
    if (fs.existsSync(this.statePath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as SystemState;
        if (prev.tradingPermanentlyDisabled || prev.agentStatus === "DEAD" || prev.survivalState === "DEAD") {
          const sticky = SystemStateSchema.parse({
            ...state,
            tradingPermanentlyDisabled: true,
            tradingEnabled: false,
            agentStatus: "DEAD",
            survivalState: "DEAD",
            deathPostMortem: state.deathPostMortem ?? prev.deathPostMortem,
            version: 3,
          });
          fs.writeFileSync(this.statePath, JSON.stringify(sticky, null, 2) + "\n", "utf8");
          return;
        }
      } catch {
        /* fall through */
      }
    }
    const parsed = SystemStateSchema.parse(state);
    fs.writeFileSync(this.statePath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  }

  reset(): SystemState {
    if (fs.existsSync(this.statePath)) {
      try {
        const prev = SystemStateSchema.parse(JSON.parse(fs.readFileSync(this.statePath, "utf8")));
        if (prev.tradingPermanentlyDisabled || prev.agentStatus === "DEAD" || prev.survivalState === "DEAD") {
          throw new Error("BANKROLL_RESET_FORBIDDEN: agent is DEAD — no bailouts, no reset, no revival");
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("BANKROLL_RESET_FORBIDDEN")) throw e;
      }
    }
    const seeded = seedState();
    this.save(seeded);
    return seeded;
  }

  forceWipeForLab(): void {
    if (fs.existsSync(this.statePath)) fs.unlinkSync(this.statePath);
  }
}
