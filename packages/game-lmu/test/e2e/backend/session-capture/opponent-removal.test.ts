import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { deleteLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { getLapReplaySource } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { recoverPendingOpponentRemovalCleanup, startSessionOpponentRemoval, getSessionOpponentRemovalStatus, previewSessionOpponentRemoval } from "@raceiq/backend-core/session-capture/opponent-removal";
import { readLmuOpponentRetention } from "@raceiq/backend-core/session-capture/lmu-companion";
import { getRecordingMaintenanceController } from "@raceiq/backend-core/session-capture/maintenance-runtime";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { encodeFrameLength, encodeMetaFrame, encodeSparseCaptureFormatFrame, iterateSessionCaptureRecords, SESSION_SEGMENT_BOUNDARY } from "@raceiq/capture-formats/session/framing";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "@raceiq/backend-core/session-capture/source-loader";
import { decodeLMUPartitionPrimary, isLMUPartitionPrimary, partitionLMUSourceFrame } from "@raceiq/capture-formats/lmu/partition";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";
import { isLmuSparseFrame } from "@raceiq/capture-formats/session/lmu-sparse";
import { decodeLMUSourceFrame, encodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_GAME_VERSION_OFFSET, LMU_SCORING_INFO, LMU_SCORING_INFO_OFFSET, LMU_SCORING_VEHICLE, LMU_SCORING_VEHICLE_SIZE, LMU_SCORING_VEHICLES_OFFSET, LMU_SESSION_EVENT_OFFSET, LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY, LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET } from "@raceiq/capture-formats/lmu/layout";
import { eq, inArray } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { importSessionFrames } from "@raceiq/backend-core/session-capture/import-pipeline";
import { reconcileLmuOpponentIndexes, getLmuOpponentIndexStatus } from "@raceiq/backend-core/session-capture/lmu-opponent-index-runtime";
import { inventoryLmuOpponentIndex } from "@raceiq/backend-core/lap-analysis/lmu-opponent-index";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import { registerDriverProfileLapNotifier } from "@raceiq/backend-core/driver-profile/lap-notifier";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { buildLapsZip, importLapsZip } from "@raceiq/backend/test-support/lap-archive";
import { initServerGameAdapters } from "@raceiq/backend/test-support/games";

initGameAdapters();
initServerGameAdapters();
registerDriverProfileLapNotifier(() => {});

const directories: string[] = [];
const sessionIds: number[] = [];


afterEach(async () => {
  for (const sessionId of sessionIds.splice(0)) await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("LMU opponent removal lifecycle", () => {
  test("rewrites sparse legacy v2/v3 gzip input with lap identity and physical offsets intact", async () => {
    const sourceFrames = [...iterateSessionCaptureRecords(gunzipSync(readFileSync("packages/game-lmu/test/fixtures/sessions/lmu-real-opponents-grid-2026-10-22.bin.gz")), 0, { strict: true })].filter((record) => record.kind === "frame").slice(0, 2).map((record) => record.frame);
    const frames = [0, 0, 1, 1].map((sourceIndex, index) => {
      const original = decodeLMUSourceFrame(sourceFrames[sourceIndex]!)!;
      const memory = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
      memory.writeInt32LE(original.gameVersion, LMU_GAME_VERSION_OFFSET);
      memory.writeUInt32LE(original.sessionEvent, LMU_SESSION_EVENT_OFFSET);
      memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET);
      memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);
      original.telemetry.copy(memory, LMU_TELEMETRY_INFO_OFFSET);
      original.scoringInfo.copy(memory, LMU_SCORING_INFO_OFFSET);
      original.playerScoring!.copy(memory, LMU_SCORING_VEHICLES_OFFSET);
      const playerId = original.telemetry.readInt32LE(LMU_TELEMETRY.id);
      memory.writeInt32LE(2, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
      memory.writeUInt8(1, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.isPlayer);
      const opponentOffset = LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE_SIZE;
      original.playerScoring!.copy(memory, opponentOffset);
      memory.writeInt32LE(playerId + 1000, opponentOffset + LMU_SCORING_VEHICLE.id);
      memory.writeUInt8(0, opponentOffset + LMU_SCORING_VEHICLE.isPlayer);
      memory.write("ControlledOpponent485", opponentOffset + LMU_SCORING_VEHICLE.driverName);
      if (index === 3) {
        memory.writeDoubleLE(0, opponentOffset + LMU_SCORING_VEHICLE.lapDistance);
        memory.writeDoubleLE(0, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.lapDistance);
      }
      return encodeLMUSourceFrame(memory, original.captureTimestampMs + index, index === 2 ? { context: {
        schemaVersion: 1, status: "active", playerVehicleId: playerId, supplemental: [],
        key: { sessionKey: "legacy-removal-fixture", captureSequence: String(index), frameTime: { domain: "wall-clock", milliseconds: original.captureTimestampMs + index } },
      } } : undefined)!;
    });
    expect(frames).toHaveLength(4);
    for (const frame of frames) expect(partitionLMUSourceFrame(frame)?.companion).toBeInstanceOf(Buffer);
    const directory = join(resolveRecordingDirectory(), "lmu", `opponent-removal-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    directories.push(directory);
    const sourcePath = join(directory, "legacy.bin.gz");
    const meta = encodeMetaFrame(frames.length);
    const format = encodeSparseCaptureFormatFrame();
    const sparse = new SparseCaptureEncoder("lmu");
    let inputOffset = meta.length + format.length;
    const records = frames.map((frame, index) => {
      const encoded = sparse.encode(frame, inputOffset);
      if (index === 1) expect(isLmuSparseFrame(encoded)).toBe(true);
      const record = encodeFrameLength(encoded.length);
      inputOffset += record.length + encoded.length;
      return Buffer.concat([record, encoded]);
    });
    writeFileSync(sourcePath, gzipSync(Buffer.concat([meta, format, ...records])));
    expect(await readLmuOpponentRetention(sourcePath)).toMatchObject({ opponentRetention: "retained", opponentAvailability: "incomplete" });
    expect(isLmuSparseFrame(records[1]!.subarray(encodeFrameLength(0).length))).toBe(true);
    const session = await db.insert(sessions).values({ gameId: "lmu", carId: "1", trackId: "1", rawFile: sourcePath }).returning({ id: sessions.id }).get();
    const originalCompressedBytes = readFileSync(sourcePath).length;
    sessionIds.push(session.id);
    const lap = await db.insert(laps).values({
      sessionId: session.id, lapNumber: 1, lapTime: 90, rawByteOffset: meta.length + format.length, rawFrameCount: 3,
    }).returning({ id: laps.id }).get();
    const preview = await previewSessionOpponentRemoval({ sessionIds: [session.id] });
    expect(preview.rewriteSessionIds).toEqual([session.id]);

    const maintenance = getRecordingMaintenanceController();
    const fibersBeforeRemoval = new Set(maintenance.fibers);
    await startSessionOpponentRemoval({ sessionIds: [session.id] });
    await Promise.all([...maintenance.fibers].filter(fiber => !fibersBeforeRemoval.has(fiber)).map(fiber => {
      const { promise, resolve } = Promise.withResolvers<void>();
      fiber.addObserver(() => resolve());
      return promise;
    }));
    expect(getSessionOpponentRemovalStatus()).toMatchObject({ status: "success", removedSessionIds: [session.id], cleanupPendingSessionIds: [] });
    expect(existsSync(sourcePath)).toBe(false);
    const updated = await db.select({ rawFile: sessions.rawFile, captureManifestFile: sessions.captureManifestFile, captureLayoutVersion: sessions.captureLayoutVersion }).from(sessions).where(eq(sessions.id, session.id)).get();
    expect(updated?.rawFile).toBe(updated?.captureManifestFile);
    expect(updated?.captureLayoutVersion).toBe(1);
    const manifest = JSON.parse(await readFile(updated!.captureManifestFile!, "utf8")) as { opponentRetention: string; cleanupPending: string[]; chunks: Array<{ id: string; lapId?: string; ownedFrameByteOffset?: number; ownedFrameCount?: number; trailingContextFrameCount?: number; byteLength: number; path: string }> };
    expect(manifest.opponentRetention).toBe("removed");
    expect(manifest.cleanupPending).toEqual([]);
    expect(getSessionOpponentRemovalStatus().freedBytes).toBe(Math.max(0, originalCompressedBytes - manifest.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)));
    const lapChunk = manifest.chunks.find((chunk) => chunk.lapId === String(lap.id));
    expect(lapChunk).toMatchObject({ ownedFrameCount: 3, trailingContextFrameCount: 1 });
    expect((await db.select({ rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount, captureChunkId: laps.captureChunkId }).from(laps).where(eq(laps.id, lap.id)).get())).toMatchObject({
      rawByteOffset: meta.length + format.length, rawFrameCount: 3, captureChunkId: lapChunk!.id,
    });
    let rewrittenFrames = 0;
    for (const chunk of manifest.chunks) {
      const bytes = readFileSync(join(directory, chunk.path));
      for (const record of iterateSessionCaptureRecords(bytes, 0, { strict: true })) {
        if (record.kind !== "frame") continue;
        expect(isLMUPartitionPrimary(record.frame)).toBe(true);
        const original = decodeLMUSourceFrame(frames[rewrittenFrames]!);
        const player = decodeLMUPartitionPrimary(record.frame);
        expect(player).not.toBeNull();
        expect(player!.telemetry).toEqual(original!.telemetry);
        expect(player!.scoringInfo).toEqual(original!.scoringInfo);
        expect(player!.playerScoring).toEqual(original!.playerScoring);
        rewrittenFrames++;
      }
    }
    expect(rewrittenFrames).toBe(4);
    const logicalSource: SessionCaptureSource = {
      rawFile: updated!.captureManifestFile!, source: null, gameId: "lmu", carId: "1", trackId: "1", captureFormatVersion: 1,
    };
    let logicalOffset = meta.length;
    let logicalFrameIndex = 0;
    for await (const record of iterateSessionCaptureRecordsFromSource(logicalSource, { strict: true })) {
      if (record.kind !== "frame") continue;
      expect(record.offset).toBe(logicalOffset);
      const expectedFrameIndex = logicalFrameIndex < 3 ? logicalFrameIndex : 3;
      expect(decodeLMUSourceFrame(record.frame)?.lmuContext).toEqual(decodeLMUSourceFrame(frames[expectedFrameIndex]!)?.lmuContext);
      const logicalLength = encodeFrameLength(frames[expectedFrameIndex]!.length).length + frames[expectedFrameIndex]!.length;
      logicalOffset += logicalLength;
      logicalFrameIndex++;
    }
    expect(logicalFrameIndex).toBe(4);
    const exported = await buildLapsZip([lap.id]);
    const imported = await importLapsZip(exported.bytes);
    expect(imported.errors).toEqual([]);
    expect(imported.laps).toHaveLength(1);
    const roundTrippedLap = await db.select().from(laps).where(eq(laps.id, imported.laps[0]!.lapId)).get();
    expect(roundTrippedLap).toMatchObject({ lapNumber: 1, rawFrameCount: 3 });
    const roundTrippedSession = await db.select().from(sessions).where(eq(sessions.id, imported.laps[0]!.sessionId)).get();
    expect(roundTrippedSession?.rawFile).toBeTruthy();
    const roundTrippedSource: SessionCaptureSource = {
      rawFile: roundTrippedSession!.captureManifestFile ?? roundTrippedSession!.rawFile!,
      source: null,
      gameId: "lmu",
      carId: roundTrippedSession!.carId,
      trackId: roundTrippedSession!.trackId,
      captureFormatVersion: roundTrippedSession!.captureLayoutVersion,
    };
    const roundTrippedFrames: Buffer[] = [];
    for await (const record of iterateSessionCaptureRecordsFromSource(roundTrippedSource, { strict: true })) {
      if (record.kind === "frame") roundTrippedFrames.push(record.frame);
    }
    expect(roundTrippedFrames).toHaveLength(4);
    const roundTrippedPrimaries = roundTrippedFrames.map((frame) => decodeLMUPartitionPrimary(frame)!);
    expect(roundTrippedPrimaries.every(Boolean)).toBe(true);
    expect(roundTrippedPrimaries[3]!.scoringInfo.readDoubleLE(LMU_SCORING_INFO.lapDistance))
      .toBeLessThan(roundTrippedPrimaries[2]!.scoringInfo.readDoubleLE(LMU_SCORING_INFO.lapDistance));
    expect(roundTrippedFrames.some((frame) => frame.includes(Buffer.from("ControlledOpponent485")))).toBe(false);
    expect(await readLmuOpponentRetention(updated!.captureManifestFile!)).toMatchObject({ opponentRetention: "removed", opponentAvailability: null });
    expect(await recoverPendingOpponentRemovalCleanup()).toBe(0);
    expect(existsSync(sourcePath)).toBe(false);
  });

  test("restart recovery retries durable cleanup and remains idempotent", async () => {
    const directory = join(resolveRecordingDirectory(), "lmu", `opponent-cleanup-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    directories.push(directory);
    const manifestPath = join(directory, "capture-manifest.json");
    const pendingPath = join(directory, "stale-opponents.bin");
    writeFileSync(pendingPath, Buffer.from("stale opponent data"));
    const manifest = {
      version: 3, gameId: "lmu", sourceRevision: crypto.randomUUID(), sourceByteLength: 12, sourceRecordCount: 0,
      opponentRetention: "removed", cleanupPending: ["stale-opponents.bin"], chunks: [],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const session = await db.insert(sessions).values({
      gameId: "lmu", carId: "1", trackId: "1", rawFile: manifestPath,
      captureManifestFile: manifestPath, captureLayoutVersion: 1,
    }).returning({ id: sessions.id }).get();
    sessionIds.push(session.id);

    expect(await recoverPendingOpponentRemovalCleanup()).toBe(1);
    expect(await recoverPendingOpponentRemovalCleanup()).toBe(0);
    expect(existsSync(pendingPath)).toBe(false);
    const saved = JSON.parse(readFileSync(manifestPath, "utf8")) as { cleanupPending: string[] };
    expect(saved.cleanupPending).toEqual([]);
  });

  test("cleanup recovery preserves shared player files until their last reference is removed", async () => {
    const directory = join(resolveRecordingDirectory(), "lmu", `opponent-protected-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    directories.push(directory);
    const manifestPath = join(directory, "capture-manifest.json");
    const playerPath = join(directory, "player.bin");
    const playerBytes = Buffer.from("player capture must remain unchanged");
    writeFileSync(playerPath, playerBytes);
    writeFileSync(manifestPath, JSON.stringify({
      version: 3, gameId: "lmu", sourceRevision: crypto.randomUUID(), sourceByteLength: 12, sourceRecordCount: 0,
      opponentRetention: "removed", cleanupPending: ["player.bin"], chunks: [],
    }));
    const removed = await db.insert(sessions).values({
      gameId: "lmu", carId: "1", trackId: "1", rawFile: manifestPath, captureManifestFile: manifestPath, captureLayoutVersion: 1,
    }).returning({ id: sessions.id }).get();
    const retained = await db.insert(sessions).values({
      gameId: "lmu", carId: "1", trackId: "1", rawFile: playerPath,
    }).returning({ id: sessions.id }).get();
    sessionIds.push(removed.id, retained.id);
    expect(await recoverPendingOpponentRemovalCleanup()).toBe(0);
    expect(readFileSync(playerPath)).toEqual(playerBytes);
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).cleanupPending).toEqual(["player.bin"]);
    await db.delete(sessions).where(eq(sessions.id, retained.id)).run();
    expect(await recoverPendingOpponentRemovalCleanup()).toBe(1);
    expect(await recoverPendingOpponentRemovalCleanup()).toBe(0);
    expect(existsSync(playerPath)).toBe(false);
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).cleanupPending).toEqual([]);
  });
});
