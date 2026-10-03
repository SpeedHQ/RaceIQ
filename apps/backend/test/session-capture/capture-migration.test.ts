import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { client, db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { deleteSession, listCaptureMigrationCandidates } from "@raceiq/backend-core/db/session-queries";
import { encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, encodeSegmentContextEndFrame, encodeSegmentContextFrame, readFramePrefix, readFrameStreamStart } from "@raceiq/backend-core/session-capture/framing";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { encodeGenericSparseFrame, isGenericSparseFrame } from "@raceiq/backend-core/session-capture/generic-sparse";
import { migrateCaptures } from "@raceiq/backend-core/session-capture/migrate-captures";
import { sessionRoutes } from "../../src/routes/session-routes";
import { transferRoutes } from "../../src/routes/laps/transfer-routes";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { initGameAdapters } from "@raceiq/shared/games/init";
import { initServerGameAdapters } from "../../src/games/init";

const owned = new Set<number>();
const imported = new Set<number>();
const dirs: string[] = [];
let triggerInstalled = false;
initGameAdapters();
initServerGameAdapters();

afterEach(async () => {
  if (triggerInstalled) {
    await client.execute("DROP TRIGGER IF EXISTS reject_capture_migration");
    triggerInstalled = false;
  }
  for (const id of owned) {
    await db.delete(laps).where(eq(laps.sessionId, id)).run();
    await db.delete(sessions).where(eq(sessions.id, id)).run();
  }
  owned.clear();
  for (const id of imported) await deleteSession(id);
  imported.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFrames(seed: number): Buffer[] {
  const template = Buffer.alloc(360);
  let state = (seed + 1) * 0x9e3779b1;
  for (let index = 0; index < template.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    template[index] = state >>> 24;
  }
  return Array.from({ length: 8 }, (_, index) => {
    const frame = Buffer.from(template);
    frame.writeUInt32LE(seed * 100 + index, 8);
    frame.writeDoubleLE(index + seed / 10, 128);
    return frame;
  });
}
function capture(frames: Buffer[]): Buffer {
  const parts = [encodeMetaFrame(frames.length)];
  for (const frame of frames) parts.push(encodeFrameLength(frame.length), frame);
  return Buffer.concat(parts);
}
async function insertSession(rawFile: string, gameId = "fm-2023"): Promise<number> {
  const row = await db.insert(sessions).values({ gameId, carOrdinal: 1, trackOrdinal: 1, rawFile, captureFormatVersion: null }).returning({ id: sessions.id }).get();
  owned.add(row.id);
  return row.id;
}
async function insertLap(sessionId: number, offset: number, lapNumber: number) {
  return db.insert(laps).values({ sessionId, lapNumber, lapTime: 91.25 + lapNumber, isValid: true, rawByteOffset: offset, rawFrameCount: 3, notes: `preserve-${lapNumber}` }).returning().get();
}
function tempCaptureDir(): string {
  const parent = join(resolveDataDir(), "sessions");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "capture-migration-test-"));
  dirs.push(dir);
  return dir;
}
async function records(path: string, gameId = "fm-2023"): Promise<Buffer[]> {
  const result: Buffer[] = [];
  for await (const record of iterateSessionCaptureRecordsFromSource({ rawFile: path, gameId: gameId as "fm-2023", source: null, carOrdinal: -1, trackOrdinal: -1 }, { strict: true })) {
    if (record.kind === "frame") result.push(record.frame);
  }
  return result;
}
async function recordsWithOffsets(path: string, gameId: "fm-2023" | "lmu" = "fm-2023"): Promise<Array<{ offset: number; frame: Buffer; frameTimeMs?: number }>> {
  const result: Array<{ offset: number; frame: Buffer; frameTimeMs?: number }> = [];
  for await (const record of iterateSessionCaptureRecordsFromSource({ rawFile: path, gameId, source: null, carOrdinal: -1, trackOrdinal: -1 }, { strict: true })) {
    if (record.kind === "frame") result.push({ offset: record.offset, frame: record.frame, frameTimeMs: record.frameTimeMs });
  }
  return result;
}

function hasGenericSparseRecord(bytes: Buffer): boolean {
  for (let offset = readFrameStreamStart(bytes); offset < bytes.length;) {
    const prefix = readFramePrefix(bytes, offset);
    if (!prefix) throw new Error(`Invalid frame prefix at ${offset}`);
    const start = offset + prefix.prefixBytes;
    if (isGenericSparseFrame(bytes.subarray(start, start + prefix.length))) return true;
    offset = start + prefix.length;
  }
  return false;
}

describe("historical capture migration", () => {
  test.each([
    ["imports a full FM capture as raw .bin, then migrates it", true, false],
    ["imports a full FM capture as raw .bin.gz, then migrates it", true, true],
    ["imports a full fm capture into sparse", false, true],
  ] as const)("%s", async (_name, rawStorage, compressed) => {
    const fixture = readFileSync(join(ROOT_DIR, "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz"));
    const existing = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map(({ id }) => id));
    const form = new FormData();
    form.append("file", new File([compressed ? fixture : gunzipSync(fixture)], `fm-2023-e2e.bin${compressed ? ".gz" : ""}`));
    form.append("ownership", "mine");
    if (rawStorage) form.append("captureStorage", "raw");
    const upload = await transferRoutes.request("/api/laps/import", { method: "POST", body: form });
    expect(upload.status).toBe(200);
    const body = await upload.json() as { packetCount: number; laps: Array<{ lapId: number; sessionId: number; isValid: boolean }> };
    expect(body.packetCount).toBeGreaterThan(0);
    expect(body.laps.some(({ isValid }) => isValid)).toBe(true);
    const created = (await db.select().from(sessions).all()).filter(({ id }) => !existing.has(id));
    for (const row of created) imported.add(row.id);
    expect(created.length).toBeGreaterThan(0);
    const importedLap = body.laps.find(({ isValid }) => isValid)!;
    const session = created.find(({ id }) => id === importedLap.sessionId)!;
    expect(created.every(({ captureFormatVersion }) => captureFormatVersion === (rawStorage ? null : 1))).toBe(true);
    expect(session.rawFile).toBeTruthy();
    const originalPath = session.rawFile!;
    expect(existsSync(originalPath)).toBe(true);
    const before = await recordsWithOffsets(originalPath);
    expect(before.length).toBeGreaterThan(1000);
    expect(hasGenericSparseRecord(readFileSync(originalPath))).toBe(!rawStorage);
    expect((await listCaptureMigrationCandidates()).some(({ rawFile }) => rawFile === originalPath)).toBe(rawStorage);
    const lap = await db.select().from(laps).where(eq(laps.id, importedLap.lapId)).get();
    expect(lap?.rawByteOffset).not.toBeNull();
    const sourceFrame = before.find(({ offset }) => offset === lap?.rawByteOffset)?.frame;
    expect(sourceFrame).toBeDefined();

    const response = await sessionRoutes.request("/api/sessions/migrate-captures", { method: "POST" });
    expect(response.status).toBe(200);
    const result = await response.json() as { results: Array<{ rawFile: string; status: string }> };
    const updatedSession = await db.select().from(sessions).where(eq(sessions.id, session.id)).get();
    const updatedLap = await db.select().from(laps).where(eq(laps.id, lap!.id)).get();
    if (rawStorage) {
      expect(result.results.find(({ rawFile }) => rawFile === originalPath)?.status).toBe("migrated");
      expect(updatedSession?.rawFile).not.toBe(originalPath);
      expect(existsSync(originalPath)).toBe(false);
      expect(existsSync(updatedSession!.rawFile!)).toBe(true);
      expect(updatedSession?.captureFormatVersion).toBe(1);
      expect(hasGenericSparseRecord(readFileSync(updatedSession!.rawFile!))).toBe(true);
    } else {
      expect(result.results.some(({ rawFile }) => rawFile === originalPath)).toBe(false);
      expect(updatedSession?.rawFile).toBe(originalPath);
      expect(existsSync(originalPath)).toBe(true);
    }
    const after = await recordsWithOffsets(updatedSession!.rawFile!);
    expect(after.map(({ frame, frameTimeMs }) => ({ frame, frameTimeMs })))
      .toEqual(before.map(({ frame, frameTimeMs }) => ({ frame, frameTimeMs })));
    expect(after.find(({ offset }) => offset === updatedLap?.rawByteOffset)?.frame).toEqual(sourceFrame);
    expect(updatedLap).toMatchObject({ id: lap!.id, rawFrameCount: lap!.rawFrameCount, lapTime: lap!.lapTime });
  }, { timeout: 120000 });

  test("replaces legacy capture even when sparse output has no size saving", async () => {
    const dir = tempCaptureDir();
    const originalPath = join(dir, "single-frame.bin");
    const frames = makeFrames(3).slice(0, 1);
    writeFileSync(originalPath, capture(frames));
    const originalSize = readFileSync(originalPath).length;
    const sessionId = await insertSession(originalPath);

    const result = await migrateCaptures();
    expect(result).toMatchObject({ migrated: 1, failed: 0 });
    const updated = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(updated?.captureFormatVersion).toBe(1);
    expect(updated?.rawFile).not.toBe(originalPath);
    expect(existsSync(originalPath)).toBe(false);
    expect(readFileSync(updated!.rawFile!).length).toBeGreaterThanOrEqual(originalSize);
    expect(await records(updated!.rawFile!)).toEqual(frames);
  });

  test("converts newest capture first, including recordings shared with older sessions", async () => {
    const dir = tempCaptureDir();
    const paths = ["old.bin", "shared.bin", "middle.bin"].map((name) => join(dir, name));
    for (const path of paths) writeFileSync(path, capture(makeFrames(4)));
    const old = await insertSession(paths[0]!);
    const sharedOld = await insertSession(paths[1]!);
    const middle = await insertSession(paths[2]!);
    const sharedNew = await insertSession(paths[1]!);
    for (const [id, createdAt] of [
      [old, "2026-01-01 00:00:00"],
      [sharedOld, "2026-01-02 00:00:00"],
      [middle, "2026-01-03 00:00:00"],
      [sharedNew, "2026-01-04 00:00:00"],
    ] as const) {
      await db.update(sessions).set({ createdAt }).where(eq(sessions.id, id)).run();
    }

    const selected = (await listCaptureMigrationCandidates()).filter(({ rawFile }) => paths.includes(rawFile));
    expect(selected).toEqual([
      { rawFile: paths[1], gameId: "fm-2023", sessionIds: [sharedOld, sharedNew] },
      { rawFile: paths[2], gameId: "fm-2023", sessionIds: [middle] },
      { rawFile: paths[0], gameId: "fm-2023", sessionIds: [old] },
    ]);
    const result = await migrateCaptures();
    expect(result.results.filter(({ rawFile }) => paths.includes(rawFile)).map(({ rawFile, status }) => ({ rawFile, status }))).toEqual(
      [paths[1], paths[2], paths[0]].map((rawFile) => ({ rawFile, status: "migrated" })),
    );
  });

  test.each([false, true])("migrates shared legacy capture and remaps every lap offset (gzip=%s)", async (compressed) => {
    const dir = tempCaptureDir();
    const originalPath = join(dir, compressed ? "older.bin.gz" : "older.bin");
    const frames = makeFrames(4);
    const bytes = capture(frames);
    writeFileSync(originalPath, compressed ? gzipSync(bytes) : bytes);
    const firstSession = await insertSession(originalPath);
    const secondSession = await insertSession(originalPath);
    const sourceRecordOffsets = frames.map((_, i) => 12 + i * (4 + frames[0]!.length));
    const lapsBefore = [
      await insertLap(firstSession, sourceRecordOffsets[1]!, 1),
      await insertLap(firstSession, sourceRecordOffsets[1]!, 2),
      await insertLap(firstSession, sourceRecordOffsets[5]!, 3),
      await insertLap(secondSession, sourceRecordOffsets[3]!, 1),
    ];
    const before = await records(originalPath);
    expect(before).toEqual(frames);

    const result = await migrateCaptures();
    expect(result.failed).toBe(0);
    expect(result).toMatchObject({ migrated: 1, failed: 0 });
    const sessionRows = await db.select().from(sessions).where(eq(sessions.id, firstSession)).get();
    const secondRow = await db.select().from(sessions).where(eq(sessions.id, secondSession)).get();
    expect(sessionRows?.captureFormatVersion).toBe(1);
    expect(sessionRows?.rawFile?.endsWith(compressed ? ".bin.gz" : ".bin")).toBe(true);
    expect(secondRow?.rawFile).toBe(sessionRows?.rawFile);
    const migratedPath = sessionRows!.rawFile!;
    expect(migratedPath).not.toBe(originalPath);
    expect(existsSync(originalPath)).toBe(false);
    const after = await recordsWithOffsets(migratedPath);
    expect(after.map(({ frame }) => frame)).toEqual(before);
    const lapsAfter = await Promise.all(lapsBefore.map((lap) => db.select().from(laps).where(eq(laps.id, lap.id)).get()));
    for (let index = 0; index < lapsBefore.length; index++) {
      expect(lapsAfter[index]).toMatchObject({
        id: lapsBefore[index]!.id,
        sessionId: lapsBefore[index]!.sessionId,
        lapNumber: lapsBefore[index]!.lapNumber,
        lapTime: lapsBefore[index]!.lapTime,
        rawFrameCount: 3,
        notes: `preserve-${lapsBefore[index]!.lapNumber}`,
      });
      const sourceIndex = sourceRecordOffsets.indexOf(lapsBefore[index]!.rawByteOffset!);
      const targetOffset = lapsAfter[index]!.rawByteOffset;
      expect(after.find((record) => record.offset === targetOffset)?.frame).toEqual(frames[sourceIndex]);
    }
    const again = await migrateCaptures();
    expect(again).toMatchObject({ migrated: 0, failed: 0, results: [] });
  });

  test.each([false, true])("preserves historical headerless capture and lap seeks (gzip=%s)", async (compressed) => {
    const dir = tempCaptureDir();
    const originalPath = join(dir, compressed ? "headerless.bin.gz" : "headerless.bin");
    const frames = makeFrames(5);
    const bytes = capture(frames).subarray(12);
    writeFileSync(originalPath, compressed ? gzipSync(bytes) : bytes);
    const sessionId = await insertSession(originalPath);
    const lap = await insertLap(sessionId, 2 * (4 + frames[0]!.length), 1);

    const result = await migrateCaptures();
    expect(result.failed).toBe(0);
    expect(result).toMatchObject({ migrated: 1, failed: 0 });
    const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    const migratedLap = await db.select().from(laps).where(eq(laps.id, lap.id)).get();
    expect(session?.captureFormatVersion).toBe(1);
    expect(session?.rawFile?.endsWith(compressed ? ".bin.gz" : ".bin")).toBe(true);
    const stored = readFileSync(session!.rawFile!);
    const decoded = compressed ? gunzipSync(stored) : stored;
    expect(decoded.readUInt32LE(0)).toBe(frames[0]!.length);
    expect((await recordsWithOffsets(session!.rawFile!)).find(({ offset }) => offset === migratedLap?.rawByteOffset)?.frame).toEqual(frames[2]);
    expect(await records(session!.rawFile!)).toEqual(frames);
    expect(migratedLap).toMatchObject({ id: lap.id, rawFrameCount: 3, notes: lap.notes });
  });

  test("retains context markers and records across segment boundaries", async () => {
    const dir = tempCaptureDir();
    const originalPath = join(dir, "segments.bin");
    const frames = makeFrames(7);
    const parts = [encodeMetaFrame(frames.length)];
    const markers = new Map([[2, encodeSegmentContextFrame()], [3, encodeSegmentContextEndFrame()], [4, encodeSegmentBoundaryFrame()]]);
    let offset = 12;
    let lapOffset = 0;
    for (let index = 0; index < frames.length; index++) {
      const marker = markers.get(index);
      if (marker) { parts.push(marker); offset += marker.length; }
      if (index === 4) lapOffset = offset;
      parts.push(encodeFrameLength(frames[index]!.length), frames[index]!);
      offset += 4 + frames[index]!.length;
    }
    writeFileSync(originalPath, Buffer.concat(parts));
    const sessionId = await insertSession(originalPath);
    const lap = await insertLap(sessionId, lapOffset, 1);
    const source = (path: string) => ({ rawFile: path, gameId: "fm-2023" as const, source: null, carOrdinal: -1, trackOrdinal: -1 });
    const readAll = async (path: string) => {
      const records: Array<{ kind: string; frame?: Buffer }> = [];
      for await (const record of iterateSessionCaptureRecordsFromSource(source(path), { strict: true })) {
        records.push(record.kind === "frame" ? { kind: record.kind, frame: record.frame } : { kind: record.kind });
      }
      return records;
    };
    const before = await readAll(originalPath);

    const result = await migrateCaptures();
    expect(result.failed).toBe(0);
    const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    const migratedLap = await db.select().from(laps).where(eq(laps.id, lap.id)).get();
    expect(await readAll(session!.rawFile!)).toEqual(before);
    expect(before.filter((record) => record.kind !== "frame").map((record) => record.kind))
      .toEqual(["segment-context", "segment-context-end", "segment-boundary"]);
    const after = await recordsWithOffsets(session!.rawFile!);
    expect(after.find((record) => record.offset === migratedLap?.rawByteOffset)?.frame).toEqual(frames[4]);
    expect(migratedLap?.rawFrameCount).toBe(lap.rawFrameCount);
  });

  test("migrates mixed raw and sparse legacy records as identical source frames", async () => {
    const dir = tempCaptureDir();
    const path = join(dir, "mixed.bin");
    const frames = makeFrames(6);
    const parts = [encodeMetaFrame(frames.length)];
    let offset = 12;
    let checkpointOffset = 12;
    for (let index = 0; index < frames.length; index++) {
      const isRaw = index === 0 || index % 2 === 0;
      const payload = isRaw
        ? frames[index]!
        : encodeGenericSparseFrame(frames[index]!, frames[index - 1]!, offset - checkpointOffset);
      if (isRaw) checkpointOffset = offset;
      parts.push(encodeFrameLength(payload.length), payload);
      offset += 4 + payload.length;
    }
    writeFileSync(path, Buffer.concat(parts));
    const sessionId = await insertSession(path);
    await insertLap(sessionId, 12, 1);
    const before = await records(path);
    expect(before).toEqual(frames);
    const result = await migrateCaptures();
    expect(result).toMatchObject({ migrated: 1, failed: 0 });
    const migrated = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(await records(migrated!.rawFile!)).toEqual(before);
  });
  test("keeps unknown legacy capture times absent and preserves known UTC", async () => {
    const dir = tempCaptureDir();
    const path = join(dir, "partly-timed.bin");
    const frames = makeFrames(9);
    const times = frames.map((_, index) => index === 0 ? undefined : 1_745_000_000_000 + index * 10);
    const parts = [encodeMetaFrame(frames.length)];
    for (let index = 0; index < frames.length; index++) {
      parts.push(encodeFrameLength(frames[index]!.length, times[index]), frames[index]!);
    }
    writeFileSync(path, Buffer.concat(parts));
    const sessionId = await insertSession(path);
    await insertLap(sessionId, 12, 1);
    const result = await migrateCaptures();
    expect(result).toMatchObject({ migrated: 1, failed: 0 });
    const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    const restored = await recordsWithOffsets(session!.rawFile!);
    expect(restored.map((record) => record.frame)).toEqual(frames);
    expect(restored.map((record) => record.frameTimeMs)).toEqual(times);
  });


  test("rewrites compressed LMU source frames when sparse gzip is smaller", async () => {
    const dir = tempCaptureDir();
    const originalPath = join(dir, "native.bin.gz");
    const template = Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE);
    let state = 0x513a729b;
    for (let index = 0; index < template.length; index++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      template[index] = state & 0xff;
    }
    LMU_SOURCE_FRAME_MAGIC.copy(template);
    template.writeUInt16LE(2, 8);
    const frames = Array.from({ length: 6 }, (_, index) => {
      const frame = Buffer.from(template);
      frame.writeUInt32LE(index, 20);
      frame[1000] = index;
      return frame;
    });
    writeFileSync(originalPath, gzipSync(capture(frames)));
    const sessionId = await insertSession(originalPath, "lmu");
    const offset = 12 + 2 * (4 + LMU_SOURCE_FRAME_V2_SIZE);
    const lap = await insertLap(sessionId, offset, 1);
    const beforeSize = readFileSync(originalPath).length;

    const result = await migrateCaptures();
    expect(result).toMatchObject({ migrated: 1, failed: 0 });
    const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    const migratedLap = await db.select().from(laps).where(eq(laps.id, lap.id)).get();
    expect(session?.rawFile?.endsWith(".bin.gz")).toBe(true);
    expect(session?.rawFile).not.toBe(originalPath);
    expect(readFileSync(session!.rawFile!).length).toBeLessThan(beforeSize);
    expect(existsSync(originalPath)).toBe(false);
    expect(await records(session!.rawFile!, "lmu")).toEqual(frames);
    expect(migratedLap?.rawByteOffset).not.toBe(offset);
  });

  test("database failure after rename preserves old capture and permits retry", async () => {
    const dir = tempCaptureDir();
    const originalPath = join(dir, "rollback.bin");
    const frames = makeFrames(8);
    writeFileSync(originalPath, capture(frames));
    const sessionId = await insertSession(originalPath);
    await insertLap(sessionId, 12 + 2 * 364, 1);
    await client.execute(`CREATE TRIGGER reject_capture_migration BEFORE UPDATE OF capture_format_version ON sessions BEGIN SELECT RAISE(ABORT, 'injected migration commit failure'); END`);
    triggerInstalled = true;

    const failed = await migrateCaptures();
    expect(failed).toMatchObject({ migrated: 0, failed: 1 });
    expect(existsSync(originalPath)).toBe(true);
    const rowAfterFailure = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(rowAfterFailure?.rawFile).toBe(originalPath);
    expect(rowAfterFailure?.captureFormatVersion).toBeNull();
    const filesAfterFailure = await records(originalPath);
    expect(filesAfterFailure).toEqual(frames);
    // Failed renamed output must not remain; source remains eligible.
    expect(readdirSync(dir)).toEqual(["rollback.bin"]);

    await client.execute("DROP TRIGGER IF EXISTS reject_capture_migration");
    triggerInstalled = false;
    const retry = await migrateCaptures();
    expect(retry).toMatchObject({ migrated: 1, failed: 0 });
    const retried = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(retried?.captureFormatVersion).toBe(1);
    expect(await records(retried!.rawFile!)).toEqual(frames);
  });

  test("corrupt and truncated historical source fail without changing DB path or bytes", async () => {
    const dir = tempCaptureDir();
    const originalPath = join(dir, "broken.bin");
    const frames = makeFrames(2);
    const bytes = capture(frames);
    writeFileSync(originalPath, bytes.subarray(0, bytes.length - 2));
    const sessionId = await insertSession(originalPath);
    await insertLap(sessionId, 12, 1);
    const result = await migrateCaptures();
    expect(result).toMatchObject({ migrated: 0, failed: 1 });
    expect(existsSync(originalPath)).toBe(true);
    expect(Buffer.compare(readFileSync(originalPath), bytes.subarray(0, bytes.length - 2))).toBe(0);
    const row = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(row?.rawFile).toBe(originalPath);
    expect(row?.captureFormatVersion).toBeNull();
  });
});
