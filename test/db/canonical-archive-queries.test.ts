import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import {
  CANONICAL_ARCHIVE_ALGORITHM_VERSION,
  CANONICAL_ARCHIVE_SCHEMA_VERSION,
} from "../../shared/racing/archives/contracts";
import {
  ANALYSIS_RECEIPT_SCHEMA_VERSION,
  type AnalysisProvenanceReceipt,
  type AnalysisVerificationCheck,
} from "../../shared/racing/provenance/contracts";
import { currentAnalysisContract } from "../../server/analysis-provenance/current-contract";
import { analysisContractHash } from "../../server/analysis-provenance/hash";
import { activateCanonicalArchiveReceipt } from "../../server/analysis-provenance/receipt";
import {
  getActiveVerifiedCanonicalArchive,
  getCanonicalArchiveLapReadPlan,
  getCanonicalArchiveRowRanges,
  insertCanonicalArchiveNodes,
} from "../../server/db/canonical-archive-queries";
import { db } from "../../server/db/index";
import { canonicalArchives, laps, sessions } from "../../server/db/schema";

const SOURCE_HASH = `sha256:${"a".repeat(64)}`;
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
const tempDirs: string[] = [];

afterEach(async () => {
  for (const sessionId of createdSessionIds) {
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  createdSessionIds.length = 0;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe("canonical archive queries", () => {
  test("resolves active archive by generation while keeping source and output hashes distinct", async () => {
    const session = await db.insert(sessions).values({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: "iracing",
      source: "native-live",
    }).returning({ id: sessions.id }).get();
    if (!session) throw new Error("Session insert returned no row");
    createdSessionIds.push(session.id);

    const lap = await db.insert(laps).values({
      sessionId: session.id,
      lapNumber: 1,
      lapTime: 90,
      sectorTimes: [30, 30, 30],
    }).returning({ id: laps.id }).get();
    if (!lap) throw new Error("Lap insert returned no row");

    const archiveBytes = Buffer.from("canonical archive query fixture");
    const outputHash = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
    const archiveDir = mkdtempSync(join(tmpdir(), "raceiq-canonical-query-"));
    tempDirs.push(archiveDir);
    const archivePath = join(archiveDir, "session.parquet");
    await Bun.write(archivePath, archiveBytes);

    const current = currentAnalysisContract("iracing");
    const analysisComponents = [
      ...current.analysisComponents,
      {
        id: "canonical-archive",
        version: CANONICAL_ARCHIVE_ALGORITHM_VERSION,
        schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
      },
    ].sort((left, right) => left.id.localeCompare(right.id));
    const contractHash = analysisContractHash({
      receiptSchemaVersion: ANALYSIS_RECEIPT_SCHEMA_VERSION,
      telemetryVersion: current.telemetryVersion,
      analysisComponents,
    });
    const archiveId = `canonical-archive:${session.id}`;
    const createdAt = "2026-08-24T00:00:00.000Z";
    const context = {
      gameId: "iracing",
      trackId: null,
      layoutId: null,
      trackDefinitionHash: null,
      cornerDefinitionHash: null,
      sourceKind: "raceiq-raw",
      sourcePath: null,
    };

    await activateCanonicalArchiveReceipt({
      sessionId: session.id,
      sourceContentHash: SOURCE_HASH,
      contractHash,
      configurationHash: current.configurationHash,
      buildReceipt: async (attempt): Promise<AnalysisProvenanceReceipt> => {
        await db.insert(canonicalArchives).values({
          archiveId,
          sessionId: session.id,
          generationId: attempt.generationId,
          status: "verified",
          archivePath,
          schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
          algorithmVersion: CANONICAL_ARCHIVE_ALGORITHM_VERSION,
          sourceContentHash: SOURCE_HASH,
          outputContentHash: outputHash,
          byteSize: archiveBytes.byteLength,
          sampleCount: 1,
          nodeCount: 1,
          semanticIds: ["motion.speed"],
          context,
          manifest: {
            archiveId,
            sessionId: session.id,
            generationId: attempt.generationId,
            gameId: "iracing",
            trackId: null,
            layoutId: null,
            sourceContentHash: SOURCE_HASH,
            telemetryVersion: current.telemetryVersion,
            schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
            algorithmVersion: CANONICAL_ARCHIVE_ALGORITHM_VERSION,
            rowCount: 1,
            nodeCount: 1,
            semanticIds: ["motion.speed"],
            eventIds: [],
            completeness: "complete",
            warnings: [],
            context,
            createdAt,
          },
          completeness: "complete",
          verification: {
            status: "passed",
            checks: [{ id: "output_hash", status: "passed", details: "fixture hash matched" }],
            verifiedAt: createdAt,
            details: null,
          },
          createdAt,
          verifiedAt: createdAt,
          failure: null,
        });
        await insertCanonicalArchiveNodes(archiveId, [{
          nodeId: `${archiveId}:lap:${lap.id}`,
          archiveId,
          parentNodeId: null,
          level: "lap",
          semanticKind: "lap",
          stableKey: `lap:${lap.id}`,
          ordinal: 0,
          participantId: "driver",
          sessionRunId: null,
          lapId: lap.id,
          startRow: 0,
          endRow: 1,
          startSourceTimeMs: 0,
          endSourceTimeMs: 1,
          startTrackDistanceM: 0,
          endTrackDistanceM: 1,
          status: "complete",
          definitionHash: null,
          boundaryAlgorithmVersion: "lap-boundary-v1",
        }]);

        return {
          receiptSchemaVersion: ANALYSIS_RECEIPT_SCHEMA_VERSION,
          generationId: attempt.generationId,
          artifactSetId: attempt.artifactSetId,
          artifactSetType: "canonical_archive",
          generation: attempt.generation,
          lifecycle: "active",
          sessionId: session.id,
          participantId: null,
          evidence: {
            kind: "raceiq-raw",
            originalSourceKind: "raceiq-raw",
            objectId: `session:${session.id}:raw-capture`,
            contentHash: SOURCE_HASH,
            byteSize: 12,
            formatVersion: "raceiq-session-framing-v1",
            recordCounts: { packets: 1 },
          },
          telemetryVersion: current.telemetryVersion,
          analysisComponents,
          configuration: {
            hash: current.configurationHash,
            effective: current.effectiveConfiguration as AnalysisProvenanceReceipt["configuration"]["effective"],
          },
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
            schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
            count: 1,
            contentHash: outputHash,
            timeCoverageMs: { start: 0, end: 1 },
            lapCoverage: { start: 1, end: 1 },
            participantCoverage: ["driver"],
            trackDistanceCoverageM: { start: 0, end: 1 },
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
          verification: CANONICAL_CHECK_IDS.map((id) => ({
            id,
            status: "passed" as const,
            details: "fixture verification passed",
          })),
          contractHash,
          startedAt: createdAt,
          completedAt: createdAt,
          activatedAt: createdAt,
        };
      },
    });

    expect(await getActiveVerifiedCanonicalArchive(session.id, { verifyOutput: true })).toMatchObject({
      archiveId,
      sourceContentHash: SOURCE_HASH,
      outputContentHash: outputHash,
    });
    expect(await getCanonicalArchiveRowRanges({ sessionId: session.id })).toHaveLength(1);
    expect(await getCanonicalArchiveLapReadPlan({ sessionId: session.id, lapId: lap.id })).toMatchObject({
      archiveId,
      sourceContentHash: SOURCE_HASH,
      outputContentHash: outputHash,
      lapId: lap.id,
      ranges: [expect.objectContaining({ nodeId: `${archiveId}:lap:${lap.id}` })],
    });
  });
});
