import { Schema } from "effect";
import { GameId, LapWindowSchema, LiveArchiveMemberSchema, PublishedManifestSchema, NonNegativeInt, PositiveInt, ProgressSchema, SourceDescriptorSchema } from "./contract";

export const SplitRequestSchema = Schema.Struct({
  jobId: Schema.String,
  attemptId: Schema.String,
  sourceRevision: Schema.String,
  operation: Schema.Literals(["split", "verify"]),
  gameId: GameId,
  source: SourceDescriptorSchema,
  outputDirectory: Schema.String,
  lapWindows: Schema.Array(LapWindowSchema),
});
export type SplitRequest = typeof SplitRequestSchema.Type;
export const WorkerMessageSchema = Schema.Union([
  Schema.Struct({ jobId: Schema.String, attemptId: Schema.String, sequence: NonNegativeInt, type: Schema.Literal("progress"), progress: ProgressSchema }),
  Schema.Struct({ jobId: Schema.String, attemptId: Schema.String, sequence: NonNegativeInt, type: Schema.Literal("complete"), manifest: PublishedManifestSchema }),
  Schema.Struct({ jobId: Schema.String, attemptId: Schema.String, sequence: NonNegativeInt, type: Schema.Literal("failure"), code: Schema.String, message: Schema.String }),
]);
export type WorkerMessage = typeof WorkerMessageSchema.Type;

/** Transferable live-capture controls and source records. No functions cross the worker boundary. */
export const LiveParserPlanSchema = Schema.Struct({
  gameId: GameId,
  sequence: NonNegativeInt,
  anchorSequence: NonNegativeInt,
  anchorPayload: Schema.Uint8Array,
  precedingRecords: Schema.Array(Schema.Struct({
    sequence: NonNegativeInt,
    frame: Schema.Uint8Array,
    timestampMs: Schema.optional(Schema.Finite),
  })),
});
export type LiveParserPlan = typeof LiveParserPlanSchema.Type;

const LiveSourceEventFields = Schema.Struct({
  sequence: NonNegativeInt,
  kind: Schema.Literals(["frame", "raw", "segment-boundary"]),
  offset: NonNegativeInt,
  endOffset: NonNegativeInt,
  sourceOffset: NonNegativeInt,
  sourceEndOffset: NonNegativeInt,
  bytes: Schema.Uint8Array,
  frameTimeMs: Schema.optional(Schema.Finite),
});

export const LiveCaptureEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start-live"), captureEpoch: Schema.String, attempt: Schema.String,
    sessionId: NonNegativeInt, archivePath: Schema.String, sourcePath: Schema.String, maxQueuedBytes: PositiveInt, maxUnresolvedBytes: PositiveInt,
    resume: Schema.optional(Schema.Struct({
      generation: NonNegativeInt,
      sourceOrdinal: NonNegativeInt,
      sourceByteOffset: NonNegativeInt,
      committedArchiveLength: NonNegativeInt,
    })),
  }),
  Schema.Struct({
    type: Schema.Literal("source"), captureEpoch: Schema.String,
    ...LiveSourceEventFields.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("candidate-start"), captureEpoch: Schema.String, sequence: NonNegativeInt,
    candidateId: Schema.String, lapNumber: NonNegativeInt, startByteOffset: NonNegativeInt,
    preparationOnly: Schema.Boolean, parserPlan: LiveParserPlanSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("candidate-promote"), captureEpoch: Schema.String, sequence: NonNegativeInt,
    candidateId: Schema.String, lapNumber: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("candidate-discard"), captureEpoch: Schema.String, sequence: NonNegativeInt,
    candidateId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("ownership-finalized"), captureEpoch: Schema.String, sequence: NonNegativeInt,
    candidateId: Schema.String, revision: NonNegativeInt, ownershipJournalSequence: Schema.optional(NonNegativeInt),
    ownershipSourceByteEnd: NonNegativeInt, window: LapWindowSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("lap-binding"), captureEpoch: Schema.String, sequence: NonNegativeInt,
    candidateId: Schema.String, lapId: Schema.String, ownershipJournalSequence: NonNegativeInt, ownershipSourceByteEnd: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("commit-result"), captureEpoch: Schema.String,
    candidateId: Schema.String, accepted: Schema.Boolean, generation: Schema.optional(NonNegativeInt), error: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("watermark"), captureEpoch: Schema.String, sequence: NonNegativeInt, sourceByteOffset: NonNegativeInt }),
  Schema.Struct({ type: Schema.Literal("close-live"), captureEpoch: Schema.String, sequence: NonNegativeInt, sourceByteOffset: NonNegativeInt }),
]);
export const LiveReplayBatchSchema = Schema.Struct({
  type: Schema.Literal("live-replay-batch"),
  captureEpoch: Schema.String,
  records: Schema.Array(LiveSourceEventFields),
  bytes: NonNegativeInt,
  sourceDurableSequence: NonNegativeInt,
  sourceByteEnd: NonNegativeInt,
});
export type LiveReplayBatch = typeof LiveReplayBatchSchema.Type;

export const LiveReplayAckSchema = Schema.Struct({
  type: Schema.Literal("live-replay-ack"),
  captureEpoch: Schema.String,
  sequence: NonNegativeInt,
  bytes: NonNegativeInt,
  sourceDurableSequence: NonNegativeInt,
  sourceByteEnd: NonNegativeInt,
  acceptedRecordCount: NonNegativeInt,
  error: Schema.optional(Schema.String),
});
export type LiveReplayAck = typeof LiveReplayAckSchema.Type;
export type LiveCaptureEvent = typeof LiveCaptureEventSchema.Type;
export const LiveParserReplayEvidenceSchema = Schema.Struct({
  sourceFrameCount: NonNegativeInt,
  parsedFrameCount: NonNegativeInt,
  nullFrameCount: NonNegativeInt,
  orderedTelemetryDigest: Schema.String,
});

export const LiveMemberReadyMessageSchema = Schema.Struct({
  type: Schema.Literal("member-ready"),
  captureEpoch: Schema.String,
  attempt: Schema.String,
  candidateId: Schema.String,
  ownershipRevision: NonNegativeInt,
  ownershipJournalSequence: Schema.optional(NonNegativeInt),
  ownershipSourceByteEnd: Schema.optional(NonNegativeInt),
  member: LiveArchiveMemberSchema,
  nativeDigest: Schema.String,
  parserReplayVerified: Schema.Boolean,
  parserReplayEvidence: Schema.optional(LiveParserReplayEvidenceSchema),
});
export type LiveMemberReadyMessage = typeof LiveMemberReadyMessageSchema.Type;
