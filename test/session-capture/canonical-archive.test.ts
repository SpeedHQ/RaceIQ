import { describe, expect, test, afterEach } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  CANONICAL_ARCHIVE_ALGORITHM_VERSION,
  CANONICAL_ARCHIVE_SCHEMA_VERSION,
  CanonicalArchiveNodeSchema,
  CanonicalArchiveSampleSchema,
} from "../../shared/racing/archives/contracts";
import { readCanonicalArchiveSamples } from "../../server/db/canonical-archive-reader";
import { enqueueCanonicalArchiveJob, failCanonicalArchiveJob, claimCanonicalArchiveJob, heartbeatCanonicalArchiveJob } from "../../server/db/canonical-archive-queries";
import { buildCanonicalArchive } from "../../server/session-capture/canonical-archive";
import { db } from "../../server/db/index";
import { sessions } from "../../server/db/schema";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("canonical archive contracts", () => {
  test("accepts durable sample and hierarchy ranges", () => {
    const sample = CanonicalArchiveSampleSchema.parse({
      sampleOrdinal: 0,
      participantId: null,
      lapId: null,
      lapNumber: null,
      sourceTimeMs: 10,
      receivedAtMs: 10,
      trackDistanceM: 2.5,
      trackDistancePct: null,
      packetJson: '{"gameId":"acc"}',
    });
    const node = CanonicalArchiveNodeSchema.parse({
      nodeId: "node-1",
      archiveId: "archive-1",
      parentNodeId: null,
      level: "participant",
      semanticKind: "participant",
      stableKey: "unknown",
      ordinal: 0,
      participantId: null,
      sessionRunId: null,
      lapId: null,
      startRow: 0,
      endRow: 1,
      startSourceTimeMs: sample.sourceTimeMs,
      endSourceTimeMs: sample.sourceTimeMs,
      startTrackDistanceM: sample.trackDistanceM,
      endTrackDistanceM: sample.trackDistanceM,
      status: "complete",
      definitionHash: null,
      boundaryAlgorithmVersion: CANONICAL_ARCHIVE_ALGORITHM_VERSION,
    });
    expect(CANONICAL_ARCHIVE_SCHEMA_VERSION).toBe("canonical-archive-v1");
    expect(node.endRow).toBe(1);
  });

  test("reads compressed Parquet rows through production reader", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".data-archive-test-"));
    tempDirs.push(dir);
    const path = join(dir, "telemetry.parquet");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run("CREATE TABLE telemetry_samples (sample_ordinal BIGINT, participant_id VARCHAR, lap_id INTEGER, lap_number INTEGER, source_time_ms BIGINT, received_at_ms BIGINT, track_distance_m DOUBLE, track_distance_pct DOUBLE, packet_json VARCHAR)");
      const appender = await connection.createAppender("telemetry_samples");
      appender.appendBigInt(0n); appender.appendNull(); appender.appendNull(); appender.appendInteger(1); appender.appendBigInt(10n); appender.appendBigInt(10n); appender.appendDouble(2.5); appender.appendNull(); appender.appendVarchar('{"gameId":"acc"}'); appender.endRow();
      appender.flushSync(); appender.closeSync();
      await connection.run(`COPY telemetry_samples TO '${path.replaceAll("'", "''")}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    const rows = await readCanonicalArchiveSamples(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sampleOrdinal: 0, lapNumber: 1, packetJson: '{"gameId":"acc"}' });
  });

  test("source hash mismatch keeps raw capture untouched", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".data-archive-test-"));
    tempDirs.push(dir);
    const rawPath = join(dir, "session.bin");
    await Bun.write(rawPath, Buffer.from("raw capture"));
    const [session] = await db.insert(sessions).values({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: "acc",
      sessionType: "practice",
      rawFile: rawPath,
      source: "native-live",
    }).returning({ id: sessions.id });
    await expect(buildCanonicalArchive({ sessionId: session.id, sourceContentHash: `sha256:${"0".repeat(64)}` })).rejects.toThrow("source hash changed");
    expect(await Bun.file(rawPath).exists()).toBe(true);
  });
  test("preserves deterministic failures and renews claimed leases", async () => {
    const [session] = await db.insert(sessions).values({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: "acc",
      sessionType: "practice",
      rawFile: null,
      source: "native-live",
    }).returning({ id: sessions.id });
    const sourceHash = `sha256:${"1".repeat(64)}`;
    const failed = await enqueueCanonicalArchiveJob({ sessionId: session.id, sourceContentHash: sourceHash });
    const failedClaim = await claimCanonicalArchiveJob({ leaseMs: 60_000 });
    expect(failedClaim?.jobId).toBe(failed.jobId);
    await failCanonicalArchiveJob({ jobId: failed.jobId, error: "deterministic parser failure", deterministic: true });
    const preserved = await enqueueCanonicalArchiveJob({ sessionId: session.id, sourceContentHash: sourceHash });
    expect(preserved.status).toBe("failed");
    expect(preserved.lastError).toBe("deterministic parser failure");

    const queued = await enqueueCanonicalArchiveJob({ sessionId: session.id, sourceContentHash: `sha256:${"2".repeat(64)}` });
    const claimed = await claimCanonicalArchiveJob({ leaseMs: 60_000 });
    expect(claimed?.jobId).toBe(queued.jobId);
    const renewed = await heartbeatCanonicalArchiveJob(queued.jobId);
    expect(renewed?.status).toBe("running");
  });
});
