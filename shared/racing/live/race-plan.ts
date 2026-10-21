import { z } from "zod";
import { GameIdSchema, type GameId } from "../../games/ids";
import { StintSummarySchema } from "./strategy-schemas";
import type { StintSummary, StrategyFuelUnit } from "./strategy";

const finite = z.number();
const fourCompounds = z.tuple([z.string().nullable(), z.string().nullable(), z.string().nullable(), z.string().nullable()]);
const nonemptyTrimmed = (max: number) => z.string().trim().min(1).max(max);

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
  fuelUnit: z.enum(["L", "tankFraction"]),
  notes: z.string().max(4_000),
  stints: z.array(RacePlanStintInputSchema).min(1).max(100),
}).strict().superRefine((plan, context) => {
  if (plan.fuelUnit === "tankFraction") {
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
  fuelUnit: StrategyFuelUnit;
  notes: string;
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

export const RacePlansResponseSchema = z.object({ plans: z.array(RacePlanSchema) }).strict();
export const ActiveRacePlanResponseSchema = z.object({ plan: RacePlanSchema.nullable() }).strict();
