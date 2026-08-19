import { z } from "zod";

import {
  RaceEventIdSchema,
  RaceSessionPhaseSchema,
} from "../events/contracts";

export const SESSION_RUN_SCHEMA_VERSION = "session-run-v1" as const;
export const SESSION_RUN_ALGORITHM_VERSION = "session-run-builder-v1" as const;

const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const NullableTextSchema = z.string().min(1).nullable();
const NullableFiniteSchema = z.number().finite().nullable();
const ContentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const QueryBooleanSchema = z.preprocess(
  (value) => (value === "true" ? true : value === "false" ? false : value),
  z.boolean(),
);

export const SessionRunIdSchema = z
  .string()
  .regex(/^session-run:sha256:[0-9a-f]{64}$/, "Invalid session run ID")
  .brand<"SessionRunId">();
export type SessionRunId = z.infer<typeof SessionRunIdSchema>;

export const SessionRunKindSchema = z.enum([
  "participant",
  "tire",
  "driver",
  "pace",
]);
export type SessionRunKind = z.infer<typeof SessionRunKindSchema>;

export const SessionRunStatusSchema = z.enum(["complete", "incomplete"]);
export type SessionRunStatus = z.infer<typeof SessionRunStatusSchema>;

export const SessionRunBoundaryReasonSchema = z.enum([
  "participant_joined",
  "participant_returned",
  "participant_unavailable",
  "first_lap_observed_without_participant",
  "session_phase_changed",
  "tire_service",
  "driver_started",
  "driver_changed",
  "fuel_service",
  "repair_service",
  "car_reset",
  "red_flag_started",
  "red_flag_restart",
  "timeline_discontinuity",
  "source_unavailable",
  "source_recovered",
  "session_ended",
  "source_ended",
]);
export type SessionRunBoundaryReason = z.infer<
  typeof SessionRunBoundaryReasonSchema
>;

export const SessionRunBoundarySchema = z
  .object({
    reason: SessionRunBoundaryReasonSchema,
    eventId: RaceEventIdSchema.nullable(),
    confidence: z.enum(["high", "medium", "low", "unknown"]),
    evidenceKind: z.enum(["observed", "derived", "inferred"]),
    algorithmVersion: z.literal(SESSION_RUN_ALGORITHM_VERSION),
  })
  .strict()
  .superRefine((boundary, context) => {
    if (boundary.eventId === null && boundary.reason !== "source_ended") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only source_ended boundaries may omit eventId",
        path: ["eventId"],
      });
    }
    if (boundary.reason === "source_ended" && boundary.eventId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source_ended boundaries must omit eventId",
        path: ["eventId"],
      });
    }
  });
export type SessionRunBoundary = z.infer<typeof SessionRunBoundarySchema>;

const EligibilityReasonSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(["info", "warning", "error"]),
    evidenceIds: z.array(z.string()),
    timeRange: z
      .object({ startMs: z.number().finite(), endMs: z.number().finite() })
      .strict()
      .nullable(),
    distanceRange: z
      .object({
        startFraction: z.number().finite(),
        endFraction: z.number().finite(),
      })
      .strict()
      .nullable(),
    semanticIds: z.array(z.string().min(1)),
  })
  .strict();

export const SessionRunFalloffEligibilitySchema = z
  .object({
    status: z.enum([
      "eligible",
      "eligible_with_warning",
      "ineligible",
      "unknown",
    ]),
    policyId: z.literal("stint-falloff"),
    policyVersion: z.string().min(1),
    confidence: z
      .object({
        level: z.enum(["high", "medium", "low", "unknown"]),
        score: z.number().finite().min(0).max(1).nullable(),
      })
      .strict(),
    reasons: z.array(EligibilityReasonSchema),
    evidenceIds: z.array(z.string()),
  })
  .strict();

export const SessionRunSummarySchema = z
  .object({
    membershipCount: NonNegativeIntegerSchema,
    completedLapCount: NonNegativeIntegerSchema,
    validLapCount: NonNegativeIntegerSchema,
    normalPaceLapCount: NonNegativeIntegerSchema,
    cautionLapCount: NonNegativeIntegerSchema,
    outLapCount: NonNegativeIntegerSchema,
    inLapCount: NonNegativeIntegerSchema,
    pitLapCount: NonNegativeIntegerSchema,
    trafficLapCount: NonNegativeIntegerSchema,
    incidentLapCount: NonNegativeIntegerSchema,
    dataQualityExcludedLapCount: NonNegativeIntegerSchema,
    bestLapTimeS: NullableFiniteSchema,
    medianLapTimeS: NullableFiniteSchema,
    meanLapTimeS: NullableFiniteSchema,
    standardDeviationS: NullableFiniteSchema,
    consistency: NullableFiniteSchema,
    degradationSlopeSPerLap: NullableFiniteSchema,
    falloffEligibility: SessionRunFalloffEligibilitySchema,
    qualityLimitations: z.array(z.string().min(1)),
  })
  .strict();
export type SessionRunSummary = z.infer<typeof SessionRunSummarySchema>;

const sessionRunBaseShape = {
  runId: SessionRunIdSchema,
  schemaVersion: z.literal(SESSION_RUN_SCHEMA_VERSION),
  algorithmVersion: z.literal(SESSION_RUN_ALGORITHM_VERSION),
  sessionId: PositiveIntegerSchema,
  participantId: NullableTextSchema,
  participantKind: z.enum(["player", "opponent"]).nullable(),
  driverId: NullableTextSchema,
  teamId: NullableTextSchema,
  classId: NullableTextSchema,
  runKind: SessionRunKindSchema,
  openingPhase: RaceSessionPhaseSchema,
  observedPhases: z.array(RaceSessionPhaseSchema).min(1),
  timelineEpoch: NonNegativeIntegerSchema,
  openingSequence: NonNegativeIntegerSchema,
  openingEventOrder: NonNegativeIntegerSchema,
  openingBoundary: SessionRunBoundarySchema,
  startLapEventId: RaceEventIdSchema.nullable(),
  endLapEventId: RaceEventIdSchema.nullable(),
  startLapId: PositiveIntegerSchema.nullable(),
  endLapId: PositiveIntegerSchema.nullable(),
  startSourceTimeMs: NullableFiniteSchema,
  endSourceTimeMs: NullableFiniteSchema,
  startTrackDistanceM: NullableFiniteSchema,
  endTrackDistanceM: NullableFiniteSchema,
  startTrackDistancePct: z.number().finite().min(0).max(1).nullable(),
  endTrackDistancePct: z.number().finite().min(0).max(1).nullable(),
  tireCompound: NullableTextSchema,
  tireSetId: NullableTextSchema,
  sourceGeneration: NullableTextSchema,
  analysisGenerationId: NullableTextSchema,
  qualityFlags: z.array(z.string().min(1)),
} as const;

function validateObservedPhases(
  run: { openingPhase: string; observedPhases: string[] },
  context: z.RefinementCtx,
): void {
  if (run.observedPhases[0] !== run.openingPhase) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "observedPhases must begin with openingPhase",
      path: ["observedPhases"],
    });
  }
  if (new Set(run.observedPhases).size !== run.observedPhases.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "observedPhases must be deduplicated",
      path: ["observedPhases"],
    });
  }
}

export const SessionRunSchema = z
  .object({
    ...sessionRunBaseShape,
    status: SessionRunStatusSchema,
    closingBoundary: SessionRunBoundarySchema,
    summary: SessionRunSummarySchema,
    contentHash: ContentHashSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((run, context) => {
    validateObservedPhases(run, context);
    if (run.openingBoundary.eventId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "openingBoundary.eventId is required",
        path: ["openingBoundary", "eventId"],
      });
    }
    if (run.closingBoundary.reason === "source_ended" && run.status !== "incomplete") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source_ended runs must be incomplete",
        path: ["status"],
      });
    }
  });
export type SessionRun = z.infer<typeof SessionRunSchema>;

export const OpenSessionRunSchema = z
  .object({
    ...sessionRunBaseShape,
    evidenceEventIds: z.array(RaceEventIdSchema),
    lapEventIds: z.array(RaceEventIdSchema),
    hasContent: z.boolean(),
  })
  .strict()
  .superRefine(validateObservedPhases);
export type OpenSessionRun = z.infer<typeof OpenSessionRunSchema>;

export const SessionRunLapMembershipSchema = z
  .object({
    runId: SessionRunIdSchema,
    lapEventId: RaceEventIdSchema,
    lapId: PositiveIntegerSchema.nullable(),
    lapNumber: NonNegativeIntegerSchema,
    ordinal: NonNegativeIntegerSchema,
    entryEventId: RaceEventIdSchema.nullable(),
    exitEventId: RaceEventIdSchema.nullable(),
  })
  .strict();
export type SessionRunLapMembership = z.infer<
  typeof SessionRunLapMembershipSchema
>;

export const SessionRunEvidenceRoleSchema = z.enum([
  "opening",
  "closing",
  "service",
  "supporting",
]);
export type SessionRunEvidenceRole = z.infer<
  typeof SessionRunEvidenceRoleSchema
>;

export const SessionRunEvidenceSchema = z
  .object({
    runId: SessionRunIdSchema,
    eventId: RaceEventIdSchema,
    role: SessionRunEvidenceRoleSchema,
  })
  .strict();
export type SessionRunEvidence = z.infer<typeof SessionRunEvidenceSchema>;

export const SessionRunQuerySchema = z
  .object({
    runKind: SessionRunKindSchema.optional(),
    participantId: z.string().min(1).optional(),
    driverId: z.string().min(1).optional(),
    observedPhase: RaceSessionPhaseSchema.optional(),
    timelineEpoch: z.coerce.number().int().nonnegative().optional(),
    status: SessionRunStatusSchema.optional(),
    overlapsRunId: SessionRunIdSchema.optional(),
    minCompletedLaps: z.coerce.number().int().nonnegative().optional(),
    maxCompletedLaps: z.coerce.number().int().nonnegative().optional(),
    qualityOnly: QueryBooleanSchema.optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict()
  .refine(
    ({ minCompletedLaps, maxCompletedLaps }) =>
      minCompletedLaps == null ||
      maxCompletedLaps == null ||
      minCompletedLaps <= maxCompletedLaps,
    {
      message: "minCompletedLaps must not exceed maxCompletedLaps",
      path: ["minCompletedLaps"],
    },
  );
export type SessionRunQuery = z.infer<typeof SessionRunQuerySchema>;

export const SessionRunLapQuerySchema = z
  .object({
    eligibilityPolicy: z
      .enum([
        "official-timing",
        "normal-pace",
        "lap-comparison",
        "corner-trace",
        "transient-event",
        "fuel-burn",
        "tire-analysis",
        "stint-falloff",
        "setup-analysis",
        "driver-profile",
        "ml-training",
      ])
      .default("normal-pace"),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict();
export type SessionRunLapQuery = z.infer<typeof SessionRunLapQuerySchema>;

export const ComparableSessionRunQuerySchema = z
  .object({
    participantId: z.string().min(1).optional(),
    driverId: z.string().min(1).optional(),
    classId: z.string().min(1).optional(),
    gameId: z.string().min(1).optional(),
    trackId: z.string().min(1).optional(),
    observedPhase: RaceSessionPhaseSchema.optional(),
    requireEnvironmentEvidence: QueryBooleanSchema.optional(),
    minCompletedLaps: z.coerce.number().int().nonnegative().optional(),
    maxCompletedLaps: z.coerce.number().int().nonnegative().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict()
  .refine(
    ({ minCompletedLaps, maxCompletedLaps }) =>
      minCompletedLaps == null ||
      maxCompletedLaps == null ||
      minCompletedLaps <= maxCompletedLaps,
    {
      message: "minCompletedLaps must not exceed maxCompletedLaps",
      path: ["minCompletedLaps"],
    },
  );
export type ComparableSessionRunQuery = z.infer<
  typeof ComparableSessionRunQuerySchema
>;

export const SessionRunPageSchema = z
  .object({
    items: z.array(SessionRunSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();
export type SessionRunPage = z.infer<typeof SessionRunPageSchema>;

export const SessionRunLapSchema = z
  .object({
    membership: SessionRunLapMembershipSchema,
    lap: z
      .object({
        id: PositiveIntegerSchema,
        sessionId: PositiveIntegerSchema,
        lapNumber: NonNegativeIntegerSchema,
        lapTime: z.number().finite(),
        isValid: z.boolean(),
        phase: z.string().min(1).nullable(),
        conditions: z.array(z.string()),
        quality: z.unknown().nullable(),
      })
      .strict()
      .nullable(),
    eligibility: z.unknown().nullable(),
    exclusionReasons: z.array(z.string().min(1)),
  })
  .strict();
export type SessionRunLap = z.infer<typeof SessionRunLapSchema>;

export const SessionRunLapPageSchema = z
  .object({
    items: z.array(SessionRunLapSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();
export type SessionRunLapPage = z.infer<typeof SessionRunLapPageSchema>;

export const SessionRunEvidencePageSchema = z
  .object({
    items: z.array(SessionRunEvidenceSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();
export type SessionRunEvidencePage = z.infer<
  typeof SessionRunEvidencePageSchema
>;

export const ComparableSessionRunSchema = z
  .object({
    run: SessionRunSchema,
    gameId: z.string().min(1),
    trackId: z.string().min(1),
    classEvidence: z.string().min(1).nullable(),
    environmentEvidence: z.record(z.string(), z.unknown()).nullable(),
    compatibilityLimitations: z.array(z.string().min(1)),
  })
  .strict();
export type ComparableSessionRun = z.infer<
  typeof ComparableSessionRunSchema
>;

export const ComparableSessionRunPageSchema = z
  .object({
    items: z.array(ComparableSessionRunSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();
export type ComparableSessionRunPage = z.infer<
  typeof ComparableSessionRunPageSchema
>;

export const SessionRunsCompletedMessageSchema = z
  .object({
    type: z.literal("session-runs-completed"),
    sessionId: PositiveIntegerSchema,
    runs: z.array(SessionRunSchema),
  })
  .strict();
export type SessionRunsCompletedMessage = z.infer<
  typeof SessionRunsCompletedMessageSchema
>;

export const SessionRunsReplacedMessageSchema = z
  .object({
    type: z.literal("session-runs-replaced"),
    sessionId: PositiveIntegerSchema,
  })
  .strict();
export type SessionRunsReplacedMessage = z.infer<
  typeof SessionRunsReplacedMessageSchema
>;
