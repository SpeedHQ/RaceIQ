import { z } from "zod";
import { GameIdSchema, type GameId } from "../../games/ids";
import { StintSummarySchema } from "./strategy-schemas";
import type { StintSummary, StrategyFuelUnit } from "./strategy";

const finite = z.number();
const fourCompounds = z.tuple([z.string().nullable(), z.string().nullable(), z.string().nullable(), z.string().nullable()]);
const nonemptyTrimmed = (max: number) => z.string().trim().min(1).max(max);

export type RacePlanLength = { mode: "laps" } | { mode: "time"; durationSeconds: number; averageLapSeconds: number };

export function estimateRaceLaps(durationSeconds: number, averageLapSeconds: number): number | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 604800 ||
      !Number.isFinite(averageLapSeconds) || averageLapSeconds <= 0 || averageLapSeconds > 86400) return null;
  const laps = Math.ceil(durationSeconds / averageLapSeconds);
  return laps >= 1 && laps <= 10000 ? laps : null;
}

export const RacePlanGenerationSchema = z.object({
  fuelCapacity: finite.positive(),
  fuelReserve: finite.nonnegative(),
  energyReserveFraction: finite.min(0).lt(1),
}).strict().superRefine((settings, context) => {
  if (settings.fuelReserve >= settings.fuelCapacity) {
    context.addIssue({ code: "custom", message: "Reserve must be below capacity", path: ["fuelReserve"] });
  }
});
export type RacePlanGeneration = z.infer<typeof RacePlanGenerationSchema>;
export const RacePlanRecalculationInputSchema = z.object({ generation: RacePlanGenerationSchema }).strict();

const RacePlanLengthSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("laps") }).strict(),
  z.object({
    mode: z.literal("time"),
    durationSeconds: finite.positive().max(604800),
    averageLapSeconds: finite.positive().max(86400),
  }).strict(),
]);

export const RacePlanStintInputSchema = z.object({
  endLap: z.number().int().min(1).max(10_000),
  startFuel: finite.nonnegative().nullable(),
  compounds: fourCompounds,
  sourceSessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  sourceStintId: z.string().min(1).max(200).nullable(),
}).strict().superRefine((stint, context) => {
  if ((stint.sourceSessionId === null) !== (stint.sourceStintId === null)) {
    context.addIssue({ code: "custom", message: "Source session and stint must both be set or null", path: ["sourceStintId"] });
  }
});

export type RacePlanStintInput = {
  endLap: number;
  startFuel: number | null;
  compounds: [string | null, string | null, string | null, string | null];
  sourceSessionId: number | null;
  sourceStintId: string | null;
};

export const RacePlanInputSchema = z.object({
  name: nonemptyTrimmed(120),
  gameId: GameIdSchema,
  carId: nonemptyTrimmed(200),
  trackId: nonemptyTrimmed(200),
  pi: finite.nullable(),
  totalLaps: z.number().int().min(1).max(10_000),
  raceLength: RacePlanLengthSchema.default({ mode: "laps" }),
  fuelUnit: z.enum(["L", "tankFraction"]),
  notes: z.string().max(4_000),
  generation: RacePlanGenerationSchema.nullable().default(null),
  stints: z.array(RacePlanStintInputSchema).min(1).max(100),
}).strict().superRefine((plan, context) => {
  if (plan.raceLength.mode === "time" &&
      estimateRaceLaps(plan.raceLength.durationSeconds, plan.raceLength.averageLapSeconds) !== plan.totalLaps) {
    context.addIssue({ code: "custom", message: "Timed race laps must match duration and average lap time", path: ["totalLaps"] });
  }
  if (plan.fuelUnit === "tankFraction") {
    if (plan.generation && plan.generation.fuelCapacity > 1) {
      context.addIssue({ code: "custom", message: "Tank fraction capacity must be at most 1", path: ["generation", "fuelCapacity"] });
    }
    plan.stints.forEach((stint, index) => {
      if (stint.startFuel !== null && stint.startFuel > 1) {
        context.addIssue({ code: "custom", message: "Tank fraction must be at most 1", path: ["stints", index, "startFuel"] });
      }
    });
  }
  let previous = 0;
  plan.stints.forEach((stint, index) => {
    if (stint.endLap <= previous) context.addIssue({ code: "custom", message: "Stint end laps must increase strictly", path: ["stints", index, "endLap"] });
    previous = stint.endLap;
  });
  if (plan.stints.at(-1)?.endLap !== plan.totalLaps) {
    context.addIssue({ code: "custom", message: "Final stint must end at total laps", path: ["stints", plan.stints.length - 1, "endLap"] });
  }
});

export type RacePlanInput = {
  name: string;
  gameId: GameId;
  carId: string;
  trackId: string;
  pi: number | null;
  totalLaps: number;
  raceLength?: RacePlanLength;
  fuelUnit: StrategyFuelUnit;
  notes: string;
  generation?: RacePlanGeneration | null;
  stints: RacePlanStintInput[];
};

export const RacePlanStintSchema = RacePlanStintInputSchema.safeExtend({ evidence: StintSummarySchema.nullable() }).strict();
export type RacePlanStint = RacePlanStintInput & { evidence: StintSummary | null };

const utcIsoDate = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/).refine((value) => Number.isFinite(Date.parse(value)));
export const RacePlanSchema = RacePlanInputSchema.safeExtend({
  id: z.string().min(1),
  createdAt: utcIsoDate,
  updatedAt: utcIsoDate,
  stints: z.array(RacePlanStintSchema).min(1).max(100),
}).strict();
export type RacePlan = Omit<RacePlanInput, "stints"> & { id: string; createdAt: string; updatedAt: string; stints: RacePlanStint[] };

export const RacePlanComboSchema = z.object({
  gameId: GameIdSchema,
  carId: nonemptyTrimmed(200),
  trackId: nonemptyTrimmed(200),
}).strict();
export type RacePlanCombo = z.infer<typeof RacePlanComboSchema>;
export const SetActiveRacePlanInputSchema = RacePlanComboSchema.extend({
  planId: nonemptyTrimmed(200).nullable(),
}).strict();
export type SetActiveRacePlanInput = z.infer<typeof SetActiveRacePlanInputSchema>;
export const ActiveRacePlansResponseSchema = z.object({ plans: z.array(RacePlanSchema) }).strict();
export const RacePlansResponseSchema = z.object({ plans: z.array(RacePlanSchema) }).strict();
export const ActiveRacePlanResponseSchema = z.object({ plan: RacePlanSchema.nullable() }).strict();
export const RacePlanRecalculationResponseSchema = z.object({
  draft: RacePlanInputSchema,
  sources: z.array(StintSummarySchema),
}).strict();
