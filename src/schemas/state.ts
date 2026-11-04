import { z } from "zod";
import { MarketTypeSchema, ExitPlanSchema, HoldingTimingSchema, AutonomyDecisionSchema } from "./trade.js";

export const SurvivalStateSchema = z.enum(["NORMAL", "CAUTION", "CRITICAL", "DEAD"]);
export type SurvivalState = z.infer<typeof SurvivalStateSchema>;

export const AgentStatusSchema = z.enum(["ALIVE", "DEAD"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const PositionSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  market: MarketTypeSchema,
  strategy: z.string(),
  side: z.string(),
  instrument: z.string(),
  instrumentName: z.string().optional(),
  sizeUsd: z.number().positive(),
  entryPrice: z.number().nonnegative(),
  currentMarketValueUsd: z.number().nonnegative(),
  openedAt: z.string().datetime(),
  forcedExitAt: z.string().datetime(),
  maximumHoldingHours: z.number().positive(),
  timing: HoldingTimingSchema,
  decision: AutonomyDecisionSchema.optional(),
  thesis: z.string().min(3),
  evidenceFor: z.array(z.string()),
  evidenceAgainst: z.array(z.string()),
  estimatedEdge: z.string(),
  exitPlan: ExitPlanSchema,
  unrealizedPnlUsd: z.number().default(0),
  status: z.enum(["open", "closed"]),
  resolutionDeadline: z.string().datetime().optional(),
  officialResolutionSource: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type Position = z.infer<typeof PositionSchema>;

export const ClosedPositionSchema = PositionSchema.extend({
  status: z.literal("closed"),
  closedAt: z.string().datetime(),
  exitPrice: z.number().nonnegative(),
  realizedPnlUsd: z.number(),
  closeReason: z.string(),
});
export type ClosedPosition = z.infer<typeof ClosedPositionSchema>;

export const DeathPostMortemSchema = z.object({
  diedAt: z.string().datetime(),
  finalCashUsd: z.number(),
  finalEquityUsd: z.number(),
  peakEquityUsd: z.number(),
  openPositionCount: z.number(),
  closedPositionCount: z.number(),
  message: z.string(),
  cause: z.string(),
  objective: z.literal("MAXIMIZE_TOTAL_EQUITY"),
});
export type DeathPostMortem = z.infer<typeof DeathPostMortemSchema>;

export const SystemStateSchema = z.object({
  cashUsd: z.number().nonnegative(),
  bankrollUsd: z.number().nonnegative(),
  peakEquityUsd: z.number().nonnegative(),
  peakBankrollUsd: z.number().nonnegative(),
  openPositions: z.array(PositionSchema),
  closedPositions: z.array(ClosedPositionSchema).default([]),
  /** Informational only — does not auto-halt or cut sizes (except DEAD). */
  survivalState: SurvivalStateSchema.default("NORMAL"),
  agentStatus: AgentStatusSchema.default("ALIVE"),
  tradingEnabled: z.boolean().default(true),
  tradingPermanentlyDisabled: z.boolean().default(false),
  /** @deprecated unused under full autonomy — kept for schema compat */
  tradingDisabledUntilHumanApproval: z.boolean().default(false),
  humanApprovalFlag: z.boolean().default(false),
  lastLossSizeUsd: z.number().nonnegative().optional(),
  deathPostMortem: DeathPostMortemSchema.optional(),
  updatedAt: z.string().datetime(),
  version: z.literal(3).default(3),
});
export type SystemState = z.infer<typeof SystemStateSchema>;
