import { z } from "zod";

import { RaceEventIdSchema } from "../events/contracts";
import { isTelemetryVariableId } from "../../telemetry/catalog/query";
import type { TelemetryVariableId } from "../../telemetry/catalog/generated/telemetry-catalog.types";
import type { TelemetryVersionIdentity } from "../../telemetry/version";

export const CANONICAL_ARCHIVE_SCHEMA_VERSION = "canonical-archive-v1" as const;
export const CANONICAL_ARCHIVE_ALGORITHM_VERSION = "canonical-archive-builder-v1" as const;

export const CanonicalArchiveStatusSchema = z.enum([
  "pending",
  "building",
  "verified",
  "partial",
  "failed",
  "superseded",
]);
export type CanonicalArchiveStatus = z.infer<typeof CanonicalArchiveStatusSchema>;

export const CanonicalArchiveJobStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export type CanonicalArchiveJobStatus = z.infer<typeof CanonicalArchiveJobStatusSchema>;

export const CanonicalArchiveNodeLevelSchema = z.enum([
  "participant",
  "stint",
  "lap",
  "corner",
  "segment",
]);
export type CanonicalArchiveNodeLevel = z.infer<typeof CanonicalArchiveNodeLevelSchema>;

export const CanonicalArchiveSegmentKindSchema = z.string().min(1);
export const CanonicalArchiveBoundaryStatusSchema = z.enum([
  "authoritative",
  "derived",
  "fallback",
  "missing",
  "empty",
  "complete",
  "partial",
  "valid",
  "invalid",
  "out",
  "in",
  "pit",
  "unknown",
]);
export type CanonicalArchiveBoundaryStatus = z.infer<typeof CanonicalArchiveBoundaryStatusSchema>;

const NullableFiniteSchema = z.number().finite().nullable();
const NullableNonNegativeIntegerSchema = z.number().int().nonnegative().nullable();
const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });

export const CanonicalArchiveSampleSchema = z.strictObject({
  sampleOrdinal: z.number().int().nonnegative(),
  participantId: z.string().min(1).nullable(),
  lapId: NullableNonNegativeIntegerSchema,
  lapNumber: NullableNonNegativeIntegerSchema,
  sourceTimeMs: z.number().int().nonnegative(),
  receivedAtMs: z.number().int().nonnegative(),
  trackDistanceM: NullableFiniteSchema,
  trackDistancePct: z.number().finite().min(0).max(1).nullable(),
  packetJson: z.string().min(2),
});
export type CanonicalArchiveSample = z.infer<typeof CanonicalArchiveSampleSchema>;

export const CanonicalArchiveNodeSchema = z.strictObject({
  nodeId: z.string().min(1),
  archiveId: z.string().min(1),
  parentNodeId: z.string().min(1).nullable(),
  level: CanonicalArchiveNodeLevelSchema,
  semanticKind: CanonicalArchiveSegmentKindSchema,
  stableKey: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  participantId: z.string().min(1).nullable(),
  sessionRunId: z.string().min(1).nullable(),
  lapId: z.number().int().positive().nullable(),
  startRow: z.number().int().nonnegative(),
  endRow: z.number().int().nonnegative(),
  startSourceTimeMs: NullableFiniteSchema,
  endSourceTimeMs: NullableFiniteSchema,
  startTrackDistanceM: NullableFiniteSchema,
  endTrackDistanceM: NullableFiniteSchema,
  status: CanonicalArchiveBoundaryStatusSchema,
  definitionHash: Sha256Schema.nullable(),
  boundaryAlgorithmVersion: z.string().min(1),
}).superRefine((node, ctx) => {
  if (node.endRow < node.startRow) {
    ctx.addIssue({ code: "custom", path: ["endRow"], message: "endRow must be >= startRow" });
  }
  if (node.endSourceTimeMs != null && node.startSourceTimeMs != null && node.endSourceTimeMs < node.startSourceTimeMs) {
    ctx.addIssue({ code: "custom", path: ["endSourceTimeMs"], message: "endSourceTimeMs must be >= startSourceTimeMs" });
  }
});
export type CanonicalArchiveNode = z.infer<typeof CanonicalArchiveNodeSchema>;

export const CanonicalArchiveContextSchema = z.strictObject({
  gameId: z.string().min(1),
  trackId: z.string().min(1).nullable(),
  layoutId: z.string().min(1).nullable(),
  trackDefinitionHash: Sha256Schema.nullable(),
  cornerDefinitionHash: Sha256Schema.nullable(),
  sourceKind: z.string().min(1).nullable(),
  sourcePath: z.string().min(1).nullable(),
});
export type CanonicalArchiveContext = z.infer<typeof CanonicalArchiveContextSchema>;

export const CanonicalArchiveManifestSchema = z.strictObject({
  archiveId: z.string().min(1),
  sessionId: z.number().int().positive(),
  generationId: z.string().min(1),
  gameId: z.string().min(1),
  trackId: z.string().min(1).nullable(),
  layoutId: z.string().min(1).nullable(),
  sourceContentHash: Sha256Schema,
  telemetryVersion: z.strictObject({
    catalogVersion: z.string().min(1),
    catalogHash: z.string().min(1),
    catalogSchemaVersion: z.string().min(1),
    parserVersion: z.string().min(1),
    resolverVersion: z.string().min(1),
    derivationVersion: z.string().min(1),
  }),
  schemaVersion: z.literal(CANONICAL_ARCHIVE_SCHEMA_VERSION),
  algorithmVersion: z.literal(CANONICAL_ARCHIVE_ALGORITHM_VERSION),
  rowCount: z.number().int().nonnegative(),
  nodeCount: z.number().int().nonnegative(),
  semanticIds: z.array(z.string().min(1)),
  eventIds: z.array(z.string().min(1)),
  completeness: z.enum(["complete", "partial", "empty", "unavailable"]),
  warnings: z.array(z.string()),
  context: CanonicalArchiveContextSchema,
  createdAt: IsoTimestampSchema,
});
export type CanonicalArchiveManifest = z.infer<typeof CanonicalArchiveManifestSchema> & {
  telemetryVersion: TelemetryVersionIdentity;
};

export const CanonicalArchiveReceiptIdentitySchema = z.strictObject({
  archiveId: z.string().min(1),
  generationId: z.string().min(1),
  sourceContentHash: Sha256Schema,
  outputContentHash: Sha256Schema,
});
export type CanonicalArchiveReceiptIdentity = z.infer<typeof CanonicalArchiveReceiptIdentitySchema>;

export const CanonicalArchiveVerificationSchema = z.strictObject({
  status: z.enum(["passed", "failed"]),
  checks: z.array(z.strictObject({
    id: z.string().min(1),
    status: z.enum(["passed", "failed", "not_applicable"]),
    details: z.string(),
  })),
  verifiedAt: IsoTimestampSchema.nullable(),
  details: z.string().nullable(),
});
export type CanonicalArchiveVerification = z.infer<typeof CanonicalArchiveVerificationSchema>;

const TelemetryVariableIdSchema = z.custom<TelemetryVariableId>(
  (value) => typeof value === "string" && isTelemetryVariableId(value),
  { message: "Unknown telemetry variable ID" },
);

export const CanonicalArchiveProvenanceSchema = z.strictObject({
  archiveIdentity: z.string().min(1),
  schemaIdentity: z.string().min(1),
  configIdentity: Sha256Schema,
  sourceIdentity: Sha256Schema,
  outputIdentity: Sha256Schema,
});
export type CanonicalArchiveProvenance = z.infer<typeof CanonicalArchiveProvenanceSchema>;

export const CanonicalArchiveAvailabilitySchema = z.strictObject({
  state: z.enum(["available", "unavailable", "unknown"]),
  status: CanonicalArchiveStatusSchema.nullable(),
  completeness: z.enum(["complete", "partial", "empty", "unavailable"]).nullable(),
  archiveId: z.string().min(1).nullable(),
  generationId: z.string().min(1).nullable(),
  semanticIds: z.array(TelemetryVariableIdSchema),
  eventIds: z.array(RaceEventIdSchema),
  provenance: CanonicalArchiveProvenanceSchema.nullable(),
  details: z.string().nullable(),
});
export type CanonicalArchiveAvailability = z.infer<typeof CanonicalArchiveAvailabilitySchema>;
