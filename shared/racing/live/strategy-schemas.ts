import { z } from "zod";
import { GameIdSchema } from "../../games/ids";
import type { CompatibilityContext, HistoricalBaseline, MetricRate, PitEstimatePage, PitEstimateRecord, SourceOrder, StintSummary, StrategyLapMetric, StrategyLapMetricsResponse, StrategyLapMetricValue, StrategyLapTireMetric } from "./strategy";

const finite = z.number().finite();
const count = z.number().int().nonnegative().safe();
const nullableText = z.string().nullable();
const nullableNumber = finite.nullable();
const four = <T extends z.ZodType>(schema: T) => z.tuple([schema, schema, schema, schema]);
export const CompatibilityContextSchema: z.ZodType<CompatibilityContext> = z.object({
  fuelSemanticVersion: nullableText,
  tireSemanticVersions: four(nullableText),
  virtualEnergySemanticVersion: nullableText.optional(),
  setupKey: nullableText,
  conditions: z.object({ weather: nullableText, airTemperatureC: nullableNumber, trackTemperatureC: nullableNumber }),
});
export const SourceOrderSchema: z.ZodType<SourceOrder> = z.object({ epochOrdinal: count, sequence: count });
const RateStatisticsSchema = z.object({ p50: nullableNumber, p95: nullableNumber });
export const MetricRateSchema: z.ZodType<MetricRate> = z.object({
  value: nullableNumber,
  unit: z.enum(["L/lap", "tankFraction/lap", "wearFraction/lap", "energyFraction/lap"]),
  eligibleLaps: count,
  source: z.enum(["history", "current-stint"]).nullable(),
  provisional: z.boolean(),
  unavailableReason: nullableText,
});
export const HistoricalBaselineSchema: z.ZodType<HistoricalBaseline> = z.object({
  fuel: MetricRateSchema,
  tires: four(MetricRateSchema),
  evidence: z.array(z.object({ metric: z.enum(["fuel", "fl", "fr", "rl", "rr"]), sessionId: count, stintId: z.string(), eligibleLaps: count, endedAt: z.string() })),
  lastObservedAt: nullableText,
  limitations: z.array(z.string()),
  historyRevision: count,
});
export const StintSummarySchema: z.ZodType<StintSummary> = z.object({
  id: z.string(), sessionId: count, driverKey: z.string(), ordinal: count,
  status: z.enum(["active", "completed", "interrupted"]),
  gameId: GameIdSchema, trackId: z.string(), carId: z.string(), pi: nullableNumber,
  compounds: four(nullableText), compatibility: CompatibilityContextSchema,
  startedAt: z.string(), endedAt: nullableText,
  firstLapNumber: count.nullable(), lastLapNumber: count.nullable(),
  boundary: z.object({ reason: z.string(), confidence: z.enum(["observed", "inferred", "unknown"]) }),
  completedLaps: count, fuel: MetricRateSchema, tires: four(MetricRateSchema),
  rateStatistics: z.object({
    fuel: RateStatisticsSchema,
    tires: four(RateStatisticsSchema),
  }).optional(),
  coldRateStatistics: RateStatisticsSchema.optional(),
  coldTireRateStatistics: four(RateStatisticsSchema).optional(),
  coldLaps: count.optional(),
  virtualEnergy: MetricRateSchema.optional(),
  measuredFuelUsed: nullableNumber, fuelUnit: z.enum(["L", "tankFraction"]),
  fuelCoverage: z.enum(["complete", "partial", "unavailable"]),
  averageLapSeconds: nullableNumber, paceLaps: count,
  exclusions: z.array(z.object({ reason: z.string(), count })),
  algorithmVersion: z.string(), revision: count,
});
export const PitEstimateRecordSchema: z.ZodType<PitEstimateRecord> = z.object({
  id: z.string(), sessionId: count, driverKey: z.string(), stintId: z.string(), observedAt: z.string(),
  gameId: GameIdSchema, trackId: z.string(), carId: z.string(), pi: nullableNumber, compounds: four(nullableText),
  sourceOrder: SourceOrderSchema,
  sourceCoordinate: z.object({ epoch: z.string(), domain: z.enum(["session", "wall-clock"]), milliseconds: finite }),
  trigger: z.enum(["lap-completed", "limiter-changed", "stint-ended"]),
  pitInLaps: nullableNumber, estimatedPitTime: z.object({ sessionElapsedSeconds: nullableNumber }),
  limitedBy: z.enum(["fuel", "tires"]).nullable(),
  tyreChangeSuggestion: z.enum(["consider-change", "not-indicated", "unavailable"]),
  fuelChangeSuggestion: z.enum(["consider-refuel", "not-indicated", "unavailable"]),
  fuel: MetricRateSchema, tires: four(MetricRateSchema),
  sourceSnapshot: z.object({ fuelRemaining: nullableNumber, fuelUnit: z.enum(["L", "tankFraction"]), wear: four(nullableNumber), lapId: count.nullable() }),
  compatibility: CompatibilityContextSchema, baseline: HistoricalBaselineSchema.nullable(), algorithmVersion: z.string(),
});
export const PitEstimatePageSchema: z.ZodType<PitEstimatePage> = z.object({ estimates: z.array(PitEstimateRecordSchema), nextCursor: nullableText });
export const StintsResponseSchema = z.object({ stints: z.array(StintSummarySchema) });
export const BaselineResponseSchema = z.object({ baseline: HistoricalBaselineSchema });
const StrategyLapMetricValueSchema: z.ZodType<StrategyLapMetricValue> = z.object({
  value: nullableNumber,
  unit: z.enum(["L/lap", "tankFraction/lap"]),
  unavailableReason: nullableText,
});
const StrategyLapTireMetricSchema: z.ZodType<StrategyLapTireMetric> = z.object({
  value: nullableNumber,
  unit: z.literal("wearFraction/lap"),
  unavailableReason: nullableText,
  compound: nullableText,
});
export const StrategyLapMetricSchema: z.ZodType<StrategyLapMetric> = z.object({
  lapId: count,
  lapNumber: count,
  driverKey: z.string().min(1),
  stintId: z.string().min(1),
  stintOrdinal: count,
  thermalState: z.enum(["cold", "warm", "unavailable"]),
  fuel: StrategyLapMetricValueSchema,
  tires: four(StrategyLapTireMetricSchema),
});
export const StrategyLapMetricsResponseSchema: z.ZodType<StrategyLapMetricsResponse> = z.object({
  laps: z.array(StrategyLapMetricSchema),
});
