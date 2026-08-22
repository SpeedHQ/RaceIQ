import { z } from "zod";

import { GameIdSchema } from "../../games/ids";

import type { LapCondition, LapPhase } from "../laps/classification";
import type {
  EvidenceSourceKind,
  ParticipantKind,
} from "../quality/contracts";

export const RACE_EVENT_SCHEMA_VERSION = "race-event-v1" as const;

export const RaceEventTypeSchema = z.enum([
  "session_started",
  "session_ended",
  "session_phase_changed",
  "green_flag",
  "caution_started",
  "caution_ended",
  "red_flag_started",
  "checkered_flag",
  "restart_started",
  "timebase_reset",
  "participant_joined",
  "participant_became_unavailable",
  "participant_returned",
  "driver_started_stint",
  "driver_changed",
  "position_changed",
  "lap_started",
  "lap_completed",
  "sector_completed",
  "track_limit_or_lap_invalidated",
  "pit_entry",
  "pit_stall_arrival",
  "pit_service_started",
  "tire_service_observed",
  "fuel_service_observed",
  "repair_service_observed",
  "driver_service_observed",
  "pit_service_completed",
  "pit_stall_departure",
  "pit_exit",
  "pit_visit_incomplete",
  "drive_through_observed",
  "incident_observed",
  "damage_warning_started",
  "damage_warning_cleared",
  "penalty_issued",
  "penalty_cleared",
  "car_reset",
  "fast_repair_used",
  "retirement_observed",
  "source_connected",
  "source_disconnected",
  "source_stale",
  "source_recovered",
  "telemetry_gap",
  "out_of_order_input",
  "duplicate_input_suppressed",
  "storage_drop",
  "storage_failure",
  "timeline_discontinuity",
]);
export type RaceEventType = z.infer<typeof RaceEventTypeSchema>;

export const RaceEventIdSchema = z
  .string()
  .regex(
    /^(?:race-event:sha256:[0-9a-f]{64}|pit-event:[^\s]+|position-event:[^\s]+)$/,
    "Invalid race event ID",
  )
  .brand<"RaceEventId">();
export type RaceEventId = z.infer<typeof RaceEventIdSchema>;

export const RaceSessionPhaseSchema = z.enum([
  "unknown",
  "inactive",
  "formation",
  "green",
  "caution",
  "red",
  "checkered",
  "finished",
]);
export type RaceSessionPhase = z.infer<typeof RaceSessionPhaseSchema>;

export const CautionKindSchema = z.enum([
  "local-yellow",
  "full-course-yellow",
  "safety-car",
  "virtual-safety-car",
  "unknown",
]);
export type CautionKind = z.infer<typeof CautionKindSchema>;

export const PitObservationStateSchema = z.enum([
  "out",
  "pit-lane",
  "pit-stall",
  "unknown",
]);
export type PitObservationState = z.infer<typeof PitObservationStateSchema>;

export const PitServiceActionSchema = z.enum([
  "tires",
  "fuel",
  "repair",
  "driver",
]);
export type PitServiceAction = z.infer<typeof PitServiceActionSchema>;

const NativeCodeSchema = z.union([z.string(), z.number().finite()]).nullable();
const NullableTextSchema = z.string().nullable();
const NullableFiniteSchema = z.number().finite().nullable();
const SafeIntegerSchema = z.number().int().safe();
const SafeNonNegativeIntegerSchema = SafeIntegerSchema.nonnegative();
const NullableSafeIntegerSchema = SafeIntegerSchema.nullable();
const NonNegativeFiniteSchema = z.number().finite().nonnegative();
const NullableNonNegativeFiniteSchema = NonNegativeFiniteSchema.nullable();
const PositiveIntegerSchema = SafeIntegerSchema.positive();
const NullablePositionSchema = PositiveIntegerSchema.nullable();
const LapPhaseSchema: z.ZodType<LapPhase> = z.enum([
  "flying",
  "out",
  "in",
  "pit",
  "grid_start",
]);
const LapConditionSchema: z.ZodType<LapCondition> = z.enum([
  "caution",
  "slow_zone",
  "formation",
]);
const FourCornerWearSchema = z
  .object({
    fl: z.number().finite().min(0).max(1),
    fr: z.number().finite().min(0).max(1),
    rl: z.number().finite().min(0).max(1),
    rr: z.number().finite().min(0).max(1),
  })
  .strict();
const TireCornerSchema = z.enum(["fl", "fr", "rl", "rr"]);
const DamageComponentsSchema = z.record(
  z.string().min(1),
  z.number().finite().min(0).max(100),
);

const SessionStartedPayloadSchema = z
  .object({
    phase: RaceSessionPhaseSchema,
    previousPhase: RaceSessionPhaseSchema.nullable(),
    reason: NullableTextSchema,
    gridStart: z.boolean(),
    nativeCode: NativeCodeSchema,
  })
  .strict();
const SessionEndedPayloadSchema = z
  .object({
    phase: RaceSessionPhaseSchema,
    previousPhase: RaceSessionPhaseSchema.nullable(),
    reason: NullableTextSchema,
    terminalObserved: z.boolean(),
    nativeCode: NativeCodeSchema,
  })
  .strict();
const SessionPhaseChangedPayloadSchema = z
  .object({
    phase: RaceSessionPhaseSchema,
    previousPhase: RaceSessionPhaseSchema,
    reason: NullableTextSchema,
    nativeCode: NativeCodeSchema,
  })
  .strict();
const FlagPayloadSchema = z.object({ nativeCode: NativeCodeSchema }).strict();
const CautionPayloadSchema = z
  .object({ kind: CautionKindSchema, nativeCode: NativeCodeSchema })
  .strict();
const TimebasePayloadSchema = z
  .object({
    reason: z.string().min(1),
    previousSourceTimeMs: NullableFiniteSchema,
    currentSourceTimeMs: NullableFiniteSchema,
  })
  .strict();
const ParticipantPayloadSchema = z
  .object({
    sourceId: NullableTextSchema,
    identityState: z.enum(["stable", "session-scoped", "unknown"]),
    displayName: NullableTextSchema,
    vehicleId: NullableTextSchema,
  })
  .strict();
const DriverPayloadSchema = z
  .object({
    previousDriverId: NullableTextSchema,
    driverId: NullableTextSchema,
    previousDisplayName: NullableTextSchema,
    displayName: NullableTextSchema,
  })
  .strict();
const PositionPayloadSchema = z
  .object({
    previousPosition: NullablePositionSchema,
    position: PositiveIntegerSchema,
  })
  .strict();
const LapStartedPayloadSchema = z
  .object({
    lapNumber: SafeNonNegativeIntegerSchema,
    phase: LapPhaseSchema,
    conditions: z.array(LapConditionSchema),
  })
  .strict();
const LapCompletedPayloadSchema = z
  .object({
    lapNumber: z.number().int().nonnegative(),
    lapTimeMs: NullableNonNegativeFiniteSchema,
    isValid: z.boolean(),
    phase: LapPhaseSchema,
    conditions: z.array(LapConditionSchema),
  })
  .strict();
const SectorCompletedPayloadSchema = z
  .object({
    lapNumber: z.number().int().nonnegative(),
    sectorIndex: z.number().int().nonnegative().nullable(),
    sectorTimeMs: NullableNonNegativeFiniteSchema,
  })
  .strict();
const LapInvalidatedPayloadSchema = z
  .object({
    lapNumber: z.number().int().nonnegative(),
    reason: NullableTextSchema,
  })
  .strict();
const PitTransitionPayloadSchema = z
  .object({
    previousState: PitObservationStateSchema,
    state: PitObservationStateSchema,
  })
  .strict();
const PitServiceStartedPayloadSchema = z
  .object({ trigger: z.enum(["stall", "service-observation"]) })
  .strict();
const TireServicePayloadSchema = z
  .object({
    changedCorners: z.array(TireCornerSchema),
    previousCompound: NullableTextSchema,
    currentCompound: NullableTextSchema,
    beforeWear: FourCornerWearSchema.nullable(),
    afterWear: FourCornerWearSchema.nullable(),
  })
  .strict();
const FuelServicePayloadSchema = z
  .object({
    beforeLitres: NonNegativeFiniteSchema,
    afterLitres: NonNegativeFiniteSchema,
    addedLitres: NonNegativeFiniteSchema,
  })
  .strict();
const RepairRemainingSecondsSchema = z
  .object({
    mandatory: NonNegativeFiniteSchema,
    optional: NonNegativeFiniteSchema,
  })
  .strict();
const RepairServicePayloadSchema = z
  .object({
    previousComponents: DamageComponentsSchema,
    currentComponents: DamageComponentsSchema,
    repairedComponents: z.array(z.string().min(1)),
    previousRemainingSeconds: RepairRemainingSecondsSchema.optional(),
    currentRemainingSeconds: RepairRemainingSecondsSchema.optional(),
  })
  .strict();
const DriverServicePayloadSchema = z
  .object({
    previousDriverId: NullableTextSchema,
    driverId: NullableTextSchema,
  })
  .strict();
const PitCompletionPayloadSchema = z
  .object({
    durationMs: NullableNonNegativeFiniteSchema,
    observedActions: z.array(PitServiceActionSchema),
    state: PitObservationStateSchema,
  })
  .strict();
const IncidentPayloadSchema = z
  .object({
    previousCount: z.number().int().nonnegative(),
    currentCount: z.number().int().nonnegative(),
    delta: z.number().int().positive(),
  })
  .strict();
const DamagePayloadSchema = z
  .object({
    previousComponents: DamageComponentsSchema,
    currentComponents: DamageComponentsSchema,
    changedComponents: z.array(z.string().min(1)),
  })
  .strict();
const PenaltyIssuedPayloadSchema = z
  .object({
    previousValue: NullableNonNegativeFiniteSchema,
    currentValue: NonNegativeFiniteSchema,
    nativeCode: NativeCodeSchema,
  })
  .strict();
const PenaltyClearedPayloadSchema = z
  .object({
    previousValue: NonNegativeFiniteSchema,
    currentValue: NullableNonNegativeFiniteSchema,
    nativeCode: NativeCodeSchema,
    resolution: z.literal("unknown"),
  })
  .strict();
const NativeStatusPayloadSchema = z
  .object({ nativeCode: NativeCodeSchema, status: NullableTextSchema })
  .strict();
const SourceLifecyclePayloadSchema = z
  .object({ lifecycleKind: z.string().min(1), details: NullableTextSchema })
  .strict();
const TelemetryGapPayloadSchema = z
  .object({
    durationMs: NonNegativeFiniteSchema,
    missingCount: z.number().int().positive(),
    countMethod: z.enum([
      "native-sequence",
      "timestamp-estimate",
      "unavailable",
    ]),
    sourceSequenceFamily: NullableTextSchema,
  })
  .strict();
const SequenceBoundaryPayloadSchema = z
  .object({
    sourceSequenceFamily: NullableTextSchema,
    previousSequence: NullableFiniteSchema,
    currentSequence: NullableFiniteSchema,
  })
  .strict();
const StoragePayloadSchema = z
  .object({ operation: z.string().min(1), details: NullableTextSchema })
  .strict();

/** Exhaustive runtime payload registry. Payload objects are deliberately strict. */
export const RaceEventPayloadSchemas = {
  session_started: SessionStartedPayloadSchema,
  session_ended: SessionEndedPayloadSchema,
  session_phase_changed: SessionPhaseChangedPayloadSchema,
  green_flag: FlagPayloadSchema,
  caution_started: CautionPayloadSchema,
  caution_ended: CautionPayloadSchema,
  red_flag_started: FlagPayloadSchema,
  checkered_flag: FlagPayloadSchema,
  restart_started: FlagPayloadSchema,
  timebase_reset: TimebasePayloadSchema,
  participant_joined: ParticipantPayloadSchema,
  participant_became_unavailable: ParticipantPayloadSchema,
  participant_returned: ParticipantPayloadSchema,
  driver_started_stint: DriverPayloadSchema,
  driver_changed: DriverPayloadSchema,
  position_changed: PositionPayloadSchema,
  lap_started: LapStartedPayloadSchema,
  lap_completed: LapCompletedPayloadSchema,
  sector_completed: SectorCompletedPayloadSchema,
  track_limit_or_lap_invalidated: LapInvalidatedPayloadSchema,
  pit_entry: PitTransitionPayloadSchema,
  pit_stall_arrival: PitTransitionPayloadSchema,
  pit_service_started: PitServiceStartedPayloadSchema,
  tire_service_observed: TireServicePayloadSchema,
  fuel_service_observed: FuelServicePayloadSchema,
  repair_service_observed: RepairServicePayloadSchema,
  driver_service_observed: DriverServicePayloadSchema,
  pit_service_completed: PitCompletionPayloadSchema,
  pit_stall_departure: PitTransitionPayloadSchema,
  pit_exit: PitTransitionPayloadSchema,
  pit_visit_incomplete: PitCompletionPayloadSchema,
  drive_through_observed: PitCompletionPayloadSchema,
  incident_observed: IncidentPayloadSchema,
  damage_warning_started: DamagePayloadSchema,
  damage_warning_cleared: DamagePayloadSchema,
  penalty_issued: PenaltyIssuedPayloadSchema,
  penalty_cleared: PenaltyClearedPayloadSchema,
  car_reset: NativeStatusPayloadSchema,
  fast_repair_used: NativeStatusPayloadSchema,
  retirement_observed: NativeStatusPayloadSchema,
  source_connected: SourceLifecyclePayloadSchema,
  source_disconnected: SourceLifecyclePayloadSchema,
  source_stale: SourceLifecyclePayloadSchema,
  source_recovered: SourceLifecyclePayloadSchema,
  telemetry_gap: TelemetryGapPayloadSchema,
  out_of_order_input: SequenceBoundaryPayloadSchema,
  duplicate_input_suppressed: SequenceBoundaryPayloadSchema,
  storage_drop: StoragePayloadSchema,
  storage_failure: StoragePayloadSchema,
  timeline_discontinuity: TimebasePayloadSchema,
} as const satisfies Record<RaceEventType, z.ZodType>;

export type RaceEventPayloadMap = {
  [Type in RaceEventType]: z.infer<(typeof RaceEventPayloadSchemas)[Type]>;
};

const EvidenceSourceKindSchema: z.ZodType<EvidenceSourceKind> = z.enum([
  "native-live",
  "raceiq-raw",
  "raceiq-archive",
  "canonical-archive",
  "iracing-ibt",
  "motec",
  "remote-collector",
  "external-log",
  "unknown",
]);
const ParticipantKindSchema: z.ZodType<ParticipantKind> = z.enum([
  "player",
  "opponent",
]);
const WorldPositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();
const QueryBooleanSchema = z.preprocess(
  (value) =>
    value === "true" ? true : value === "false" ? false : value,
  z.boolean(),
);

const persistedRaceEventShape = {
  eventId: RaceEventIdSchema,
  eventType: RaceEventTypeSchema,
  schemaVersion: z.literal(RACE_EVENT_SCHEMA_VERSION),
  sessionId: PositiveIntegerSchema,
  participantId: NullableTextSchema,
  participantKind: ParticipantKindSchema.nullable(),
  driverId: NullableTextSchema,
  teamId: NullableTextSchema,
  timelineEpoch: SafeNonNegativeIntegerSchema,
  sequence: SafeNonNegativeIntegerSchema,
  eventOrder: SafeNonNegativeIntegerSchema,
  sourceTimeMs: NullableSafeIntegerSchema,
  sourceEndTimeMs: NullableSafeIntegerSchema,
  sourceSequenceFamily: NullableTextSchema,
  sourceSequence: NullableSafeIntegerSchema,
  receivedAtMs: SafeNonNegativeIntegerSchema,
  lapNumber: SafeNonNegativeIntegerSchema.nullable(),
  lapId: PositiveIntegerSchema.nullable(),
  trackDistanceM: NullableFiniteSchema,
  trackDistancePct: z.number().finite().min(0).max(1).nullable(),
  worldPosition: WorldPositionSchema.nullable(),
  evidenceKind: z.enum(["observed", "derived", "inferred"]),
  confidence: z.enum(["high", "medium", "low", "unknown"]),
  qualityState: z.enum([
    "available",
    "degraded",
    "ambiguous",
    "unavailable",
  ]),
  sourceKind: EvidenceSourceKindSchema,
  payload: z.unknown(),
  lifecycleId: NullableTextSchema,
  linkedEventId: RaceEventIdSchema.nullable(),
  detectorId: z.string().min(1),
  detectorVersion: z.string().min(1),
  sourceGeneration: NullableTextSchema,
  analysisGenerationId: NullableTextSchema,
  contentHash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .nullable(),
  createdAt: z.string().datetime({ offset: true }),
} as const;

type RaceEventForType<Type extends RaceEventType> = Omit<
  z.infer<z.ZodObject<typeof persistedRaceEventShape>>,
  "eventType" | "payload"
> & {
  eventType: Type;
  payload: RaceEventPayloadMap[Type];
};

export type RaceEvent = {
  [Type in RaceEventType]: RaceEventForType<Type>;
}[RaceEventType];

function validateEventPayload(
  value: { eventType: RaceEventType; payload: unknown },
  ctx: z.RefinementCtx,
): void {
  const result = RaceEventPayloadSchemas[value.eventType].safeParse(value.payload);
  if (result.success) return;
  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: "custom",
      message: issue.message,
      path: ["payload", ...issue.path],
    });
  }
}

const rangedEventTypes = new Set<RaceEventType>([
  "pit_service_completed",
  "pit_visit_incomplete",
  "drive_through_observed",
  "source_stale",
  "telemetry_gap",
]);

function validateEventTimeRange(
  value: {
    eventType: RaceEventType;
    sourceTimeMs: number | null;
    sourceEndTimeMs: number | null;
  },
  ctx: z.RefinementCtx,
): void {
  if ((value.sourceTimeMs == null) !== (value.sourceEndTimeMs == null)) {
    ctx.addIssue({
      code: "custom",
      message: "sourceTimeMs and sourceEndTimeMs must both be null or both be set",
      path: ["sourceEndTimeMs"],
    });
    return;
  }
  if (
    value.sourceTimeMs != null &&
    value.sourceEndTimeMs != null &&
    value.sourceEndTimeMs < value.sourceTimeMs
  ) {
    ctx.addIssue({
      code: "custom",
      message: "sourceEndTimeMs must be greater than or equal to sourceTimeMs",
      path: ["sourceEndTimeMs"],
    });
  } else if (
    value.sourceTimeMs != null &&
    value.sourceEndTimeMs != null &&
    !rangedEventTypes.has(value.eventType) &&
    value.sourceEndTimeMs !== value.sourceTimeMs
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Point events must use the same source start and end time",
      path: ["sourceEndTimeMs"],
    });
  }
}

const PersistedRaceEventObjectSchema = z.object(persistedRaceEventShape).strict();

export const RaceEventSchema = PersistedRaceEventObjectSchema
  .strict()
  .superRefine(validateEventPayload)
  .superRefine(validateEventTimeRange) as unknown as z.ZodType<RaceEvent>;

const RaceEventDraftObjectSchema = PersistedRaceEventObjectSchema.omit({
  eventId: true,
  contentHash: true,
  createdAt: true,
});

export type RaceEventDraft = {
  [Type in RaceEventType]: Omit<
    RaceEventForType<Type>,
    "eventId" | "contentHash" | "createdAt"
  >;
}[RaceEventType];

export const RaceEventDraftSchema = RaceEventDraftObjectSchema
  .superRefine(validateEventPayload)
  .superRefine(validateEventTimeRange) as unknown as z.ZodType<RaceEventDraft>;

export const RaceEventQuerySchema = z
  .object({
    gameId: GameIdSchema,
    participantId: z.string().min(1).optional(),
    lapNumber: z.coerce.number().int().nonnegative().optional(),
    fromSourceTimeMs: z.coerce.number().finite().optional(),
    toSourceTimeMs: z.coerce.number().finite().optional(),
    eventType: RaceEventTypeSchema.optional(),
    lifecycleId: z.string().min(1).optional(),
    qualityOnly: QueryBooleanSchema.optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict()
  .refine(
    ({ fromSourceTimeMs, toSourceTimeMs }) =>
      fromSourceTimeMs == null ||
      toSourceTimeMs == null ||
      fromSourceTimeMs <= toSourceTimeMs,
    {
      message: "fromSourceTimeMs must not exceed toSourceTimeMs",
      path: ["fromSourceTimeMs"],
    },
  );
export type RaceEventQuery = z.infer<typeof RaceEventQuerySchema>;

export const RaceEventPageSchema = z
  .object({
    items: z.array(RaceEventSchema),
    nextCursor: z.string().min(1).nullable(),
    tailCursor: z.string().min(1).nullable(),
  })
  .strict();
export type RaceEventPage = z.infer<typeof RaceEventPageSchema>;

export const RaceEventsAppendedMessageSchema = z
  .object({
    type: z.literal("race-events-appended"),
    sessionId: PositiveIntegerSchema,
    events: z.array(RaceEventSchema),
  })
  .strict();
export type RaceEventsAppendedMessage = z.infer<
  typeof RaceEventsAppendedMessageSchema
>;

export const RaceEventsReplacedMessageSchema = z
  .object({
    type: z.literal("race-events-replaced"),
    sessionId: PositiveIntegerSchema,
  })
  .strict();
export type RaceEventsReplacedMessage = z.infer<
  typeof RaceEventsReplacedMessageSchema
>;
