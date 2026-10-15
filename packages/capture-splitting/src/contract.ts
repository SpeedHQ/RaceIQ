import { Schema } from "effect";
export const NonNegativeInt = Schema.Natural;
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const ManifestVersion = 3;
export const GameId = Schema.Literals(["acc", "ac-evo", "f1-2025", "fm-2023", "iracing", "lmu"]);
export type GameId = typeof GameId.Type;

export const LapWindowSchema = Schema.Struct({
  lapId: Schema.String,
  lapNumber: PositiveInt,
  startByteOffset: NonNegativeInt,
  frameCount: PositiveInt,
  parserCheckpoint: Schema.optional(Schema.Uint8Array),
  trailingContextFrameCount: Schema.optional(NonNegativeInt),
});
export type LapWindow = typeof LapWindowSchema.Type;

export const SourceDescriptorSchema = Schema.Struct({ path: Schema.String, revision: Schema.String });
export type SourceDescriptor = typeof SourceDescriptorSchema.Type;

export const ChunkSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["lap", "auxiliary"]),
  lapId: Schema.optional(Schema.String),
  lapNumber: Schema.optional(PositiveInt),
  path: Schema.String,
  byteLength: NonNegativeInt,
  firstOrdinal: NonNegativeInt,
  recordCount: NonNegativeInt,
  sourceStart: NonNegativeInt,
  sourceEnd: NonNegativeInt,
  sourceByteStart: NonNegativeInt,
  sourceByteEnd: NonNegativeInt,
  firstTimestamp: Schema.optional(Schema.Finite),
  lastTimestamp: Schema.optional(Schema.Finite),
  ownedFrameByteOffset: Schema.optional(NonNegativeInt),
  ownedFrameCount: Schema.optional(PositiveInt),
  parserBootstrapHash: Schema.optional(Schema.String),
  trailingContextFrameCount: Schema.optional(NonNegativeInt),
});
export type Chunk = typeof ChunkSchema.Type;

export const ManifestSchema = Schema.Struct({
  version: Schema.Literal(ManifestVersion),
  gameId: GameId,
  sourceRevision: Schema.String,
  sourceByteLength: NonNegativeInt,
  sourceRecordCount: NonNegativeInt,
  chunks: Schema.Array(ChunkSchema),
});
export type Manifest = typeof ManifestSchema.Type;

export const ProgressSchema = Schema.Struct({
  phase: Schema.Literals(["scan", "write", "verify"]),
  records: NonNegativeInt,
  frames: NonNegativeInt,
  bytes: NonNegativeInt,
  completedLapArtifacts: NonNegativeInt,
  totalLapArtifacts: NonNegativeInt,
});
export type Progress = typeof ProgressSchema.Type;
