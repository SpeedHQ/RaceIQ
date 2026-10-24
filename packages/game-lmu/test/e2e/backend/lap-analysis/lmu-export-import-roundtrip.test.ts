import { afterEach, describe, expect, test } from "bun:test";
import { db } from "@raceiq/backend-core/db/index";
import { gzipSync, gunzipSync } from "node:zlib";
import { rmSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { unzipSync, zipSync } from "fflate";
import { sessions, laps } from "@raceiq/backend-core/db/schema";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "@raceiq/backend/test-support/games";
import { fixtureFrames } from "@raceiq/backend/test-support/fixture-frames";
import { importSessionFrames } from "@raceiq/backend-core/session-capture/import-pipeline";
import { parseRawLapFrames } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { queryLapTelemetryBySemanticId } from "@raceiq/backend-core/telemetry/replay";
import { buildLapsZip, importLapsZip } from "@raceiq/backend/test-support/lap-archive";
import { decodeLMUSourceFrame, encodeLMUSourceFrame, LMU_MAX_SOURCE_FRAME_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { encodeLmuSparseFrame } from "@raceiq/capture-formats/session/lmu-sparse";
import { LMU_SHARED_MEMORY_SIZE, LMU_GAME_VERSION_OFFSET, LMU_SESSION_EVENT_OFFSET, LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET, LMU_TELEMETRY, LMU_SCORING_INFO, LMU_SCORING_INFO_OFFSET, LMU_SCORING_VEHICLE, LMU_SCORING_VEHICLES_OFFSET } from "@raceiq/capture-formats/lmu/layout";
import type { LmuLiveContext } from "@raceiq/shared/telemetry/lmu";
import { encodeLmuContext } from "@raceiq/shared/telemetry/lmu-context";
import { importSessionBin } from "@raceiq/backend-core/session-capture/import-capture";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import { readLmuOpponentCaptureFrames, indexLmuOpponentLaps } from "@raceiq/backend-core/lap-analysis/lmu-opponent-laps";
import { readLmuOpponentRetention } from "@raceiq/backend-core/session-capture/lmu-companion";
import { registerDriverProfileLapNotifier } from "@raceiq/backend-core/driver-profile/lap-notifier";
import { replayRoutes } from "@raceiq/lap-replay/server";
import { decodeSemanticLapTelemetry, SEMANTIC_REPLAY_MEDIA_TYPE } from "@raceiq/lap-replay/contracts";
import { resolveLapCaptureArtifact } from "@raceiq/backend-core/session-capture/source-loader";
import { createHash } from "node:crypto";

initGameAdapters();
initServerGameAdapters();
registerDriverProfileLapNotifier(() => {});

describe("LMU lap export/import round-trip", () => {
  const createdSessions: number[] = [];
  const tmpFiles: string[] = [];
  afterEach(async () => {
    if (createdSessions.length) {
      await db.delete(laps).where(inArray(laps.sessionId, createdSessions)).run();
      await db.delete(sessions).where(inArray(sessions.id, createdSessions)).run();
    }
    createdSessions.length = 0;
    for (const file of tmpFiles) rmSync(file, { force: true });
    tmpFiles.length = 0;
  });

  test("compact replay preserves every 100 Hz native sample and leaves split capture bytes unchanged", async () => {
    const imported = await importSessionBin(makeLmuOpponentCapture({ frequencyHz: 100 }), "lmu", { notifyDriverProfile: false });
    createdSessions.push(...new Set(imported.laps.map((lap) => lap.sessionId)));
    const player = imported.laps.find((lap) => lap.lapNumber === 3)!;
    const session = (await db.select().from(sessions).where(eq(sessions.id, player.sessionId)).get())!;
    const row = (await db.select().from(laps).where(eq(laps.id, player.lapId)).get())!;
    const artifact = await resolveLapCaptureArtifact(session.captureManifestFile!, row.captureChunkId!, row.id);
    const before = createHash("sha256").update(await Bun.file(artifact.path).bytes()).digest("hex");
    const expandedResponse = await replayRoutes.request(`/api/laps/${row.id}/semantic-telemetry`, { headers: { "X-Game-Id": "lmu" } });
    expect(expandedResponse.status).toBe(200);
    const expanded = decodeSemanticLapTelemetry(await expandedResponse.json());
    const compactResponse = await replayRoutes.request(`/api/laps/${row.id}/semantic-telemetry`, {
      headers: { "X-Game-Id": "lmu", Accept: SEMANTIC_REPLAY_MEDIA_TYPE },
    });
    expect(compactResponse.status).toBe(200);
    expect(compactResponse.headers.get("Content-Type")).toContain(SEMANTIC_REPLAY_MEDIA_TYPE);
    const decoded = decodeSemanticLapTelemetry(await compactResponse.json());
    expect(decoded).toEqual(expanded);
    expect(decoded.envelopes.length).toBe(row.rawFrameCount!);
    for (let index = 1; index < decoded.envelopes.length; index++) {
      expect(decoded.envelopes[index]!.observedAt.milliseconds - decoded.envelopes[index - 1]!.observedAt.milliseconds).toBe(10);
    }
    expect(createHash("sha256").update(await Bun.file(artifact.path).bytes()).digest("hex")).toBe(before);
  }, 120_000);

  test("retained LMU ordinary and selected opponent exports preserve exact companion-backed intervals", async () => {
    const sourceImport = await importSessionBin(makeLmuOpponentCapture(), "lmu", { notifyDriverProfile: false });
    const sessionIds = [...new Set(sourceImport.laps.map((lap) => lap.sessionId))];
    createdSessions.push(...sessionIds);
    const player = sourceImport.laps.find((lap) => lap.lapNumber === 3)!;
    expect(player).toBeDefined();
    const session = await db.select().from(sessions).where(eq(sessions.id, player.sessionId)).get();
    expect(session?.rawFile).toBeTruthy();
    const source = { rawFile: session!.captureManifestFile ?? session!.rawFile!, source: session!.source, gameId: "lmu" as const, carId: session!.carId ?? "", trackId: session!.trackId ?? "" };
    const retention = await readLmuOpponentRetention(source.rawFile);
    const frames = await readLmuOpponentCaptureFrames(source, retention.sourceRevision);
    const opponent = indexLmuOpponentLaps(frames).find((interval) => interval.lapNumber === 2 && interval.coverage === "complete")!;
    expect(opponent).toBeDefined();
    const ordinary = await buildLapsZip([player.lapId]);
    expect(ordinary.manifest.entries.some((entry) => entry.opponentCompanionFile)).toBe(true);
    const ordinaryImport = await importLapsZip(ordinary.bytes);
    const ordinaryRows = await db.select().from(laps).where(eq(laps.sessionId, ordinaryImport.laps[0]!.sessionId)).all();
    expect(ordinaryRows).toHaveLength(1);
    expect(ordinaryImport.errors).toEqual([]);
    expect(ordinaryImport.laps).toHaveLength(1);
    createdSessions.push(ordinaryImport.laps[0]!.sessionId);
    const selected = await buildLapsZip([player.lapId], { opponentLap: opponent.opponentLapId, opponentRevision: retention.sourceRevision });
    const selectedArchive = unzipSync(selected.bytes);
    const withoutPairing = { ...selectedArchive };
    const manifest = JSON.parse(new TextDecoder().decode(withoutPairing["manifest.json"]!));
    delete manifest.entries[0].opponentCompanionFile;
    delete withoutPairing[selected.manifest.entries[0]!.opponentCompanionFile!];
    withoutPairing["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));
    const unpaired = await importLapsZip(zipSync(withoutPairing));
    expect(unpaired.imported).toBe(0);
    expect(unpaired.skipped).toBe(1);
    await expect(importLapsZip(zipSync({ ...selectedArchive, "unowned.opponents.bin.gz": gzipSync(Buffer.from("not a companion")) }))).rejects.toThrow(/unassociated opponent companion/i);
    for (const opponentRetention of ["removed", "not-recorded"] as const) {
      manifest.entries[0].opponentRetention = opponentRetention;
      withoutPairing["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));
      const playerOnly = await importLapsZip(zipSync(withoutPairing));
      expect(playerOnly.errors).toEqual([]);
      expect(playerOnly.laps).toHaveLength(1);
      const restored = playerOnly.laps[0]!;
      createdSessions.push(restored.sessionId);
      expect(restored.lapTime).toBe(player.lapTime);
      const restoredSession = await db.select().from(sessions).where(eq(sessions.id, restored.sessionId)).get();
      const restoredRawFile = restoredSession!.captureManifestFile ?? restoredSession!.rawFile!;
      const restoredRetention = await readLmuOpponentRetention(restoredRawFile);
      expect(restoredRetention).toMatchObject({ opponentRetention });
      expect(await readLmuOpponentCaptureFrames({ ...source, rawFile: restoredRawFile }, restoredRetention.sourceRevision)).toEqual([]);
      const contradictory = JSON.parse(new TextDecoder().decode(selectedArchive["manifest.json"]!));
      contradictory.entries[0].opponentRetention = opponentRetention;
      await expect(importLapsZip(zipSync({ ...selectedArchive, "manifest.json": new TextEncoder().encode(JSON.stringify(contradictory)) }))).rejects.toThrow(/cannot include an opponent companion/i);
    }
    const result = await importLapsZip(selected.bytes);
    expect(result.laps).toHaveLength(1);
    expect(result.laps[0]!.lapNumber).toBe(3);
    const importedSession = await db.select().from(sessions).where(eq(sessions.id, result.laps[0]!.sessionId)).get();
    expect(importedSession?.rawFile).toBeTruthy();
    const importedSource = { rawFile: importedSession!.captureManifestFile ?? importedSession!.rawFile!, source: importedSession!.source, gameId: "lmu" as const, carId: importedSession!.carId ?? "", trackId: importedSession!.trackId ?? "" };
    const importedRetention = await readLmuOpponentRetention(importedSource.rawFile);
    const importedFrames = await readLmuOpponentCaptureFrames(importedSource, importedRetention.sourceRevision);
    const importedOpponent = indexLmuOpponentLaps(importedFrames).find((interval) => interval.lapNumber === 2 && interval.coverage === "complete");
    expect(importedOpponent).toBeDefined();
    const duration = importedOpponent!.frames.at(-1)!.frameTime - importedOpponent!.frames[0]!.frameTime;
    expect(duration).toBeGreaterThan(17_000);
    expect(duration).toBeLessThan(19_000);
    expect(importedOpponent!.endSequence).toBeTruthy();
    expect(importedOpponent!.frames.length).toBeGreaterThan(1);
    expect(importedOpponent!.frames[0]!.captureSequence).toBe(importedOpponent!.startSequence);
    expect(importedOpponent!.frames.at(-1)!.captureSequence).toBe(importedOpponent!.endSequence!);
  }, 120_000);

  test("LMU changing supplemental values and original nanoseconds survive selected-lap export, import and historical replay", async () => {
    const frames = fixtureFrames(makeLmuOpponentCapture(), "lmu");
    const oversizedFrameIndex = frames.length - 2;
    let oversizedDeltaExercised = false;
    function* sourceFrames() {
      let index = 0;
      let previous: Buffer | null = null;
      for (const { bytes } of frames) {
        const native = decodeLMUSourceFrame(bytes)!;
        const memory = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
        if (native.rawSharedMemory) native.rawSharedMemory.copy(memory);
        else {
          memory.writeInt32LE(native.gameVersion, LMU_GAME_VERSION_OFFSET);
          memory.writeUInt32LE(native.sessionEvent, LMU_SESSION_EVENT_OFFSET);
          memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET);
          memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);
          native.telemetry.copy(memory, LMU_TELEMETRY_INFO_OFFSET);
          native.scoringInfo.copy(memory, LMU_SCORING_INFO_OFFSET);
          native.playerScoring?.copy(memory, LMU_SCORING_VEHICLES_OFFSET);
        }
        const sessionKey = `phase1-retention:${native.sessionEvent}`;
        const timestamp = { domain: "monotonic" as const, nanoseconds: 9_007_199_254_740_993_123n + BigInt(index) * 1_000_000n };
        const state = index % 7 === 0 ? "error" as const : "ok" as const;
        const context: LmuLiveContext = {
          schemaVersion: 1, status: "active", playerVehicleId: native.telemetry.readInt32LE(LMU_TELEMETRY.id),
          key: { sessionKey, captureSequence: String(index), frameTime: { domain: "wall-clock", milliseconds: native.captureTimestampMs } },
          supplemental: [{ semanticId: "lmu.rest.session.time-scale", endpoint: "/rest/sessions", method: "GET", sessionKey,
            vehicleId: null, applicability: "session", acquiredAt: timestamp, responseVersion: "fixture-v1",
            observation: { semanticId: "lmu.rest.session.time-scale", value: state === "ok" ? index % 5 : null, unit: "ratio", mappingStatus: "direct", state, confidence: null, freshness: "unknown",
              confidenceComponents: { semanticFidelity: 1, freshness: null, inputCompleteness: state === "ok" ? 1 : 0 },
              provenance: { simulator: "lmu", parserId: "lmu-rest", parserVersion: "1", resolverVersion: "1", catalogVersion: "fixture-v1", catalogHash: "fixture-v1", observedAt: timestamp,
                sourceObservation: { timestamp, updateSequence: 9_007_199_254_740_993n + BigInt(index) } }, schemaVersion: "1", limitations: ["Controlled storage integration fixture"] } }],
        };
        let frame: Buffer;
        if (index === oversizedFrameIndex) {
          for (let offset = 63; offset < memory.length; offset += 64) memory[offset] ^= 1;
          for (const offset of [LMU_TELEMETRY.elapsedTime, LMU_TELEMETRY.lapStartElapsedTime]) native.telemetry.copy(memory, LMU_TELEMETRY_INFO_OFFSET + offset, offset, offset + 8);
          for (const [offset, size] of [[LMU_TELEMETRY.vehicleName, 64], [LMU_TELEMETRY.trackName, 64], [LMU_TELEMETRY.vehicleModel, 30]]) native.telemetry.copy(memory, LMU_TELEMETRY_INFO_OFFSET + offset, offset, offset + size);
          native.scoringInfo.copy(memory, LMU_SCORING_INFO_OFFSET, 0, 64);
          native.scoringInfo.copy(memory, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.lapDistance, LMU_SCORING_INFO.lapDistance, LMU_SCORING_INFO.lapDistance + 8);
          native.playerScoring!.copy(memory, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.lapDistance, LMU_SCORING_VEHICLE.lapDistance, LMU_SCORING_VEHICLE.lapDistance + 8);
          native.telemetry.copy(memory, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.lapNumber, LMU_TELEMETRY.lapNumber, LMU_TELEMETRY.lapNumber + 4);
          const largeContext = { ...context, supplemental: [{ ...context.supplemental[0]!, responseVersion: "" }] };
          const base = encodeLMUSourceFrame(memory, native.captureTimestampMs, { context: largeContext })!;
          largeContext.supplemental[0]!.responseVersion = "x".repeat(LMU_MAX_SOURCE_FRAME_SIZE - base.length);
          frame = encodeLMUSourceFrame(memory, native.captureTimestampMs, { context: largeContext })!;
          expect(decodeLMUSourceFrame(frame)).not.toBeNull();
          expect(encodeLmuSparseFrame(frame, previous!, 0).length).toBeGreaterThan(LMU_MAX_SOURCE_FRAME_SIZE);
          oversizedDeltaExercised = true;
        } else frame = encodeLMUSourceFrame(memory, native.captureTimestampMs, { context })!;
        index++;
        previous = frame;
        yield frame;
      }
    }
    const seeded = await importSessionFrames(sourceFrames(), "lmu");
    createdSessions.push(...seeded.laps.map((lap) => lap.sessionId));
    expect(oversizedDeltaExercised).toBe(true);
    const exportedLap = seeded.laps.find((lap) => lap.isValid)!;
    expect(exportedLap).toBeDefined();
    const originalSession = (await db.select().from(sessions).where(eq(sessions.id, exportedLap.sessionId)).get())!;
    if (originalSession.rawFile) tmpFiles.push(originalSession.rawFile);
    const originalRow = (await db.select().from(laps).where(eq(laps.id, exportedLap.lapId)).get())!;
    const original = await parseRawLapFrames({ rawFile: originalSession.rawFile!, source: originalSession.source, gameId: "lmu", carId: originalSession.carId ?? "", trackId: originalSession.trackId ?? "" }, originalRow.rawByteOffset!, originalRow.rawFrameCount!);
    expect(new Set(original.map((packet) => packet.lmuContext?.supplemental[0]?.observation.value)).size).toBe(6);
    const exported = await buildLapsZip([originalRow.id]);
    const archive = unzipSync(exported.bytes);
    const entry = exported.manifest.entries.find(({ file }) => file.endsWith(".bin.gz"))!;
    expect(entry.opponentRetention).toBe("retained");
    expect(entry.opponentCompanionFile).toBeDefined();
    expect(archive[entry.opponentCompanionFile!]).toBeDefined();
    const sparseCapture = gunzipSync(archive[entry.file]!);
    expect(sparseCapture.length).toBeLessThan(original.length * LMU_SHARED_MEMORY_SIZE * 0.75);
    const withoutCompanion = { ...archive };
    delete withoutCompanion[entry.opponentCompanionFile!];
    const missing = await importLapsZip(zipSync(withoutCompanion));
    expect(missing.imported).toBe(0);
    expect(missing.skipped).toBe(1);
    const corruptCompanion = Buffer.from(archive[entry.opponentCompanionFile!]!);
    corruptCompanion[corruptCompanion.length - 1] ^= 0xff;
    const corrupt = await importLapsZip(zipSync({ ...archive, [entry.opponentCompanionFile!]: corruptCompanion }));
    expect(corrupt.imported).toBe(0);
    expect(corrupt.skipped).toBe(1);
    const imported = await importLapsZip(exported.bytes);
    expect(imported.errors).toEqual([]);
    expect(imported.laps).toHaveLength(1);
    createdSessions.push(imported.laps[0]!.sessionId);
    const importedSession = (await db.select().from(sessions).where(eq(sessions.id, imported.laps[0]!.sessionId)).get())!;
    if (importedSession.rawFile) tmpFiles.push(importedSession.rawFile);
    const importedRow = (await db.select().from(laps).where(eq(laps.id, imported.laps[0]!.lapId)).get())!;
    const restored = await parseRawLapFrames({ rawFile: importedSession.rawFile!, source: importedSession.source, gameId: "lmu", carId: importedSession.carId ?? "", trackId: importedSession.trackId ?? "" }, importedRow.rawByteOffset!, importedRow.rawFrameCount!);
    expect(restored.map((packet) => packet.lmu)).toEqual(original.map((packet) => packet.lmu));
    expect(restored.map((packet) => packet.lmuContext)).toEqual(original.map((packet) => packet.lmuContext));
    const historical = await queryLapTelemetryBySemanticId(importedRow.id, ["fuel.virtual-energy"]);
    expect(historical!.envelopes[0]!.observedAt).toEqual(restored[0]!.lmuContext!.key.frameTime);
    expect(historical!.envelopes.map((envelope) => envelope.lmu)).toEqual(restored.map((packet) => encodeLmuContext(packet.lmuContext!)));
    expect(historical!.envelopes[0]!.lmu!.supplemental[0]!.observation.provenance.sourceObservation!.updateSequence).toMatch(/^9007199254/);
  }, 120_000);
});
