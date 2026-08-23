import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecisionSet,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import { QUALITY_POLICY_CONFIG_V1 } from "../../shared/racing/quality/policies";
import {
  ANALYSIS_RECEIPT_SCHEMA_VERSION,
  type AnalysisProvenanceReceipt,
  type AnalysisVerificationCheck,
} from "../../shared/racing/provenance/contracts";
import { activateCanonicalArchiveReceipt } from "../../server/analysis-provenance/receipt";
import { analysisConfigurationHash, analysisContractHash } from "../../server/analysis-provenance/hash";
import { db } from "../../server/db";
import { analysisReceipts, sessions } from "../../server/db/schema";
import { getSessionCanonicalAvailability } from "../../server/lap-analysis/canonical-archive-availability";
import { evaluateEvidenceRetention } from "../../server/lap-analysis/evidence-retention";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const TELEMETRY_VERSION = {
  catalogVersion: "catalog",
  catalogHash: "catalog-hash",
  catalogSchemaVersion: "1",
  parserVersion: "parser",
  resolverVersion: "resolver",
  derivationVersion: "derivation",
};
const ANALYSIS_COMPONENTS = [{ id: "canonical-archive", version: "1", schemaVersion: "1" }];
const EFFECTIVE_CONFIGURATION = { canonical: true };
const HASH_B = analysisConfigurationHash(EFFECTIVE_CONFIGURATION);
const HASH_D = analysisContractHash({
  receiptSchemaVersion: ANALYSIS_RECEIPT_SCHEMA_VERSION,
  telemetryVersion: TELEMETRY_VERSION,
  analysisComponents: ANALYSIS_COMPONENTS,
});
const CANONICAL_CHECK_IDS = [
  "source_hash",
  "schema_supported",
  "session_identity",
  "ordering",
  "coverage",
  "channel_inventory",
  "partitions_readable",
  "analyse_read",
  "compare_read",
  "storage_state",
] as const satisfies readonly AnalysisVerificationCheck["id"][];

const createdSessionIds: number[] = [];

afterEach(async () => {
  for (const sessionId of createdSessionIds) {
    await db.delete(analysisReceipts).where(eq(analysisReceipts.sessionId, sessionId)).run();
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }

  createdSessionIds.length = 0;
});

function currentEligibility(): EligibilityDecisionSet {
  return Object.fromEntries(
    Object.keys(QUALITY_POLICY_CONFIG_V1.requiredChannels).map((policyId) => [
      policyId,
      {
        status: "eligible" as const,
        policyId,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        confidence: { level: "high" as const, score: 1 },
        reasons: [],
        evidenceIds: [],
      },
    ]),
  ) as unknown as EligibilityDecisionSet;
}

function canonicalReceipt(sessionId: number, generationId: string, artifactSetId: string, generation: number): AnalysisProvenanceReceipt {
  const completedAt = "2026-08-21T00:00:01.000Z";
  return {
    receiptSchemaVersion: ANALYSIS_RECEIPT_SCHEMA_VERSION,
    generationId,
    artifactSetId,
    artifactSetType: "canonical_archive",
    generation,
    lifecycle: "active",
    sessionId,
    participantId: null,
    evidence: {
      kind: "raceiq-raw",
      originalSourceKind: "raceiq-raw",
      objectId: `session:${sessionId}:raw-capture`,
      contentHash: HASH_A,
      byteSize: 12,
      formatVersion: "raceiq-session-framing-v1",
      recordCounts: { packets: 1 },
    },
    telemetryVersion: TELEMETRY_VERSION,
    analysisComponents: ANALYSIS_COMPONENTS,
    configuration: { hash: HASH_B, effective: EFFECTIVE_CONFIGURATION },
    context: {
      gameId: "iracing",
      trackId: null,
      layoutId: null,
      trackDefinitionHash: null,
      cornerDefinitionHash: null,
    },
    sourceFidelity: { profileVersion: null, decisions: [] },
    outputs: [{
      name: "canonical archive",
      artifactType: "canonical_archive",
      schemaVersion: "canonical-archive-v1",
      count: 1,
      contentHash: HASH_C,
      timeCoverageMs: { start: 0, end: 1 },
      lapCoverage: null,
      participantCoverage: null,
      trackDistanceCoverageM: null,
    }],
    canonicalInventory: {
      semanticIds: ["motion.speed"],
      eventIds: [],
      rowCounts: { frames: 1 },
    },
    warnings: [],
    unsupportedFields: [],
    rebuildCapability: {
      mode: "exact",
      sourceKind: "raceiq-raw",
      rebuildableArtifacts: ["canonical_archive"],
      unavailableArtifacts: [],
      limitations: [],
    },
    verification: CANONICAL_CHECK_IDS.map((id) => ({ id, status: "passed" as const, details: "receipt metadata" })),
    contractHash: HASH_D,
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt,
    activatedAt: completedAt,
  };
}

describe("canonical archive availability", () => {
  test("does not make raw cleanup eligible from receipt-only canonical metadata", async () => {
    const session = await db
      .insert(sessions)
      .values({ carOrdinal: 1, trackOrdinal: 1, gameId: "iracing" })
      .returning({ id: sessions.id })
      .get();
    createdSessionIds.push(session.id);

    await activateCanonicalArchiveReceipt({
      sessionId: session.id,
      sourceContentHash: HASH_A,
      contractHash: HASH_D,
      configurationHash: HASH_B,
      buildReceipt: async (attempt) => canonicalReceipt(session.id, attempt.generationId, attempt.artifactSetId, attempt.generation),
    });

    const availability = await getSessionCanonicalAvailability(session.id);
    expect(availability).toEqual({
      state: "unavailable",
      semanticIds: [],
      eventIds: [],
      provenance: null,
      details: "Canonical archive receipt metadata exists, but no storage reader can verify bytes or inventory",
    });
    if (!availability) throw new Error("Expected canonical archive availability");
    const quality = {
      provenance: {
        schemaVersion: QUALITY_SCHEMA_VERSION,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        configurationVersion: QUALITY_CONFIG_VERSION,
        sourceGeneration: HASH_A,
        outputGeneration: HASH_C,
      },
    } as LapQualitySummary;
    expect(evaluateEvidenceRetention(session.id, { rawCapture: true, canonicalArchive: availability }, [{
      id: 1,
      eligibility: currentEligibility(),
      quality,
      qualityGeneration: HASH_C,
    }])).toMatchObject({
      action: "retain_raw",
      canDeleteRaw: false,
    });
  });
});
