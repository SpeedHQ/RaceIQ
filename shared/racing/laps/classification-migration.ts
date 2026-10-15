import { z } from "zod";
export const ClassificationMigrationCursorSchema = z.object({
  revision: z.number().int().nonnegative(),
  after: z.string().min(1),
}).strict();

export const ClassificationMigrationStatusSchema = z.object({
  version: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  status: z.enum(["idle", "running", "complete", "attention"]),
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  limited: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  aggregatesPending: z.boolean(),
});
export type ClassificationMigrationStatus = z.infer<typeof ClassificationMigrationStatusSchema>;

export const ClassificationMigrationRecordingSchema = z.object({
  recordingId: z.string(),
  sessionIds: z.array(z.number().int()),
  state: z.enum(["pending", "running", "completed", "limited", "failed"]),
  reason: z.enum(["active_capture", "maintenance_busy", "source_changed", "missing_source", "insufficient_evidence", "corrupt_source", "ambiguous_match", "processing_error"]).nullable(),
  retryable: z.boolean(),
});
export type ClassificationMigrationRecording = z.infer<typeof ClassificationMigrationRecordingSchema>;

export const ClassificationMigrationRecordingsPageSchema = z.object({
  revision: z.number().int().nonnegative(),
  recordings: z.array(ClassificationMigrationRecordingSchema),
  nextCursor: z.string().nullable(),
});
export type ClassificationMigrationRecordingsPage = z.infer<typeof ClassificationMigrationRecordingsPageSchema>;

export const ClassificationMigrationRetryResponseSchema = z.object({
  recordingId: z.string(),
  state: z.enum(["pending", "running", "completed"]),
});
export type ClassificationMigrationRetryResponse = z.infer<typeof ClassificationMigrationRetryResponseSchema>;

export const ClassificationMigrationStatusNotificationSchema = ClassificationMigrationStatusSchema.extend({
  type: z.literal("classification-migration-status"),
});
export type ClassificationMigrationStatusNotification = z.infer<typeof ClassificationMigrationStatusNotificationSchema>;
