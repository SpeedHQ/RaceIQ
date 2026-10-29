import { z } from "zod";
import type { GameId } from "@raceiq/shared/games/ids";
import type { EncodedAlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/types";
import { GameIdSchema } from "@raceiq/shared/games/ids";

export const CoachingFamilySchema = z.enum(["brake-drag", "downshift", "throttle", "steering", "front-scrub"]);
export type CoachingFamily = z.infer<typeof CoachingFamilySchema>;

const PositiveSafeIntegerSchema = z.number().int().positive().safe();
const RepresentativeSchema = z.object({
  lapId: PositiveSafeIntegerSchema,
  lapNumber: PositiveSafeIntegerSchema,
  sourceFrameIndex: z.number().int().nonnegative().safe(),
});

export const ThreeToImproveResponseSchema = z.object({
  sessionId: PositiveSafeIntegerSchema,
  gameId: GameIdSchema,
  state: z.enum(["ready", "insufficient-data", "no-actionable-findings"]),
  eligibleLapCount: z.number().int().nonnegative(),
  analyzedLapCount: z.number().int().nonnegative(),
  excludedLapCount: z.number().int().nonnegative(),
  unlocatedEvidenceCount: z.number().int().nonnegative(),
  items: z.array(z.object({
    id: z.string(),
    family: CoachingFamilySchema,
    evidenceLevel: z.enum(["single-lap", "repeated"]),
    supportingLapCount: PositiveSafeIntegerSchema,
    evidencePointCount: PositiveSafeIntegerSchema,
    location: z.object({ fraction: z.number().min(0).max(1), cornerName: z.string().nullable() }),
    representative: RepresentativeSchema,
  })).max(3),
}).superRefine((value, ctx) => {
  if (value.state === "ready" && value.items.length === 0) ctx.addIssue({ code: "custom", message: "Ready response requires at least one item", path: ["items"] });
});
export type ThreeToImproveResponse = z.infer<typeof ThreeToImproveResponseSchema>;

export const ThreeToImproveEvidenceQuerySchema = z.object({
  lapId: z.coerce.number().int().positive().safe(),
  sourceFrameIndex: z.coerce.number().int().nonnegative().safe(),
});

export type ThreeToImproveEvidenceResponse = {
  sessionId: number;
  gameId: GameId;
  representative: ThreeToImproveResponse["items"][number]["representative"];
  fraction: number;
  aligned: EncodedAlignedLapSet;
};
