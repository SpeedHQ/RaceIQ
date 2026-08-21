import { z } from "zod";

import type { EvidenceSourceKind } from "../quality/contracts";
import type { TelemetryVersionIdentity } from "../../telemetry/version";

// Artifact-set IDs are permanent v1 identities. Keep this seed independent from
// receipt-schema evolution so upgrades keep resolving historical artifact sets.
export const ANALYSIS_ARTIFACT_SET_IDENTITY_SEED = "analysis-receipt-v1" as const;
export const ANALYSIS_RECEIPT_SCHEMA_VERSION = "analysis-receipt-v1" as const;

export const AnalysisArtifactSetTypeSchema = z.enum([
  "canonical_archive",
  "session_analysis",
  "lap_analysis",
  "comparison_analysis",
  "driver_profile",
  "report",
]);
export type AnalysisArtifactSetType = z.infer<typeof AnalysisArtifactSetTypeSchema>;

export const AnalysisArtifactTypeSchema = z.enum([
  "canonical_archive",
  "laps",
  "race_events",
  "session_runs",
  "race_result",
  "quality",
  "lap_metrics",
  "findings",
  "lap_analysis",
  "comparison_analysis",
  "driver_profile",
  "report",
]);
export type AnalysisArtifactType = z.infer<typeof AnalysisArtifactTypeSchema>;

export const AnalysisReceiptLifecycleSchema = z.enum([
  "rebuild_in_progress",
  "active",
  "superseded",
  "verification_failed",
]);
export type AnalysisReceiptLifecycle = z.infer<typeof AnalysisReceiptLifecycleSchema>;

export const AnalysisUserStatusSchema = z.enum([
  "current",
  "stale_rebuild_available",
  "stale_source_missing",
  "rebuild_in_progress",
  "verification_failed",
  "incompatible",
  "corrupt",
]);
export type AnalysisUserStatus = z.infer<typeof AnalysisUserStatusSchema>;

export const AnalysisStaleReasonSchema = z.enum([
  "receipt_missing",
  "source_hash_changed",
  "source_unavailable",
  "receipt_schema_changed",
  "telemetry_contract_changed",
  "detector_changed",
  "algorithm_changed",
  "configuration_changed",
  "output_verification_failed",
  "rebuild_interrupted",
]);
export type AnalysisStaleReason = z.infer<typeof AnalysisStaleReasonSchema>;

export const AnalysisVerificationCheckIdSchema = z.enum([
  "source_hash",
  "schema_supported",
  "session_identity",
  "participant_identity",
  "ordering",
  "coverage",
  "channel_inventory",
  "partitions_readable",
  "analyse_read",
  "compare_read",
  "storage_state",
]);
export type AnalysisVerificationCheckId = z.infer<typeof AnalysisVerificationCheckIdSchema>;

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });
const NullableNumberRangeSchema = z.strictObject({
  start: z.number().finite().nullable(),
  end: z.number().finite().nullable(),
});
const NullableIntegerRangeSchema = z.strictObject({
  start: z.number().int().nonnegative().nullable(),
  end: z.number().int().nonnegative().nullable(),
});

export const AnalysisVerificationCheckSchema = z.strictObject({
  id: AnalysisVerificationCheckIdSchema,
  status: z.enum(["passed", "failed", "not_applicable"]),
  details: z.string(),
});
export type AnalysisVerificationCheck = z.infer<typeof AnalysisVerificationCheckSchema>;

export const AnalysisOutputInventoryEntrySchema = z.strictObject({
  name: z.string().min(1),
  artifactType: AnalysisArtifactTypeSchema,
  schemaVersion: z.string().min(1),
  count: z.number().int().nonnegative(),
  contentHash: Sha256Schema.nullable(),
  timeCoverageMs: NullableIntegerRangeSchema.nullable(),
  lapCoverage: NullableIntegerRangeSchema.nullable(),
  participantCoverage: z.array(z.string()).nullable(),
  trackDistanceCoverageM: NullableNumberRangeSchema.nullable(),
});
export type AnalysisOutputInventoryEntry = z.infer<typeof AnalysisOutputInventoryEntrySchema>;

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

export const PersistedEvidenceKindSchema = z.enum([
  "raceiq-raw",
  "raceiq-archive",
  "canonical-archive",
  "iracing-ibt",
  "motec",
  "remote-collector",
  "external-log",
  "unknown",
]);
export type PersistedEvidenceKind = z.infer<typeof PersistedEvidenceKindSchema>;

const TelemetryVersionIdentitySchema: z.ZodType<TelemetryVersionIdentity> = z.strictObject({
  catalogVersion: z.string().min(1),
  catalogHash: z.string().min(1),
  catalogSchemaVersion: z.string().min(1),
  parserVersion: z.string().min(1),
  resolverVersion: z.string().min(1),
  derivationVersion: z.string().min(1),
});

export const AnalysisComponentIdentitySchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  schemaVersion: z.string().min(1).nullable(),
});
export type AnalysisComponentIdentity = z.infer<typeof AnalysisComponentIdentitySchema>;

export const AnalysisRebuildCapabilitySchema = z.strictObject({
  mode: z.enum(["exact", "limited", "unavailable"]),
  sourceKind: PersistedEvidenceKindSchema,
  rebuildableArtifacts: z.array(AnalysisArtifactTypeSchema),
  unavailableArtifacts: z.array(AnalysisArtifactTypeSchema),
  limitations: z.array(z.string()),
});
export type AnalysisRebuildCapability = z.infer<typeof AnalysisRebuildCapabilitySchema>;

export const AnalysisProvenanceReceiptSchema = z.strictObject({
  receiptSchemaVersion: z.literal(ANALYSIS_RECEIPT_SCHEMA_VERSION),
  generationId: z.string().min(1),
  artifactSetId: z.string().min(1),
  artifactSetType: AnalysisArtifactSetTypeSchema,
  generation: z.number().int().positive(),
  lifecycle: AnalysisReceiptLifecycleSchema,
  sessionId: z.number().int().positive(),
  participantId: z.string().min(1).nullable(),
  evidence: z.strictObject({
    kind: PersistedEvidenceKindSchema,
    originalSourceKind: EvidenceSourceKindSchema,
    objectId: z.string().min(1),
    contentHash: Sha256Schema.nullable(),
    byteSize: z.number().int().nonnegative().nullable(),
    formatVersion: z.string().min(1).nullable(),
    recordCounts: z.record(z.string(), z.number().int().nonnegative()),
  }),
  telemetryVersion: TelemetryVersionIdentitySchema,
  analysisComponents: z.array(AnalysisComponentIdentitySchema),
  configuration: z.strictObject({
    hash: Sha256Schema,
    effective: z.json(),
  }),
  context: z.strictObject({
    gameId: z.string().min(1),
    trackId: z.string().nullable(),
    layoutId: z.string().nullable(),
    trackDefinitionHash: Sha256Schema.nullable(),
    cornerDefinitionHash: Sha256Schema.nullable(),
  }),
  sourceFidelity: z.strictObject({
    profileVersion: z.string().nullable(),
    decisions: z.array(z.string()),
  }),
  outputs: z.array(AnalysisOutputInventoryEntrySchema),
  canonicalInventory: z.strictObject({
    semanticIds: z.array(z.string()),
    eventIds: z.array(z.string()),
    rowCounts: z.record(z.string(), z.number().int().nonnegative()),
  }).nullable(),
  warnings: z.array(z.string()),
  unsupportedFields: z.array(z.string()),
  rebuildCapability: AnalysisRebuildCapabilitySchema,
  verification: z.array(AnalysisVerificationCheckSchema),
  contractHash: Sha256Schema,
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema,
  activatedAt: IsoTimestampSchema.nullable(),
});
export type AnalysisProvenanceReceipt = z.infer<typeof AnalysisProvenanceReceiptSchema>;

export const AnalysisReceiptFailureSchema = z.strictObject({
  code: z.enum([
    "source_unavailable",
    "source_hash_changed",
    "source_verification_failed",
    "build_failed",
    "output_verification_failed",
    "activation_failed",
    "rebuild_interrupted",
  ]),
  message: z.string().min(1),
  failedAt: IsoTimestampSchema,
  checks: z.array(AnalysisVerificationCheckSchema),
});
export type AnalysisReceiptFailure = z.infer<typeof AnalysisReceiptFailureSchema>;

export const AnalysisReceiptSummarySchema = z.strictObject({
  generationId: z.string().min(1),
  generation: z.number().int().positive(),
  lifecycle: AnalysisReceiptLifecycleSchema,
  receiptSchemaVersion: z.string().min(1),
  completedAt: IsoTimestampSchema.nullable(),
  activatedAt: IsoTimestampSchema.nullable(),
});
export type AnalysisReceiptSummary = z.infer<typeof AnalysisReceiptSummarySchema>;

export const AnalysisStatusSchema = z.strictObject({
  status: AnalysisUserStatusSchema,
  staleReasons: z.array(AnalysisStaleReasonSchema),
  activeGeneration: AnalysisReceiptSummarySchema.nullable(),
  latestAttempt: AnalysisReceiptSummarySchema.nullable(),
  capability: AnalysisRebuildCapabilitySchema,
  receipt: AnalysisProvenanceReceiptSchema.nullable(),
  failure: AnalysisReceiptFailureSchema.nullable(),
});
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;

export const AnalysisRebuildPreviewSchema = z.strictObject({
  sessionId: z.number().int().positive(),
  status: AnalysisStatusSchema,
  selectedSource: PersistedEvidenceKindSchema,
  outputsReplaced: z.array(AnalysisArtifactTypeSchema),
  sourceAvailable: z.boolean(),
  capability: AnalysisRebuildCapabilitySchema,
  limitations: z.array(z.string()),
});
export type AnalysisRebuildPreview = z.infer<typeof AnalysisRebuildPreviewSchema>;
