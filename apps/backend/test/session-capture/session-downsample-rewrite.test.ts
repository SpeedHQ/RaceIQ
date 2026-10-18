import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { eq, inArray } from "drizzle-orm";
import { db, client } from "@raceiq/backend-core/db/index";
import { sessions, laps } from "@raceiq/backend-core/db/schema";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { buildSessionDownsamplePlan, cleanupInterruptedSessionDownsampleFiles, executeSessionDownsampleGroup, runSessionDownsampleNow } from "@raceiq/backend-core/session-capture/session-downsample";
import { reserveRecordingStorageOperation } from "@raceiq/backend-core/session-capture/storage-activity";
import { disposeRecordingMaintenanceRuntime } from "@raceiq/backend-core/session-capture/maintenance-runtime";
import { withSessionCaptureMaintenanceLock } from "@raceiq/backend-core/session-capture/cleanup";
import { setSessionFavorite } from "@raceiq/backend-core/db/session-queries";
import { parseRawLapFrames } from "@raceiq/backend-core/db/telemetry-replay-storage";
import * as livePipeline from "@raceiq/backend-core/telemetry/live-pipeline";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { readKunosFrames } from "@raceiq/capture-formats/kunos/dump";
import { ACC_PACKED_MAGIC, packTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import { GRAPHICS, PHYSICS } from "@raceiq/capture-formats/acc/structs";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";

initGameAdapters();
initServerGameAdapters();
const createdIds: number[] = [];
const directories: string[] = [];
const fixture = readKunosFrames("test/artifacts/sessions/acc-2026-04-10T02-55-22-777Z.bin.gz")[100]!;
const request = { mode: "all", targetHz: 50 } as const;

async function recording(gzip = false, filename = "source.bin", delayedFinishAt?: number) {
  const dir = join(resolveRecordingDirectory(), "acc", "own", `rewrite-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  directories.push(dir);
  const plain = join(dir, filename);
  const recorder = new SparseSessionRecorder("acc");
  recorder.start(plain);
  recorder.writeMetaFrame();
  const offsets: number[] = [];
  for (let index = 0; index < 1000; index++) {
    const physics = Buffer.from(fixture.physics);
    physics.writeInt32LE(index, 0);
    physics.writeFloatLE(100 + index / 100, PHYSICS.speedKmh.offset);
    const graphics = Buffer.from(fixture.graphics);
    if (delayedFinishAt !== undefined) {
      graphics.writeInt32LE(index < delayedFinishAt ? 90_000 + index * 10 : (index - delayedFinishAt) * 10, GRAPHICS.iCurrentTime.offset);
      graphics.writeInt32LE(index < delayedFinishAt ? 0 : 90_000 + delayedFinishAt * 10, GRAPHICS.iLastTime.offset);
      graphics.writeInt32LE(index < delayedFinishAt ? 0 : 1, GRAPHICS.completedLaps.offset);
    }
    const frame = packTriplet(ACC_PACKED_MAGIC, 1, 1, physics, graphics, fixture.staticData);
    offsets.push(recorder.getCurrentByteOffset());
    recorder.writeRecord(frame, 1_800_000_000_000 + index * 10);
  }
  await recorder.stop();
  const path = gzip ? `${plain}.gz` : plain;
  if (gzip) {
    writeFileSync(path, gzipSync(readFileSync(plain)));
    rmSync(plain);
  }
  const session = await db.insert(sessions).values({ gameId: "acc", carId: "1", trackId: "1", rawFile: path, notes: "Keep session note" }).returning({ id: sessions.id }).get();
  createdIds.push(session.id);
  const [lap] = await db
    .insert(laps)
    .values({ sessionId: session.id, lapNumber: 1, lapTime: 10, isValid: true, notes: "Keep lap note", rawByteOffset: offsets[0], rawFrameCount: delayedFinishAt ?? 1000 })
    .returning({ id: laps.id });
  const plan = await buildSessionDownsamplePlan(request);
  const group = plan.groups.find((candidate) => candidate.rows.some((row) => row.id === session.id));
  expect(group).toBeDefined();
  return { dir, path, sessionId: session.id, lapId: lap!.id, group: group!, sourceBytes: statSync(path).size };
}

afterEach(async () => {
  await disposeRecordingMaintenanceRuntime();
  await client.execute("DROP TRIGGER IF EXISTS downsample_rewrite_failure");
  if (createdIds.length) {
    await db.delete(laps).where(inArray(laps.sessionId, createdIds));
    await db.delete(sessions).where(inArray(sessions.id, createdIds.splice(0)));
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session downsample real rewrite", () => {
  for (const gzip of [false, true])
    test(`publishes replayable ${gzip ? "gzip" : "plain"} capture with stable lap metadata`, async () => {
      const original = await recording(gzip);
      const release = reserveRecordingStorageOperation("downsample");
      try {
        const result = await executeSessionDownsampleGroup(request, original.group);
        expect(result.kind).toBe("converted");
        const session = await db.select().from(sessions).where(eq(sessions.id, original.sessionId)).get();
        const lap = await db.select().from(laps).where(eq(laps.id, original.lapId)).get();
        expect(session).toMatchObject({ id: original.sessionId, notes: "Keep session note", downsampledFrequencyHz: 50 });
        expect(lap).toMatchObject({ id: original.lapId, lapTime: 10, isValid: true, notes: "Keep lap note", rawFrameCount: 501 });
        expect(existsSync(original.path)).toBe(false);
        expect(statSync(session!.rawFile!).size).toBeLessThan(original.sourceBytes);
        const source = { rawFile: session!.rawFile!, source: null, gameId: "acc" as const, carId: "1", trackId: "1" };
        const timestamps: number[] = [];
        for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) if (record.kind === "frame") timestamps.push(record.frameTimeMs!);
        expect(timestamps).toHaveLength(501);
        expect(timestamps[0]).toBe(1_800_000_000_000);
        expect(timestamps.at(-1)).toBe(1_800_000_009_990);
        const telemetry = await parseRawLapFrames(source, lap!.rawByteOffset!, lap!.rawFrameCount!);
        expect(telemetry[0]!.Speed).toBeCloseTo(100 / 3.6, 3);
        expect(telemetry.at(-1)!.Speed).toBeCloseTo(109.99 / 3.6, 3);
        expect((await buildSessionDownsamplePlan(request, { onlyPath: source.rawFile })).preview.skipped).toContainEqual({ sessionIds: [original.sessionId], reason: "already-at-or-below-target" });
      } finally {
        release();
      }
    });

  test("Kunos lap replay retains original delayed finish telemetry without an indexed successor", async () => {
    const original = await recording(false, "delayed-finish.bin", 9);
    const oldLap = await db.select().from(laps).where(eq(laps.id, original.lapId)).get();
    const source = { rawFile: original.path, source: null, gameId: "acc" as const, carId: "1", trackId: "1" };
    const before = await parseRawLapFrames(source, oldLap!.rawByteOffset!, oldLap!.rawFrameCount!);
    expect(before.at(-1)!.CurrentLap).toBeCloseTo(90.09, 5);
    expect(before.at(-1)!.Speed).toBeCloseTo(100.09 / 3.6, 5);
    const release = reserveRecordingStorageOperation("downsample");
    try {
      expect((await executeSessionDownsampleGroup(request, original.group)).kind).toBe("converted");
    } finally {
      release();
    }
    const session = await db.select().from(sessions).where(eq(sessions.id, original.sessionId)).get();
    const lap = await db.select().from(laps).where(eq(laps.id, original.lapId)).get();
    const after = await parseRawLapFrames({ ...source, rawFile: session!.rawFile! }, lap!.rawByteOffset!, lap!.rawFrameCount!);
    expect(after.at(-1)).toEqual(before.at(-1));
    expect(after.length).toBeLessThan(before.length);
  });

  for (const gzip of [false, true])
    test(`successive reductions preserve replayable ${gzip ? "gzip" : "plain"} capture`, async () => {
      const original = await recording(gzip, "acc-recording-with-a-long-original-filename-2026-10-16T12-00-00-000Z.bin");
      let previousPath = original.path;
      let previousFrameCount = 1000;
      for (const targetHz of [90, 80, 70, 60] as const) {
        const status = await runSessionDownsampleNow({ mode: "all", targetHz });
        expect(status).toMatchObject({ status: "success", convertedFiles: 1, failed: [] });
        const session = await db.select().from(sessions).where(eq(sessions.id, original.sessionId)).get();
        const lap = await db.select().from(laps).where(eq(laps.id, original.lapId)).get();
        expect(session!.downsampledFrequencyHz).toBe(targetHz);
        expect(existsSync(previousPath)).toBe(false);
        expect(lap!.rawFrameCount!).toBeLessThan(previousFrameCount);
        const source = { rawFile: session!.rawFile!, source: null, gameId: "acc" as const, carId: "1", trackId: "1" };
        const telemetry = await parseRawLapFrames(source, lap!.rawByteOffset!, lap!.rawFrameCount!);
        expect(telemetry[0]!.Speed).toBeCloseTo(100 / 3.6, 3);
        expect(telemetry.at(-1)!.Speed).toBeCloseTo(109.99 / 3.6, 3);
        expect(session!.rawFile!.endsWith(gzip ? ".bin.gz" : ".bin")).toBe(true);
        previousPath = session!.rawFile!;
        previousFrameCount = lap!.rawFrameCount!;
      }
    });

  test("database publication failure preserves source, indexes and removes uncommitted output", async () => {
    const original = await recording();
    const before = readFileSync(original.path);
    await client.execute(
      `CREATE TRIGGER downsample_rewrite_failure BEFORE UPDATE OF raw_file ON sessions WHEN old.id=${original.sessionId} BEGIN SELECT RAISE(ABORT,'injected publication failure'); END`,
    );
    const release = reserveRecordingStorageOperation("downsample");
    try {
      await expect(executeSessionDownsampleGroup(request, original.group)).rejects.toThrow();
    } finally {
      release();
    }
    expect(readFileSync(original.path)).toEqual(before);
    expect((await db.select().from(sessions).where(eq(sessions.id, original.sessionId)).get())!.rawFile).toBe(original.path);
    expect((await db.select().from(laps).where(eq(laps.id, original.lapId)).get())!.rawFrameCount).toBe(1000);
    expect(readdirSync(original.dir)).toEqual(["source.bin"]);
  });

  for (const failure of ["write", "validation"] as const) {
    test(`${failure} failure preserves source authority and removes replacement`, async () => {
      const original = await recording();
      const before = readFileSync(original.path);
      const fsync = fs.fsyncSync;
      const injected =
        failure === "write"
          ? spyOn(fs, "writeSync").mockImplementation(() => {
              throw new Error("Injected recording write failure");
            })
          : spyOn(fs, "fsyncSync").mockImplementation((fd) => {
              fs.writeSync(fd, Buffer.from([0]), 0, 1, 0);
              fsync(fd);
            });
      const release = reserveRecordingStorageOperation("downsample");
      try {
        await expect(executeSessionDownsampleGroup(request, original.group)).rejects.toThrow();
      } finally {
        injected.mockRestore();
        release();
      }
      expect(readFileSync(original.path)).toEqual(before);
      expect((await db.select().from(sessions).where(eq(sessions.id, original.sessionId)).get())!.rawFile).toBe(original.path);
      expect((await db.select().from(laps).where(eq(laps.id, original.lapId)).get())!.rawFrameCount).toBe(1000);
      expect(readdirSync(original.dir)).toEqual(["source.bin"]);
    });
  }

  test("postcommit unlink failure keeps validated replacement authoritative", async () => {
    const original = await recording();
    const unlink = fsPromises.unlink;
    const injected = spyOn(fsPromises, "unlink").mockImplementation(async (path) => {
      if (path === original.path) throw new Error("Injected source unlink failure");
      return unlink(path);
    });
    const release = reserveRecordingStorageOperation("downsample");
    try {
      const result = await executeSessionDownsampleGroup(request, original.group);
      expect(result.kind).toBe("converted");
      if (result.kind !== "converted") throw new Error("Expected committed conversion");
      expect(result.warning).toContain("Injected source unlink failure");
      const session = await db.select().from(sessions).where(eq(sessions.id, original.sessionId)).get();
      expect(session!.rawFile).not.toBe(original.path);
      expect(existsSync(session!.rawFile!)).toBe(true);
      expect(existsSync(original.path)).toBe(true);
      expect(session!.downsampledFrequencyHz).toBe(50);
    } finally {
      injected.mockRestore();
      release();
    }
  });

  test("capture starting during rewrite aborts before publication", async () => {
    const original = await recording();
    const before = readFileSync(original.path);
    let active = false;
    const activity = spyOn(livePipeline, "isSessionActive").mockImplementation(() => active);
    const fsync = fs.fsyncSync;
    const flush = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      fsync(fd);
      active = true;
    });
    const release = reserveRecordingStorageOperation("downsample");
    try {
      await expect(executeSessionDownsampleGroup(request, original.group)).rejects.toThrow("session is active");
    } finally {
      activity.mockRestore();
      flush.mockRestore();
      release();
    }
    expect(readFileSync(original.path)).toEqual(before);
    expect((await db.select().from(sessions).where(eq(sessions.id, original.sessionId)).get())!.rawFile).toBe(original.path);
    expect(readdirSync(original.dir)).toEqual(["source.bin"]);
  });

  test("favorite change queued before rewrite protects entire original file", async () => {
    const original = await recording();
    let enter!: () => void;
    let unlock!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const blocker = withSessionCaptureMaintenanceLock(async () => {
      enter();
      await gate;
    });
    await entered;
    const favoriting = setSessionFavorite(original.sessionId, true);
    const release = reserveRecordingStorageOperation("downsample");
    const executing = executeSessionDownsampleGroup(request, original.group);
    unlock();
    await blocker;
    await favoriting;
    try {
      expect(await executing).toEqual({ kind: "skipped", skip: { sessionIds: [original.sessionId], reason: "favorite" } });
    } finally {
      release();
    }
    expect(existsSync(original.path)).toBe(true);
  });

  test("interrupted-temp cleanup deletes only narrowly named operation files", async () => {
    const original = await recording();
    const ours = join(original.dir, "source.downsample-12345678-1234-1234-1234-123456789abc.bin.gz.raw.tmp");
    const unrelated = join(original.dir, "unrelated.tmp");
    writeFileSync(ours, "interrupted");
    writeFileSync(unrelated, "keep");
    const release = reserveRecordingStorageOperation("downsample");
    try {
      expect(await cleanupInterruptedSessionDownsampleFiles()).toBe(1);
    } finally {
      release();
    }
    expect(existsSync(ours)).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("keep");
    expect(existsSync(original.path)).toBe(true);
  });
});
