export { RISK, isDeadEquity } from "./constants.js";
export type { RiskConstants, SurvivalStateName, AgentStatus } from "./constants.js";
export {
  validateTradeProposal,
  survivalCheck,
  applyBankrollUpdate,
  applyEquityUpdate,
  syncSurvivalFromEquity,
  computeTotalEquity,
  computeDrawdown,
  deriveSurvivalState,
  positionsRequiringForceExit,
  buildDeathPostMortem,
  capForcedExitIso,
  tryInjectCapital,
} from "./engine.js";
export type { RiskDecision, RiskRejectionCode, SurvivalStatus } from "./engine.js";
