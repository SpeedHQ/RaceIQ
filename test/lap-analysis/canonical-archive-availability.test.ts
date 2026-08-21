import { afterEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { analysisReceipts, canonicalArchives, sessions } from "../../server/db/schema";
import { getActiveAnalysisReceipt } from "../../server/db/analysis-receipt-queries";
import { getSessionCanonicalAvailability } from "../../server/lap-analysis/canonical-archive-availability";
import { getQualityRebuildStatus } from "../../server/lap-analysis/quality-rebuild";
import { reprocessSession } from "../../server/session-capture/reprocess";
import { initServerGameAdapters } from "../../server/games/init";
import { initGameAdapters } from "../../shared/games/init";
import { evaluateEvidenceRetention } from "../../server/lap-analysis/evidence-retention";
import { qualityPackets } from "../support/lap-analysis/quality-model";

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

initGameAdapters();
initServerGameAdapters();

const createdSessionIds: number[] = [];
const createdDirectories: string[] = [];

afterEach(async () => {
  for (const sessionId of createdSessionIds) {
    await db.delete(analysisReceipts).where(eq(analysisReceipts.sessionId, sessionId)).run();
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }

  for (const directory of createdDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
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

function canonicalReceipt(
  sessionId: number,
  generationId: string,
  artifactSetId: string,
  generation: number,
  archiveId = `canonical-archive:${sessionId}`,
  outputContentHash = HASH_C,
  sampleCount = 1,
): AnalysisProvenanceReceipt {
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
      kind: "canonical-archive",
      originalSourceKind: "raceiq-raw",
      objectId: archiveId,
      contentHash: HASH_A,
      byteSize: 12,
      formatVersion: "canonical-archive-v1",
      recordCounts: { telemetry_samples: sampleCount, hierarchy_nodes: 0 },
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
      contentHash: outputContentHash,
      timeCoverageMs: { start: 0, end: 1 },
      lapCoverage: null,
      participantCoverage: null,
      trackDistanceCoverageM: null,
    }],
    canonicalInventory: {
      semanticIds: ["motion.speed"],
      eventIds: [],
      rowCounts: { frames: sampleCount },
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

async function writeCanonicalArchive(archivePath: string): Promise<{ bytes: Buffer; sampleCount: number }> {
  const packets = qualityPackets(3);
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("CREATE TABLE telemetry_samples (sample_ordinal BIGINT, participant_id VARCHAR, lap_id INTEGER, lap_number INTEGER, source_time_ms BIGINT, received_at_ms BIGINT, track_distance_m DOUBLE, track_distance_pct DOUBLE, packet_json VARCHAR)");
    const appender = await connection.createAppender("telemetry_samples");
    for (const [sampleOrdinal, packet] of packets.entries()) {
      appender.appendBigInt(BigInt(sampleOrdinal));
      appender.appendNull();
      appender.appendNull();
      appender.appendNull();
      appender.appendBigInt(BigInt(packet.TimestampMS));
      appender.appendBigInt(BigInt(packet.TimestampMS));
      appender.appendDouble(packet.DistanceTraveled ?? 0);
      appender.appendDouble(packet.iracing?.lapDistancePct ?? 0);
      appender.appendVarchar(JSON.stringify(packet));
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
    await connection.run(`COPY telemetry_samples TO '${archivePath.replaceAll("'", "''")}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return { bytes: Buffer.from(await Bun.file(archivePath).arrayBuffer()), sampleCount: packets.length };
}

describe("canonical archive availability", () => {
  test("requires durable canonical file matching active archive output", async () => {
    const session = await db
      .insert(sessions)
      .values({ carOrdinal: 1, trackOrdinal: 1, gameId: "iracing" })
      .returning({ id: sessions.id })
      .get();
    createdSessionIds.push(session.id);
    const directory = mkdtempSync(join(process.cwd(), ".data-archive-availability-test-"));
    createdDirectories.push(directory);
    const archivePath = join(directory, "telemetry.parquet");
    const { bytes, sampleCount } = await writeCanonicalArchive(archivePath);
    const outputContentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const archiveId = `canonical-archive:${session.id}`;

    await activateCanonicalArchiveReceipt({
      sessionId: session.id,
      sourceContentHash: HASH_A,
      contractHash: HASH_D,
      configurationHash: HASH_B,
      buildReceipt: async (attempt) => {
        await db.insert(canonicalArchives).values({
          archiveId,
          sessionId: session.id,
          generationId: attempt.generationId,
          status: "verified",
          archivePath,
          schemaVersion: "canonical-archive-v1",
          algorithmVersion: "canonical-archive-builder-v1",
          sourceContentHash: HASH_A,
          outputContentHash,
          byteSize: bytes.byteLength,
          sampleCount,
          nodeCount: 0,
          semanticIds: ["motion.speed"],
          context: { gameId: "iracing", trackId: null, layoutId: null, trackDefinitionHash: null, cornerDefinitionHash: null, sourceKind: "raceiq-raw", sourcePath: null },
          manifest: {
            archiveId,
            sessionId: session.id,
            generationId: attempt.generationId,
            gameId: "iracing",
            trackId: null,
            layoutId: null,
            sourceContentHash: HASH_A,
            telemetryVersion: TELEMETRY_VERSION,
            schemaVersion: "canonical-archive-v1",
            algorithmVersion: "canonical-archive-builder-v1",
            rowCount: sampleCount,
            nodeCount: 0,
            semanticIds: ["motion.speed"],
            eventIds: [],
            completeness: "complete",
            warnings: [],
            context: { gameId: "iracing", trackId: null, layoutId: null, trackDefinitionHash: null, cornerDefinitionHash: null, sourceKind: "raceiq-raw", sourcePath: null },
            createdAt: "2026-08-21T00:00:00.000Z",
          } as typeof canonicalArchives.$inferInsert["manifest"],
          completeness: "complete",
          verification: null,
          createdAt: "2026-08-21T00:00:00.000Z",
          verifiedAt: "2026-08-21T00:00:01.000Z",
          failure: null,
        });
        return canonicalReceipt(session.id, attempt.generationId, attempt.artifactSetId, attempt.generation, archiveId, outputContentHash, sampleCount);
      },
    });

    expect(await getSessionCanonicalAvailability(session.id)).toMatchObject({ state: "available" });
    expect(await getQualityRebuildStatus(session.id)).toMatchObject({
      action: "reprocess",
      rawAvailable: false,
      analysisStatus: {
        status: "stale_rebuild_available",
        capability: {
          mode: "limited",
          sourceKind: "canonical-archive",
        },
      },
    });
    const rebuild = await reprocessSession(session.id);
    expect(rebuild).toMatchObject({ sessionId: session.id });
    const rebuiltReceipt = await getActiveAnalysisReceipt({ sessionId: session.id, artifactSetType: "session_analysis" });
    expect(rebuiltReceipt?.receipt).toMatchObject({
      context: { gameId: "iracing" },
      evidence: {
        kind: "canonical-archive",
        originalSourceKind: "raceiq-raw",
        objectId: archiveId,
        contentHash: outputContentHash,
      },
      rebuildCapability: {
        mode: "limited",
        sourceKind: "canonical-archive",
      },
    });
    const rebuiltSession = await db
      .select({ rawFile: sessions.rawFile })
      .from(sessions)
      .where(eq(sessions.id, session.id))
      .get();
    expect(rebuiltSession?.rawFile).toBeNull();
    writeFileSync(archivePath, Buffer.alloc(bytes.byteLength, 0x5a));
    await db
      .update(sessions)
      .set({ qualityConfigVersion: "stale-config" })
      .where(eq(sessions.id, session.id))
      .run();
    const availability = await getSessionCanonicalAvailability(session.id);
    expect(availability).toEqual({
      state: "unavailable",
      semanticIds: [],
      eventIds: [],
      provenance: null,
      details: "Canonical archive row, file, or output hash is unavailable",
    });
    await expect(reprocessSession(session.id)).rejects.toThrow("canonical archive unavailable");
    expect(await getQualityRebuildStatus(session.id)).toMatchObject({
      action: "unavailable",
      rawAvailable: false,
      analysisStatus: {
        status: "current",
        capability: {
          mode: "unavailable",
        },
      },
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
