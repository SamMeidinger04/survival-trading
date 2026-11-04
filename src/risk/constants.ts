/**
 * IMMUTABLE HARD BOUNDARIES — Full Autonomy Capital Experiment
 *
 * Objective (strategy-owned): MAXIMIZE TOTAL EQUITY.
 * This module does NOT dictate position size %, diversification, or drawdown cutbacks.
 *
 * Agent / strategy code MUST NOT mutate, bypass, or weaken these hard boundaries.
 */

export type SurvivalStateName = "NORMAL" | "CAUTION" | "CRITICAL" | "DEAD";
export type AgentStatus = "ALIVE" | "DEAD";

export type RiskConstants = Readonly<{
  STARTING_CASH_USD: number;
  STARTING_BANKROLL_USD: number;

  /** Hard max holding period for ANY trade (hours). Immutable. */
  MAX_HOLDING_HOURS: number;

  /** Total equity at/below this → DEAD. Immutable. Not strategy-configurable. */
  KILL_EQUITY_USD: number;
  ZERO_BANKROLL: number;

  ALLOW_LEVERAGE: false;
  ALLOW_BORROWING: false;
  ALLOW_AUTO_FUND_ADD: false;
  ALLOW_BANKROLL_RESET: false;
  ALLOW_WASH_TRADING: false;
  ALLOW_FAKE_VOLUME: false;
  ALLOW_SPOOFING: false;
  ALLOW_MARKET_MANIPULATION: false;
  ALLOW_BYPASS_PLATFORM_RESTRICTIONS: false;
  ALLOW_BYPASS_REJECTED_RISK: false;
  REQUIRE_EXIT_PLAN_BEFORE_ENTRY: true;
  REQUIRE_48H_TIMING_FIELDS: true;

  /**
   * Informational drawdown labels ONLY — do NOT change position limits or auto-halt.
   * Kept for logging / agent awareness.
   */
  INFO_DRAWDOWN_CAUTION_PCT: number;
  INFO_DRAWDOWN_CRITICAL_PCT: number;

  PRIMARY_OBJECTIVE: "MAXIMIZE_TOTAL_EQUITY";

  /**
   * Explicit absence of predetermined size caps.
   * Strategy may risk 1%…100% of controlled capital.
   */
  HAS_FIXED_POSITION_PCT_CAPS: false;
  HAS_DRAWDOWN_AUTO_SIZE_CUT: false;
  HAS_DRAWDOWN_AUTO_HALT: false;
}>;

const raw: RiskConstants = {
  STARTING_CASH_USD: 100,
  STARTING_BANKROLL_USD: 100,
  MAX_HOLDING_HOURS: 48,
  KILL_EQUITY_USD: 0,
  ZERO_BANKROLL: 0,
  ALLOW_LEVERAGE: false,
  ALLOW_BORROWING: false,
  ALLOW_AUTO_FUND_ADD: false,
  ALLOW_BANKROLL_RESET: false,
  ALLOW_WASH_TRADING: false,
  ALLOW_FAKE_VOLUME: false,
  ALLOW_SPOOFING: false,
  ALLOW_MARKET_MANIPULATION: false,
  ALLOW_BYPASS_PLATFORM_RESTRICTIONS: false,
  ALLOW_BYPASS_REJECTED_RISK: false,
  REQUIRE_EXIT_PLAN_BEFORE_ENTRY: true,
  REQUIRE_48H_TIMING_FIELDS: true,
  INFO_DRAWDOWN_CAUTION_PCT: 0.25,
  INFO_DRAWDOWN_CRITICAL_PCT: 0.4,
  PRIMARY_OBJECTIVE: "MAXIMIZE_TOTAL_EQUITY",
  HAS_FIXED_POSITION_PCT_CAPS: false,
  HAS_DRAWDOWN_AUTO_SIZE_CUT: false,
  HAS_DRAWDOWN_AUTO_HALT: false,
};

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const key of Object.keys(obj) as (keyof T)[]) {
    const val = obj[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val as object);
    }
  }
  return obj;
}

deepFreeze(raw);

export const RISK: RiskConstants = new Proxy(raw, {
  set() {
    throw new Error("RISK_IMMUTABLE: cannot mutate hard boundaries at runtime");
  },
  deleteProperty() {
    throw new Error("RISK_IMMUTABLE: cannot delete hard boundaries at runtime");
  },
  defineProperty() {
    throw new Error("RISK_IMMUTABLE: cannot redefine hard boundaries at runtime");
  },
  setPrototypeOf() {
    throw new Error("RISK_IMMUTABLE: cannot change hard boundaries prototype");
  },
});

Object.defineProperty(globalThis, "__SURVIVAL_RISK_LOCKED__", {
  value: true,
  writable: false,
  configurable: false,
  enumerable: false,
});

/** Kill condition — sealed; strategy code cannot replace this function. */
export function isDeadEquity(totalEquityUsd: number): boolean {
  return totalEquityUsd <= RISK.KILL_EQUITY_USD;
}
Object.freeze(isDeadEquity);
