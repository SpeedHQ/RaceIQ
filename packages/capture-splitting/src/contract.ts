import { Schema } from "effect";
export const NonNegativeInt = Schema.Natural;
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const ManifestVersion = 3;
export const MAX_CAPTURE_MANIFEST_BYTES = 16 * 1024 * 1024;
export const GameId = Schema.Literals(["acc", "ac-evo", "f1-2025", "fm-2023", "iracing", "lmu"]);
export type GameId = typeof GameId.Type;

export const LapWindowSchema = Schema.Struct({
  lapId: Schema.String,
  lapNumber: NonNegativeInt,
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
  lapNumber: Schema.optional(NonNegativeInt),
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

export const ArchiveChunkSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["lap", "auxiliary"]),
  lapId: Schema.optional(Schema.String),
  lapNumber: Schema.optional(NonNegativeInt),
  entryName: Schema.String,
  memberOffset: NonNegativeInt,
  compressedByteLength: PositiveInt,
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
export type ArchiveChunk = typeof ArchiveChunkSchema.Type;
export const ArchiveManifestSchema = Schema.Struct({
  version: Schema.Literal(4),
  gameId: GameId,
  sourceRevision: Schema.String,
  sourceByteLength: NonNegativeInt,
  sourceRecordCount: NonNegativeInt,
  archiveFile: Schema.Literal("capture.bin.gz"),
  chunks: Schema.Array(ArchiveChunkSchema),
});
export type ArchiveManifest = typeof ArchiveManifestSchema.Type;
/**
 * Append-only live archive index. Member descriptors are persisted incrementally by
 * the host; this value is a bounded snapshot, not a manifest rewritten per append.
 */
export const LiveArchiveVersion = 5;
export const LiveArchiveMemberSchema = Schema.Struct({
  ...ArchiveChunkSchema.fields,
  generation: PositiveInt,
});
export type LiveArchiveMember = typeof LiveArchiveMemberSchema.Type;
export const LiveArchiveIndexSchema = Schema.Struct({
  version: Schema.Literal(LiveArchiveVersion),
  gameId: GameId,
  captureEpoch: Schema.String,
  attempt: Schema.String,
  generation: NonNegativeInt,
  committedArchiveLength: NonNegativeInt,
  sourceDurableWatermark: NonNegativeInt,
  metadataDurableWatermark: NonNegativeInt,
  sourceRevision: Schema.String,
  sourceByteLength: NonNegativeInt,
  sourceRecordCount: NonNegativeInt,
  archiveFile: Schema.Literal("capture.bin.gz"),
  sealed: Schema.Boolean,
  members: Schema.Array(LiveArchiveMemberSchema),
});
export type LiveArchiveIndex = typeof LiveArchiveIndexSchema.Type;
export const LiveArchiveSnapshotSchema = Schema.Struct({
  version: Schema.Literal(LiveArchiveVersion),
  gameId: GameId,
  captureEpoch: Schema.String,
  attempt: Schema.String,
  generation: NonNegativeInt,
  committedArchiveLength: NonNegativeInt,
  sourceDurableWatermark: NonNegativeInt,
  metadataDurableWatermark: NonNegativeInt,
  sourceRevision: Schema.String,
  sourceByteLength: NonNegativeInt,
  sourceRecordCount: NonNegativeInt,
  archiveFile: Schema.Literal("capture.bin.gz"),
  sealed: Schema.Boolean,
  member: LiveArchiveMemberSchema,
});
export type LiveArchiveSnapshot = typeof LiveArchiveSnapshotSchema.Type;
export const PublishedManifestSchema = Schema.Union([ManifestSchema, ArchiveManifestSchema]);
export type PublishedManifest = typeof PublishedManifestSchema.Type;

export const ProgressSchema = Schema.Struct({
  phase: Schema.Literals(["scan", "write", "verify"]),
  records: NonNegativeInt,
  frames: NonNegativeInt,
  // Scan/verify: decoded source bytes; write: uncompressed encoded capture bytes, not gzip storage bytes.
  bytes: NonNegativeInt,
  completedLapArtifacts: NonNegativeInt,
  totalLapArtifacts: NonNegativeInt,
});
export type Progress = typeof ProgressSchema.Type;
