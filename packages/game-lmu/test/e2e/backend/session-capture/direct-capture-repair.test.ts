import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { DirectCaptureRecording } from "@raceiq/backend-core/session-capture/direct-recorder";
import { runSessionCaptureMaintenanceNow } from "@raceiq/backend-core/session-capture/compressor";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { timestampForFilename } from "@raceiq/backend-core/session-capture/filename";
import { partitionLMUSourceFrame } from "@raceiq/capture-formats/lmu/partition";
import { META_FRAME_BYTES } from "@raceiq/capture-formats/session/framing";
import type { DetectorOwnershipTransition, DetectorOwnershipWindow } from "@raceiq/telemetry-core/processor/ordinal-engine";
import * as livePipeline from "@raceiq/backend-core/telemetry/live-pipeline";
import type { Manifest } from "@raceiq/capture-splitting";
import { startSessionOpponentRemoval, getSessionOpponentRemovalStatus } from "@raceiq/backend-core/session-capture/opponent-removal";
import { getRecordingMaintenanceController } from "@raceiq/backend-core/session-capture/maintenance-runtime";
import { readLmuOpponentRetention } from "@raceiq/backend-core/session-capture/lmu-companion";
import { installDatabaseWriteTestHooks, withDatabaseWrite } from "@raceiq/backend-core/db/write-coordination";
import { fixtureFrames } from "@raceiq/backend/test-support/fixture-frames";
import { fixturePath } from "../../../support/fixtures";

interface RepairRecording {
  session: typeof sessions.$inferSelect;
  lap: typeof laps.$inferSelect;
  path: string;
  manifest: Manifest;
  manifestBytes: Buffer<ArrayBuffer>;
  chunkPath: string;
  chunkBytes: Buffer<ArrayBuffer>;
  expectedFrames: Buffer[];
}

const directories: string[] = [];
const sessionIds: number[] = [];
const originalSettings = loadSettings();
afterEach(async () => {
  for (const id of sessionIds.splice(0)) {
    await db.delete(laps).where(eq(laps.sessionId, id)).run();
    await db.delete(sessions).where(eq(sessions.id, id)).run();
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  saveSettings(originalSettings);
});
function transition(kind: DetectorOwnershipTransition["kind"], window: DetectorOwnershipWindow): DetectorOwnershipTransition {
  return { kind, revision: window.revision, window, state: { revision: window.revision, watermarkOffset: null, nextWindowStartOffset: null, windows: [] } };
}
async function recording(recordLmuOpponents = false): Promise<RepairRecording> {
  saveSettings({ ...loadSettings(), sessionCleanupEnabled: false, sessionDownsampleEnabled: false });
  const directory = join(resolveRecordingDirectory(), "lmu", "own", `${timestampForFilename()}-${crypto.randomUUID()}`);
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "capture-manifest.json");
  const session = await db.insert(sessions).values({ gameId: "lmu", carId: "repair-car", trackId: "repair-track", rawFile: path, captureFormatVersion: 1 }).returning().get();
  sessionIds.push(session.id);
  const lap = await db.insert(laps).values({ sessionId: session.id, lapNumber: 1, lapTime: 90, isValid: true, isFavorite: true, notes: "preserve my lap", rawByteOffset: META_FRAME_BYTES, rawFrameCount: 2 }).returning().get();
  const native = fixtureFrames(readFileSync(fixturePath("sessions/lmu-real-opponents-grid-2026-10-22.bin.gz")), "lmu").slice(0, 2).map((frame) => frame.bytes);
  const capture = new DirectCaptureRecording("lmu", directory, path, { recordLmuOpponents });
  try {
    await capture.ready;
    capture.attachSession(session.id, Promise.resolve(), () => {});
    capture.writeRecord(native[0]!, 100);
    const window: DetectorOwnershipWindow = { revision: 1, lapNumber: 1, startOffset: META_FRAME_BYTES, startOrdinal: 0, frameCount: 1, status: "provisional", trailingContextFrameCount: 0, bounded: true };
    capture.processTransitions([transition("window-start", window)], null);
    capture.writeRecord(native[1]!, 110);
    capture.processTransitions([transition("window-finalized", { ...window, revision: 2, frameCount: 2, status: "final" })], null);
    capture.bindLap({ sessionId: session.id, lapId: lap.id, lapNumber: 1, startByteOffset: META_FRAME_BYTES, frameCount: 2 });
    await capture.stop();
  } finally {
    await capture.stop().catch(() => {});
  }
  const manifestBytes = await readFile(path);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const chunkPath = join(directory, manifest.chunks[0].path);
  return { session, lap, path, manifest, manifestBytes, chunkPath, chunkBytes: await readFile(chunkPath), expectedFrames: native.map(frame => partitionLMUSourceFrame(frame)?.primary ?? frame) };
}
async function unpublish(source: RepairRecording) {
  await db.update(sessions).set({ captureManifestFile: null, captureLayoutVersion: null }).where(eq(sessions.id, source.session.id)).run();
  await db.update(laps).set({ captureChunkId: null, sourceFrameStart: null, sourceFrameCount: null }).where(eq(laps.id, source.lap.id)).run();
}
async function verifyReplay(source: RepairRecording) {
  const frames: Buffer[] = [];
  const timestamps: Array<number | undefined> = [];
  for await (const record of iterateSessionCaptureRecordsFromSource({ rawFile: source.path, gameId: "lmu", source: null, carId: "repair-car", trackId: "repair-track", captureFormatVersion: 1 }, { strict: true })) {
    if (record.kind === "frame") { frames.push(record.frame); timestamps.push(record.frameTimeMs); }
  }
  expect(frames).toEqual(source.expectedFrames);
  expect(timestamps).toEqual([100, 110]);
  expect(await readFile(source.chunkPath)).toEqual(source.chunkBytes);
  expect(await db.select().from(laps).where(eq(laps.id, source.lap.id)).get()).toEqual({ ...source.lap, captureChunkId: source.manifest.chunks[0].id, sourceFrameStart: 0, sourceFrameCount: 2 });
}

describe("direct capture repair through recording maintenance", () => {
  for (const damage of ["missing", "malformed", "invalid-schema"] as const) {
    test(`restores ${damage} manifest, publication and exact replay without changing saved lap`, async () => {
      const source = await recording();
      expect(await readFile(`${source.path}.recovery`)).toEqual(source.manifestBytes);
      await unpublish(source);
      if (damage === "missing") await rm(source.path);
      else if (damage === "invalid-schema") await writeFile(source.path, "{}");
      else await writeFile(source.path, "{broken");
      await runSessionCaptureMaintenanceNow();
      expect(await readFile(source.path)).toEqual(source.manifestBytes);
      expect(await db.select({ path: sessions.captureManifestFile, layout: sessions.captureLayoutVersion }).from(sessions).where(eq(sessions.id, source.session.id)).get()).toEqual({ path: source.path, layout: 1 });
      await verifyReplay(source);
      await runSessionCaptureMaintenanceNow();
      await verifyReplay(source);
    });
  }
  test("reconciles valid primary without replacing it with stale recovery snapshot", async () => {
    const source = await recording();
    await writeFile(`${source.path}.recovery`, JSON.stringify({ ...source.manifest, sourceRevision: "stale-snapshot", chunks: [], sourceByteLength: META_FRAME_BYTES, sourceRecordCount: 0 }));
    await unpublish(source);
    await runSessionCaptureMaintenanceNow();
    expect(await readFile(source.path)).toEqual(source.manifestBytes);
    await verifyReplay(source);
  });
  for (const damage of ["chunk", "ownership", "snapshot", "unsafe-path", "missing-evidence", "companion-prefix", "ambiguous-owner"] as const) {
    test(`preserves failed evidence and publication when ${damage} is invalid`, async () => {
      const source = await recording(damage === "companion-prefix");
      await unpublish(source);
      await writeFile(source.path, "{broken");
      if (damage === "chunk") await writeFile(source.chunkPath, source.chunkBytes.subarray(0, -1));
      if (damage === "ownership") await db.update(laps).set({ rawFrameCount: 3 }).where(eq(laps.id, source.lap.id)).run();
      if (damage === "snapshot") await writeFile(`${source.path}.recovery`, "{broken snapshot");
      if (damage === "unsafe-path") await writeFile(`${source.path}.recovery`, JSON.stringify({ ...source.manifest, chunks: [{ ...source.manifest.chunks[0], path: "../outside.bin" }] }));
      if (damage === "missing-evidence") await rm(`${source.path}.recovery`);
      if (damage === "companion-prefix") {
        const companion = source.manifest.opponentCompanion!;
        await writeFile(`${source.path}.recovery`, JSON.stringify({ ...source.manifest, opponentCompanion: { ...companion, committedPrefix: { ...companion.committedPrefix, byteLength: companion.committedPrefix.byteLength - 1 } } }));
      }
      if (damage === "ambiguous-owner") {
        const other = await db.insert(sessions).values({ gameId: "lmu", carId: "other-car", trackId: "other-track", rawFile: source.path, captureFormatVersion: 1 }).returning().get();
        sessionIds.push(other.id);
      }
      const damagedChunk = await readFile(source.chunkPath);
      const damagedSnapshot = damage === "missing-evidence" ? null : await readFile(`${source.path}.recovery`);
      await expect(runSessionCaptureMaintenanceNow()).rejects.toThrow();
      expect(await readFile(source.path, "utf8")).toBe("{broken");
      expect(await readFile(source.chunkPath)).toEqual(damagedChunk);
      if (damagedSnapshot) expect(await readFile(`${source.path}.recovery`)).toEqual(damagedSnapshot);
      expect((await db.select().from(laps).where(eq(laps.id, source.lap.id)).get())?.captureChunkId).toBeNull();
    });
  }
  for (const change of ["deleted", "repointed"] as const) {
    test(`does not publish stale ownership when session is ${change} during repair`, async () => {
      const source = await recording();
      await unpublish(source);
      await writeFile(source.path, "{broken");
      const entered = Promise.withResolvers<void>();
      const mutate = Promise.withResolvers<void>();
      const mutated = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const waiting = Promise.withResolvers<void>();
      const restoreHook = installDatabaseWriteTestHooks({ waiting: () => waiting.resolve() });
      const holding = withDatabaseWrite(async () => {
        entered.resolve();
        await mutate.promise;
        if (change === "deleted") {
          await db.delete(laps).where(eq(laps.sessionId, source.session.id)).run();
          await db.delete(sessions).where(eq(sessions.id, source.session.id)).run();
        } else {
          await db.update(sessions).set({ rawFile: "replacement.bin" }).where(eq(sessions.id, source.session.id)).run();
        }
        mutated.resolve();
        await release.promise;
      });
      let repairing: Promise<void> | undefined;
      try {
        await entered.promise;
        repairing = runSessionCaptureMaintenanceNow();
        await waiting.promise;
        mutate.resolve();
        await mutated.promise;
        release.resolve();
        await holding;
        await expect(repairing).rejects.toThrow();
        expect(await readFile(source.path, "utf8")).toBe("{broken");
        expect(await readFile(source.chunkPath)).toEqual(source.chunkBytes);
        const current = await db.select().from(sessions).where(eq(sessions.id, source.session.id)).get();
        if (change === "deleted") expect(current).toBeUndefined();
        else expect(current?.rawFile).toBe("replacement.bin");
      } finally {
        mutate.resolve(); release.resolve();
        restoreHook();
        await holding;
        await repairing?.catch(() => {});
      }
    });
  }
  test("defers active capture, then repairs on idle pass", async () => {
    const source = await recording();
    await writeFile(source.path, "{broken");
    const active = spyOn(livePipeline, "isSessionActive").mockReturnValue(true);
    try {
      await runSessionCaptureMaintenanceNow();
      expect(await readFile(source.path, "utf8")).toBe("{broken");
    } finally { active.mockRestore(); }
    await runSessionCaptureMaintenanceNow();
    await verifyReplay(source);
  });
  test("repair preserves committed opponent removal instead of resurrecting retained data", async () => {
    const source = await recording(true);
    expect(source.manifest.opponentRetention).toBe("retained");
    await startSessionOpponentRemoval({ sessionIds: [source.session.id] });
    await Promise.all([...getRecordingMaintenanceController().fibers].map(fiber => {
      const { promise, resolve } = Promise.withResolvers<void>();
      fiber.addObserver(() => resolve());
      return promise;
    }));
    expect(getSessionOpponentRemovalStatus().status).toBe("success");
    const removedBytes = await readFile(source.path);
    expect(JSON.parse(removedBytes.toString("utf8")).opponentRetention).toBe("removed");
    expect(await readFile(`${source.path}.recovery`)).toEqual(removedBytes);
    await writeFile(source.path, "{broken");
    await runSessionCaptureMaintenanceNow();
    expect(await readFile(source.path)).toEqual(removedBytes);
    expect(await readLmuOpponentRetention(source.path)).toMatchObject({ opponentRetention: "removed", opponentAvailability: null });
    expect(await readFile(source.chunkPath)).toEqual(source.chunkBytes);
  });
});
