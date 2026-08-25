import { describe, expect, test, afterEach } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { eq, inArray } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  CANONICAL_ARCHIVE_ALGORITHM_VERSION,
  CANONICAL_ARCHIVE_SCHEMA_VERSION,
  CanonicalArchiveAvailabilitySchema,
  CanonicalArchiveNodeSchema,
  CanonicalArchiveSampleSchema,
} from "../../shared/racing/archives/contracts";
import { readCanonicalArchiveLapRanges, readCanonicalArchiveSamples } from "../../server/db/canonical-archive-reader";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { listCanonicalArchiveJobs, MAX_CANONICAL_ARCHIVE_JOB_ATTEMPTS, completeCanonicalArchiveJob, enqueueCanonicalArchiveJob, failCanonicalArchiveJob, claimCanonicalArchiveJob, heartbeatCanonicalArchiveJob, recoverInterruptedCanonicalArchives } from "../../server/db/canonical-archive-queries";
import { addCanonicalArchivePacketJsonBytesForTest, buildCanonicalArchive, canonicalArchiveDuckDbConfigForTest, setCanonicalArchiveBuildHookForTest, verifyCanonicalArchiveParquet } from "../../server/session-capture/canonical-archive";
import { inspectRawCaptureIdentity } from "../../server/session-capture/identity";
import { getSessionCanonicalAvailability } from "../../server/lap-analysis/canonical-archive-availability";
import { db } from "../../server/db/index";
import { analysisReceipts, canonicalArchives, sessions } from "../../server/db/schema";
import { enqueueStableCaptureJobs } from "../../server/runtime/startup-jobs";

const tempDirs: string[] = [];

initGameAdapters();
initServerGameAdapters();

const REAL_CAPTURE = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";

async function removeImportedCapture(sessionIds: number[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const imported = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(inArray(sessions.id, sessionIds)).all();
  const archives = await db.select({ archivePath: canonicalArchives.archivePath }).from(canonicalArchives).where(inArray(canonicalArchives.sessionId, sessionIds)).all();
  await db.delete(sessions).where(inArray(sessions.id, sessionIds)).run();
  for (const session of imported) if (session.rawFile) rmSync(session.rawFile, { force: true });
  for (const archive of archives) rmSync(dirname(archive.archivePath), { recursive: true, force: true });
}

async function seedRealCapture(): Promise<{ sessionId: number; rawFile: string; sessionIds: number[] }> {
  const dir = mkdtempSync(join(process.cwd(), ".data-archive-test-"));
  tempDirs.push(dir);
  const rawFile = join(dir, basename(REAL_CAPTURE));
  await Bun.write(rawFile, Buffer.from(await Bun.file(REAL_CAPTURE).arrayBuffer()));
  const [session] = await db.insert(sessions).values({
    carOrdinal: 1,
    trackOrdinal: 1,
    gameId: "fm-2023",
    sessionType: "practice",
    rawFile,
    source: "native-live",
  }).returning({ id: sessions.id });
  return { sessionId: session.id, rawFile, sessionIds: [session.id] };
}

async function claimCanonicalArchiveBuildLease(sessionId: number, sourceContentHash: string): Promise<{ jobId: string; leaseToken: string }> {
  const job = await enqueueCanonicalArchiveJob({ sessionId, sourceContentHash });
  const claim = await claimCanonicalArchiveJob({ jobId: job.jobId, leaseMs: 60_000 });
  if (claim?.jobId !== job.jobId || !claim.leaseToken) throw new Error("Canonical archive build job claim failed");
  return { jobId: claim.jobId, leaseToken: claim.leaseToken };
}

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
  test("streams aggregate packet JSON beyond the archive byte ceiling without materializing it", () => {
    const archiveBytes = 512 * 1024 * 1024;
    expect(addCanonicalArchivePacketJsonBytesForTest(archiveBytes, 1)).toBe(archiveBytes + 1);
    expect(() => addCanonicalArchivePacketJsonBytesForTest(2 * 1024 * 1024 * 1024, 1))
      .toThrow("streamed packet JSON byte limit");
  });
  test("uses bounded spill-capable DuckDB writer settings", () => {
    expect(canonicalArchiveDuckDbConfigForTest()).toEqual({
      writerMemoryLimit: "1GB",
      verifierMemoryLimit: "512MB",
      tempDirectoryLimit: "1GB",
      threads: 1,
      preserveInsertionOrder: false,
    });
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

  test("filters interleaved archive windows by participant and stable lap number", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".data-archive-test-"));
    tempDirs.push(dir);
    const path = join(dir, "interleaved.parquet");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run("CREATE TABLE telemetry_samples (sample_ordinal BIGINT, participant_id VARCHAR, lap_id INTEGER, lap_number INTEGER, source_time_ms BIGINT, received_at_ms BIGINT, track_distance_m DOUBLE, track_distance_pct DOUBLE, packet_json VARCHAR)");
      const appender = await connection.createAppender("telemetry_samples");
      for (const [ordinal, participantId, lapNumber] of [[0, "player", 4], [1, "other", 4], [2, "player", 5], [3, "player", 4]] as const) {
        appender.appendBigInt(BigInt(ordinal));
        appender.appendVarchar(participantId);
        appender.appendNull();
        appender.appendInteger(lapNumber);
        appender.appendBigInt(BigInt(ordinal));
        appender.appendBigInt(BigInt(ordinal));
        appender.appendNull();
        appender.appendNull();
        appender.appendVarchar(JSON.stringify({ gameId: "acc", ordinal }));
        appender.endRow();
      }
      appender.flushSync();
      appender.closeSync();
      await connection.run(`COPY telemetry_samples TO '${path.replaceAll("'", "''")}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    const [playerLapFour, playerLapFive] = await readCanonicalArchiveLapRanges(path, [
      {
        startRow: 0,
        endRow: 4,
        participantId: "player",
        lapNumber: 4,
      },
      {
        startRow: 0,
        endRow: 4,
        participantId: "player",
        lapNumber: 5,
      },
    ]);
    expect(playerLapFour.map((row) => row.sampleOrdinal)).toEqual([0, 3]);
    expect(playerLapFive.map((row) => row.sampleOrdinal)).toEqual([2]);
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
    const lease = await claimCanonicalArchiveBuildLease(session.id, `sha256:${"0".repeat(64)}`);
    await expect(buildCanonicalArchive({
      sessionId: session.id,
      sourceContentHash: `sha256:${"0".repeat(64)}`,
      ...lease,
    })).rejects.toThrow("source hash changed");
    expect(await Bun.file(rawPath).exists()).toBe(true);
  });
  test("builds canonical metadata from real recorded raw capture", async () => {
    const seeded = await seedRealCapture();
    try {
      const source = await inspectRawCaptureIdentity(seeded.rawFile);
      if (!source) throw new Error("Real raw capture disappeared");
      const job = await enqueueCanonicalArchiveJob({
        sessionId: seeded.sessionId,
        sourceContentHash: source.contentHash,
      });
      const expired = await claimCanonicalArchiveJob({ jobId: job.jobId, leaseMs: -1 });
      if (expired?.jobId !== job.jobId || !expired.leaseToken) throw new Error("Expired canonical archive job claim failed");
      await expect(buildCanonicalArchive({
        sessionId: seeded.sessionId,
        sourceContentHash: source.contentHash,
        jobId: expired.jobId,
        leaseToken: expired.leaseToken,
      })).rejects.toThrow("Canonical archive job lease lost");
      expect(await db.select().from(canonicalArchives).where(eq(canonicalArchives.sessionId, seeded.sessionId)).all()).toHaveLength(0);
      expect(await db.select().from(analysisReceipts).where(eq(analysisReceipts.sessionId, seeded.sessionId)).all()).toHaveLength(0);
      const replacement = await claimCanonicalArchiveJob({ jobId: job.jobId, leaseMs: 60_000 });
      if (replacement?.jobId !== job.jobId || !replacement.leaseToken) throw new Error("Replacement canonical archive job claim failed");
      const built = await buildCanonicalArchive({
        sessionId: seeded.sessionId,
        sourceContentHash: source.contentHash,
        jobId: replacement.jobId,
        leaseToken: replacement.leaseToken,
      });
      const receipt = built.receipt.receipt;
      if (!receipt) throw new Error("Canonical archive receipt was not activated");

      expect(built.archive).toMatchObject({
        status: "verified",
        completeness: "complete",
        sourceContentHash: source.contentHash,
        schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
      });
      expect(built.archive.outputContentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(built.archive.byteSize).toBeGreaterThan(0);
      expect(receipt.evidence).toMatchObject({
        kind: "raceiq-raw",
        objectId: `session:${seeded.sessionId}:raw-capture`,
        contentHash: source.contentHash,
        byteSize: source.byteSize,
        formatVersion: "raceiq-session-framing-v1",
      });
      expect(receipt.outputs).toContainEqual(expect.objectContaining({
        artifactType: "canonical_archive",
        contentHash: built.archive.outputContentHash,
        schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
      }));
      expect(await readCanonicalArchiveSamples(built.archive.archivePath, 0, 1)).toHaveLength(1);
      const instance = await DuckDBInstance.create(":memory:");
      const connection = await instance.connect();
      try {
        const physicalOrder = await connection.runAndReadAll(`SELECT sample_ordinal FROM read_parquet('${built.archive.archivePath.replaceAll("'", "''")}') LIMIT 3`);
        await physicalOrder.readAll();
        expect(physicalOrder.getRowsJS().map((row) => Number(row[0]))).toEqual(
          Array.from({ length: Math.min(3, built.archive.sampleCount) }, (_, index) => index),
        );
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
      const availability = CanonicalArchiveAvailabilitySchema.parse(await getSessionCanonicalAvailability(seeded.sessionId));
      expect(availability).toMatchObject({
        state: "available",
        archiveId: built.archive.archiveId,
        generationId: built.archive.generationId,
      });
    } finally {
      await removeImportedCapture(seeded.sessionIds);
    }
  }, 120_000);

  test("rejects source mutation after parsing without activating archive or deleting raw", async () => {
    const seeded = await seedRealCapture();
    const restoreHook = setCanonicalArchiveBuildHookForTest(async () => {
      const decoded = Buffer.from(gunzipSync(await Bun.file(seeded.rawFile).arrayBuffer()));
      await Bun.write(seeded.rawFile, gzipSync(Buffer.concat([decoded, Buffer.from([0])])));
    });
    try {
      const source = await inspectRawCaptureIdentity(seeded.rawFile);
      if (!source) throw new Error("Imported raw capture disappeared");
      const lease = await claimCanonicalArchiveBuildLease(seeded.sessionId, source.contentHash);
      await expect(buildCanonicalArchive({
        sessionId: seeded.sessionId,
        sourceContentHash: source.contentHash,
        ...lease,
      })).rejects.toThrow("source hash changed during build");

      expect(await Bun.file(seeded.rawFile).exists()).toBe(true);
      expect(await db.select().from(canonicalArchives).where(eq(canonicalArchives.sessionId, seeded.sessionId)).all())
        .toHaveLength(0);
      const availability = CanonicalArchiveAvailabilitySchema.parse(await getSessionCanonicalAvailability(seeded.sessionId));
      expect(availability.state).toBe("unavailable");
    } finally {
      restoreHook();
      await removeImportedCapture(seeded.sessionIds);
    }
  }, 120_000);
  test("rejects every expired lease mutation until replacement claim", async () => {
    const [session] = await db.insert(sessions).values({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: "acc",
      sessionType: "practice",
      rawFile: null,
      source: "native-live",
    }).returning({ id: sessions.id });
    const job = await enqueueCanonicalArchiveJob({
      sessionId: session.id,
      sourceContentHash: `sha256:${"3".repeat(64)}`,
    });
    const expired = await claimCanonicalArchiveJob({ jobId: job.jobId, leaseMs: -1 });
    if (expired?.jobId !== job.jobId || !expired.leaseToken) throw new Error("Expired job claim failed");
    await expect(heartbeatCanonicalArchiveJob({ jobId: job.jobId, leaseToken: expired.leaseToken })).resolves.toBeNull();
    await expect(completeCanonicalArchiveJob({ jobId: job.jobId, leaseToken: expired.leaseToken })).resolves.toBeNull();
    await expect(failCanonicalArchiveJob({
      jobId: job.jobId,
      leaseToken: expired.leaseToken,
      error: "expired worker",
      deterministic: true,
    })).resolves.toBeNull();
    const replacement = await claimCanonicalArchiveJob({ jobId: job.jobId, leaseMs: 60_000 });
    if (replacement?.jobId !== job.jobId || !replacement.leaseToken) throw new Error("Replacement job claim failed");
    await expect(completeCanonicalArchiveJob({
      jobId: job.jobId,
      leaseToken: replacement.leaseToken,
    })).resolves.toMatchObject({ status: "succeeded" });
  });

  test("preserves terminal failures, caps retries, and fences stale leases", async () => {
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
    const failedClaim = await claimCanonicalArchiveJob({ jobId: failed.jobId, leaseMs: 60_000 });
    expect(failedClaim?.jobId).toBe(failed.jobId);
    if (!failedClaim?.leaseToken) throw new Error("Claim did not return a lease token");
    const failedLeaseToken = failedClaim.leaseToken;
    expect(failedLeaseToken.length).toBeGreaterThan(0);
    await failCanonicalArchiveJob({
      jobId: failed.jobId,
      leaseToken: failedLeaseToken,
      error: "deterministic parser failure",
      deterministic: true,
    });
    const preserved = await enqueueCanonicalArchiveJob({ sessionId: session.id, sourceContentHash: sourceHash });
    expect(preserved.status).toBe("failed");
    expect(preserved.lastError).toBe("deterministic parser failure");

    const requeuedFailed = await enqueueCanonicalArchiveJob({
      sessionId: session.id,
      sourceContentHash: sourceHash,
      retryTerminal: true,
    });
    expect(requeuedFailed).toMatchObject({ status: "pending", lastError: null });
    const retried = await claimCanonicalArchiveJob({ jobId: failed.jobId, leaseMs: 60_000 });
    expect(retried?.jobId).toBe(failed.jobId);
    await completeCanonicalArchiveJob({
      jobId: failed.jobId,
      leaseToken: retried!.leaseToken!,
    });
    expect((await enqueueCanonicalArchiveJob({ sessionId: session.id, sourceContentHash: sourceHash })).status)
      .toBe("succeeded");
    const requeuedSucceeded = await enqueueCanonicalArchiveJob({
      sessionId: session.id,
      sourceContentHash: sourceHash,
      rebuildSucceeded: true,
    });
    expect(requeuedSucceeded.status).toBe("pending");

    const queued = await enqueueCanonicalArchiveJob({ sessionId: session.id, sourceContentHash: `sha256:${"2".repeat(64)}` });
    const claimed = await claimCanonicalArchiveJob({ jobId: requeuedSucceeded.jobId, leaseMs: 60_000 });
    expect(claimed?.jobId).toBe(requeuedSucceeded.jobId);
    await completeCanonicalArchiveJob({
      jobId: claimed!.jobId,
      leaseToken: claimed!.leaseToken!,
    });
    const nextClaimed = await claimCanonicalArchiveJob({ jobId: queued.jobId, leaseMs: 60_000 });
    expect(nextClaimed?.jobId).toBe(queued.jobId);
    expect(await heartbeatCanonicalArchiveJob({
      jobId: queued.jobId,
      leaseToken: nextClaimed!.leaseToken!,
    })).toMatchObject({ status: "running" });

    const staleLease = nextClaimed!.leaseToken!;
    const replacement = await claimCanonicalArchiveJob({
      jobId: queued.jobId,
      now: new Date(Date.now() + 61_000).toISOString(),
      leaseMs: 60_000,
    });
    expect(replacement?.jobId).toBe(queued.jobId);
    if (!replacement?.leaseToken) throw new Error("Replacement claim did not return a lease token");
    const replacementLeaseToken = replacement.leaseToken;
    expect(replacementLeaseToken.length).toBeGreaterThan(0);
    expect(replacementLeaseToken).not.toBe(staleLease);
    expect(await completeCanonicalArchiveJob({ jobId: queued.jobId, leaseToken: staleLease })).toBeNull();
    expect(await heartbeatCanonicalArchiveJob({ jobId: queued.jobId, leaseToken: staleLease })).toBeNull();

    let retryClaim = { ...replacement, leaseToken: replacementLeaseToken };
    for (let attempt = retryClaim.attemptCount; attempt < MAX_CANONICAL_ARCHIVE_JOB_ATTEMPTS; attempt += 1) {
      await failCanonicalArchiveJob({
        jobId: queued.jobId,
        leaseToken: retryClaim.leaseToken!,
        error: "transient archive failure",
        retryAt: new Date(Date.now() - 1_000).toISOString(),
      });
      const nextRetryClaim = await claimCanonicalArchiveJob({ jobId: queued.jobId, leaseMs: 60_000 });
      if (!nextRetryClaim?.leaseToken) throw new Error("Retry claim did not return a lease token");
      retryClaim = { ...nextRetryClaim, leaseToken: nextRetryClaim.leaseToken };
    }
    const exhausted = await failCanonicalArchiveJob({
      jobId: queued.jobId,
      leaseToken: retryClaim.leaseToken!,
      error: "transient archive failure",
      retryAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(exhausted).toMatchObject({ status: "failed", attemptCount: MAX_CANONICAL_ARCHIVE_JOB_ATTEMPTS });
  });
  test("same-size raw replacement persists new identity and queues replacement", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".data-archive-test-"));
    tempDirs.push(dir);
    const rawPath = join(dir, "session.bin");
    await Bun.write(rawPath, Buffer.from("aaaa"));
    const [session] = await db.insert(sessions).values({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: "acc",
      sessionType: "practice",
      rawFile: rawPath,
      source: "native-live",
    }).returning({ id: sessions.id });
    await enqueueStableCaptureJobs();
    const original = await listCanonicalArchiveJobs(session.id);
    expect(original).toHaveLength(1);

    await Bun.write(rawPath, Buffer.from("bbbb"));
    const changedAt = new Date(Date.now() + 2_000);
    await utimes(rawPath, changedAt, changedAt);
    await enqueueStableCaptureJobs();

    const replacement = await listCanonicalArchiveJobs(session.id);
    expect(replacement).toHaveLength(2);
    const changed = replacement.find((job) => job.sourceContentHash !== original[0]!.sourceContentHash);
    expect(changed).toBeDefined();
    const persisted = await db.select({
      contentHash: sessions.rawCaptureContentHash,
      fileSize: sessions.rawCaptureFileSize,
    }).from(sessions).where(eq(sessions.id, session.id)).get();
    expect(persisted).toMatchObject({
      contentHash: changed!.sourceContentHash,
      fileSize: 4,
    });
  });
  test("bad raw capture does not block later capture scheduling", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".data-archive-test-"));
    tempDirs.push(dir);
    const badPath = join(dir, "bad.bin.gz");
    const validPath = join(dir, "valid.bin");
    await Bun.write(badPath, Buffer.from([0x1f, 0x8b]));
    await Bun.write(validPath, Buffer.from("valid"));
    await db.insert(sessions).values({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: "acc",
      sessionType: "practice",
      rawFile: badPath,
      source: "native-live",
    });
    const [valid] = await db.insert(sessions).values({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: "acc",
      sessionType: "practice",
      rawFile: validPath,
      source: "native-live",
    }).returning({ id: sessions.id });

    await enqueueStableCaptureJobs();

    expect(await listCanonicalArchiveJobs(valid.id)).toHaveLength(1);
  });
  test("accepts source timestamp decreases while keeping sample ordinal order", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".data-archive-test-"));
    tempDirs.push(dir);
    const path = join(dir, "out-of-order.parquet");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run("CREATE TABLE telemetry_samples (sample_ordinal BIGINT, participant_id VARCHAR, lap_id INTEGER, lap_number INTEGER, source_time_ms BIGINT, received_at_ms BIGINT, track_distance_m DOUBLE, track_distance_pct DOUBLE, packet_json VARCHAR)");
      const appender = await connection.createAppender("telemetry_samples");
      appender.appendBigInt(0n); appender.appendNull(); appender.appendNull(); appender.appendInteger(1); appender.appendBigInt(200n); appender.appendBigInt(200n); appender.appendDouble(2.5); appender.appendNull(); appender.appendVarchar('{"gameId":"acc"}'); appender.endRow();
      appender.appendBigInt(1n); appender.appendNull(); appender.appendNull(); appender.appendInteger(1); appender.appendBigInt(100n); appender.appendBigInt(100n); appender.appendDouble(3.5); appender.appendNull(); appender.appendVarchar('{"gameId":"acc"}'); appender.endRow();
      appender.flushSync(); appender.closeSync();
      await connection.run(`COPY telemetry_samples TO '${path.replaceAll("'", "''")}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    await verifyCanonicalArchiveParquet(path, 2);
    expect((await readCanonicalArchiveSamples(path)).map((row) => [row.sampleOrdinal, row.sourceTimeMs])).toEqual([[0, 200], [1, 100]]);
  });

  test("recovers interrupted building archives before next retry", async () => {
    const session = await db.insert(sessions).values({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: "acc",
      sessionType: "practice",
      source: "native-live",
    }).returning({ id: sessions.id }).get();
    const archiveId = `canonical-archive:interrupted:${session.id}`;
    await db.insert(canonicalArchives).values({
      archiveId,
      sessionId: session.id,
      generationId: `generation:${session.id}`,
      status: "building",
      archivePath: join(process.cwd(), "missing-interrupted.parquet"),
      schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
      algorithmVersion: CANONICAL_ARCHIVE_ALGORITHM_VERSION,
      sourceContentHash: `sha256:${"3".repeat(64)}`,
      outputContentHash: null,
      byteSize: null,
      sampleCount: 0,
      nodeCount: 0,
      semanticIds: [],
      context: { gameId: "acc", trackId: null, layoutId: null, trackDefinitionHash: null, cornerDefinitionHash: null, sourceKind: "native-live", sourcePath: null },
      manifest: {} as typeof canonicalArchives.$inferInsert["manifest"],
      completeness: "empty",
      verification: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      verifiedAt: null,
      failure: null,
    });
    expect(await recoverInterruptedCanonicalArchives()).toBeGreaterThanOrEqual(1);
    const recovered = await db.select().from(canonicalArchives).where(eq(canonicalArchives.archiveId, archiveId)).get();
    expect(recovered).toMatchObject({ status: "failed", failure: "Canonical archive build was interrupted before activation" });
  });
});
