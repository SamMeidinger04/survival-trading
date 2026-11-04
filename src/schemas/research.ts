import { z } from "zod";
import { MarketTypeSchema } from "./trade.js";

export const ResearchNoteSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  market: MarketTypeSchema,
  instrument: z.string(),
  instrumentName: z.string().optional(),
  summary: z.string(),
  signals: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  score: z.number().min(0).max(100),
  raw: z.record(z.unknown()).optional(),
});
export type ResearchNote = z.infer<typeof ResearchNoteSchema>;
