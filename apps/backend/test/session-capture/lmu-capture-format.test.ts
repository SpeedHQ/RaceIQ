import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { initServerGameAdapters } from "../../src/games/init";
import { hasLMUDumpMagic, readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import { importSessionFrames } from "@raceiq/backend-core/session-capture/import-pipeline";
import { SparseSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { encodeFrameLength, encodeMetaFrame } from "@raceiq/capture-formats/session/framing";
import { readRecordedTelemetry } from "../../src/session-capture/replay-packets";

import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";
const fixturePath = "test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz";
const directories: string[] = [];
const sessionIds: number[] = [];


beforeAll(() => initServerGameAdapters(developmentReleaseFeatures));
afterEach(async () => {
  for (const id of sessionIds.splice(0)) await deleteSession(id);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function canonicalCapture(frames: Buffer[]): Buffer {
  return Buffer.concat([
    encodeMetaFrame(frames.length),
    ...frames.flatMap((frame) => [encodeFrameLength(frame.length), frame]),
  ]);
}

function packetEvidence(path: string) {
  return readRecordedTelemetry("lmu", path).packets.map((packet) => ({
    lap: packet.LapNumber,
    distance: packet.DistanceTraveled,
    carId: packet.lmu?.carId,
    trackId: packet.lmu?.trackId,
  }));
}

describe("LMU capture containers", () => {
  test("plays sparse RaceIQ captures and raw dump files", async () => {
    const dump = Buffer.from(gunzipSync(readFileSync(fixturePath)));
    expect(hasLMUDumpMagic(dump)).toBe(true);
    const frames = readLMUFramesFromBuffer(dump);
    expect(frames.length).toBeGreaterThan(100);
    const canonical = canonicalCapture(frames);
    expect(hasLMUDumpMagic(canonical)).toBe(false);

    const directory = mkdtempSync(join(tmpdir(), "raceiq-lmu-containers-"));
    directories.push(directory);
    const paths = {
      dump: join(directory, "lmu-dump.bin"),
      dumpGzip: join(directory, "lmu-dump.bin.gz"),
      canonical: join(directory, "lmu-canonical.bin"),
      canonicalGzip: join(directory, "lmu-canonical.bin.gz"),
      sparse: join(directory, "lmu-sparse.bin"),
      sparseGzip: join(directory, "lmu-sparse.bin.gz"),
    };
    writeFileSync(paths.dump, dump);
    writeFileSync(paths.dumpGzip, gzipSync(dump));
    writeFileSync(paths.canonical, canonical);
    writeFileSync(paths.canonicalGzip, gzipSync(canonical));
    const recorder = new SparseSessionRecorder("lmu");
    recorder.start(paths.sparse);
    for (const frame of frames) recorder.writeRecord(frame);
    await recorder.stop();
    writeFileSync(paths.sparseGzip, gzipSync(readFileSync(paths.sparse)));

    const expected = packetEvidence(paths.sparse);
    expect(expected.length).toBe(frames.length);
    expect(packetEvidence(paths.sparseGzip)).toEqual(expected);
    expect(packetEvidence(paths.dump)).toHaveLength(frames.length);
    expect(packetEvidence(paths.dumpGzip)).toHaveLength(frames.length);
    expect(packetEvidence(paths.canonical)).toHaveLength(frames.length);
    expect(packetEvidence(paths.canonicalGzip)).toHaveLength(frames.length);
    expect(expected[0]).toMatchObject({
      carId: expect.any(String),
      trackId: expect.any(String),
    });

    const imported = await importSessionFrames(frames, "lmu", {
      requireLaps: true,
      notifyDriverProfile: false,
      recorder: new SparseSessionRecorderAdapter(),
    });
    for (const id of new Set(imported.laps.map((lap) => lap.sessionId))) sessionIds.push(id);
    const row = await db.select().from(sessions).where(eq(sessions.id, imported.laps[0]!.sessionId)).get();
    expect(row).toMatchObject({
      gameId: "lmu",
      carId: expect.any(String),
      trackId: expect.any(String),
    });
  }, 60_000);
});
