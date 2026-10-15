import { Schema } from "effect";
import { GameId, LapWindowSchema, ManifestSchema, NonNegativeInt, ProgressSchema, SourceDescriptorSchema } from "./contract";

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
  Schema.Struct({ jobId: Schema.String, attemptId: Schema.String, sequence: NonNegativeInt, type: Schema.Literal("complete"), manifest: ManifestSchema }),
  Schema.Struct({ jobId: Schema.String, attemptId: Schema.String, sequence: NonNegativeInt, type: Schema.Literal("failure"), code: Schema.String, message: Schema.String }),
]);
export type WorkerMessage = typeof WorkerMessageSchema.Type;
