import { z } from "zod";

export const MarketTypeSchema = z.enum(["pumpfun", "polymarket"]);
export type MarketType = z.infer<typeof MarketTypeSchema>;

export const ExitPlanSchema = z.object({
  takeProfitPct: z.number().positive().optional(),
  stopLossPct: z.number().positive().optional(),
  invalidationPrice: z.number().positive().optional(),
  timeStopHours: z.number().positive().optional(),
  customExit: z.string().min(1).optional(),
  rationale: z.string().min(3),
});
export type ExitPlan = z.infer<typeof ExitPlanSchema>;

export const TradeFlagsSchema = z.object({
  washTrading: z.boolean().optional(),
  fakeVolume: z.boolean().optional(),
  spoofing: z.boolean().optional(),
  manipulation: z.boolean().optional(),
});
export type TradeFlags = z.infer<typeof TradeFlagsSchema>;

export const HoldingTimingSchema = z.object({
  entryTimestamp: z.string().datetime(),
  expectedExitTimestamp: z.string().datetime(),
  maximumExitTimestamp: z.string().datetime(),
  expectedHoldingHours: z.number().nonnegative(),
  maximumHoldingHours: z.number().positive(),
  reasonMaterializesWithin48h: z.string().min(3),
});
export type HoldingTiming = z.infer<typeof HoldingTimingSchema>;

/**
 * Full-autonomy decision record — strategy must document capital allocation choice.
 * Risk engine does NOT judge whether size % is "wise".
 */
export const AutonomyDecisionSchema = z.object({
  currentTotalEquityUsd: z.number().nonnegative(),
  amountRiskedUsd: z.number().positive(),
  percentOfEquityRisked: z.number().positive(),
  maximumPossibleLossUsd: z.number().nonnegative(),
  expectedReturnUsd: z.number(),
  estimatedProbabilityOfSuccess: z.number().min(0).max(1),
  expectedValueUsd: z.number(),
  reasonForPositionSize: z.string().min(3),
  alternativesConsidered: z.array(z.string().min(1)).min(1),
  evidenceSupporting: z.array(z.string().min(1)).min(1),
  evidenceAgainst: z.array(z.string().min(1)).min(1),
  exitConditions: z.string().min(3),
  forcedExitTime: z.string().datetime(),
});
export type AutonomyDecision = z.infer<typeof AutonomyDecisionSchema>;

export const TradeProposalSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  market: MarketTypeSchema,
  strategy: z.string().min(1),
  side: z.enum(["buy", "sell", "yes", "no"]),
  instrument: z.string().min(1),
  instrumentName: z.string().optional(),
  sizeUsd: z.number().positive(),
  entryPrice: z.number().nonnegative().optional(),

  thesis: z.string().min(3),
  evidenceFor: z.array(z.string().min(1)).min(1),
  evidenceAgainst: z.array(z.string().min(1)).min(1),
  estimatedEdge: z.string().min(1),
  score: z.number().min(0).max(100),

  exitPlan: ExitPlanSchema,
  timing: HoldingTimingSchema,
  decision: AutonomyDecisionSchema,

  resolutionDeadline: z.string().datetime().optional(),
  officialResolutionSource: z.string().min(1).optional(),

  leverage: z.number().optional(),
  borrowedFunds: z.boolean().optional(),
  flags: TradeFlagsSchema.optional(),
  researchRef: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type TradeProposal = z.infer<typeof TradeProposalSchema>;

export const SimulatedFillSchema = z.object({
  proposalId: z.string(),
  fillId: z.string(),
  filledAt: z.string().datetime(),
  fillPrice: z.number().nonnegative(),
  sizeUsd: z.number().positive(),
  feesUsd: z.number().nonnegative(),
  simulated: z.literal(true),
  notes: z.string().optional(),
});
export type SimulatedFill = z.infer<typeof SimulatedFillSchema>;
