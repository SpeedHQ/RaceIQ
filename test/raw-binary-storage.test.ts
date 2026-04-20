/**
 * Tests for raw binary lap storage: UdpRecorder meta frames, byte offset tracking,
 * and reprocessSession strategy selection (in-place vs replace).
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { UdpRecorder, META_FRAME_MAGIC } from "../server/udp-recorder";
import { reprocessSession } from "../server/reprocess";
import { db } from "../server/db/index";
import { sessions, laps } from "../server/db/schema";
import { eq } from "drizzle-orm";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";

initGameAdapters();
initServerGameAdapters();

// ── UdpRecorder: meta frame + byte offset ─────────────────────────────────────

describe("UdpRecorder meta frame", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writeMetaFrame writes magic prefix and payload", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    const recorder = new UdpRecorder();
    recorder.start(join(tmpDir, "session.bin"));

    const payload = Buffer.from("hello");
    await recorder.writeMetaFrame(payload);
    await recorder.stop();

    const buf = Buffer.from(await Bun.file(recorder.path!).arrayBuffer());
    // First 4 bytes: META_FRAME_MAGIC as uint32 LE
    expect(buf.readUInt32LE(0)).toBe(META_FRAME_MAGIC);
    // Next 4 bytes: payload length
    expect(buf.readUInt32LE(4)).toBe(payload.length);
    // Payload bytes
    expect(buf.subarray(8, 8 + payload.length)).toEqual(payload);
  });

  test("getCurrentByteOffset starts at 0 before any writes", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    const recorder = new UdpRecorder();
    recorder.start(join(tmpDir, "session.bin"));
    expect(recorder.getCurrentByteOffset()).toBe(0);
    recorder.stop();
  });

  test("getCurrentByteOffset tracks written bytes", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    const recorder = new UdpRecorder();
    recorder.start(join(tmpDir, "session.bin"));

    // meta frame: 4 (magic) + 4 (len) + 0 (empty payload) = 8 bytes
    await recorder.writeMetaFrame(Buffer.alloc(0));
    expect(recorder.getCurrentByteOffset()).toBe(8);

    // packet: 4 (len prefix) + 3 (payload) = 7 bytes
    recorder.writePacket(Buffer.from([0x01, 0x02, 0x03]));
    expect(recorder.getCurrentByteOffset()).toBe(15);

    await recorder.stop();
  });

  test("byte offset after meta frame matches where first real packet is written", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    const recorder = new UdpRecorder();
    recorder.start(join(tmpDir, "session.bin"));

    const meta = Buffer.from("state-snapshot");
    await recorder.writeMetaFrame(meta);
    const offsetAfterMeta = recorder.getCurrentByteOffset(); // = 8 + meta.length

    const pkt = Buffer.from([0xAA, 0xBB]);
    recorder.writePacket(pkt);
    await recorder.stop();

    // Verify the first packet's length prefix sits at offsetAfterMeta in the file
    const buf = Buffer.from(await Bun.file(recorder.path!).arrayBuffer());
    expect(buf.readUInt32LE(offsetAfterMeta)).toBe(pkt.length);
    expect(buf.subarray(offsetAfterMeta + 4, offsetAfterMeta + 4 + pkt.length)).toEqual(pkt);
  });
});

// ── reprocessSession ──────────────────────────────────────────────────────────

describe("reprocessSession", () => {
  let tmpDir: string;
  let sessionId: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
  });

  afterEach(async () => {
    if (sessionId) {
      await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
      await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    }
    rmSync(tmpDir, { recursive: true, force: true });
    sessionId = 0;
  });

  async function insertTestSession(rawFile: string | null, lapDetectorVersion?: string): Promise<number> {
    const row = await db
      .insert(sessions)
      .values({ carOrdinal: 1, trackOrdinal: 1, gameId: "fm-2023", rawFile, lapDetectorVersion: lapDetectorVersion ?? null })
      .returning({ id: sessions.id })
      .get();
    return row!.id;
  }

  async function insertTestLap(sessId: number, lapNumber: number, notes?: string): Promise<void> {
    await db.insert(laps).values({
      sessionId: sessId,
      lapNumber,
      lapTime: 90.0,
      isValid: true,
      notes: notes ?? null,
    }).run();
  }

  function emptyBin(path: string): void {
    // A valid .bin with only an empty meta frame, no real packets
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(META_FRAME_MAGIC, 0);
    buf.writeUInt32LE(0, 4);
    writeFileSync(path, buf);
  }

  test("throws if session has no raw file", async () => {
    sessionId = await insertTestSession(null);
    await expect(reprocessSession(sessionId)).rejects.toThrow("no raw file");
  });

  test("throws if session does not exist", async () => {
    await expect(reprocessSession(999999)).rejects.toThrow();
  });

  test("in-place strategy when lap count matches", async () => {
    // Empty bin → 0 laps detected; session with 0 existing laps → in-place
    const binPath = join(tmpDir, "session.bin");
    emptyBin(binPath);
    sessionId = await insertTestSession(binPath, "0.9.0");

    const result = await reprocessSession(sessionId);

    expect(result.strategy).toBe("in-place");
    expect(result.lapsDetected).toBe(0);
    expect(result.lapsUpdated).toBe(0);
    expect(result.sessionId).toBe(sessionId);
  });

  test("replace strategy when lap count differs", async () => {
    // Empty bin → 0 laps detected; session with 1 existing lap → replace
    const binPath = join(tmpDir, "session.bin");
    emptyBin(binPath);
    sessionId = await insertTestSession(binPath, "0.9.0");
    await insertTestLap(sessionId, 1, "my lap note");

    const result = await reprocessSession(sessionId);

    expect(result.strategy).toBe("replace");
    expect(result.lapsDetected).toBe(0);
  });

  test("replace strategy preserves no orphan laps when 0 detected", async () => {
    const binPath = join(tmpDir, "session.bin");
    emptyBin(binPath);
    sessionId = await insertTestSession(binPath, "0.9.0");
    await insertTestLap(sessionId, 1);
    await insertTestLap(sessionId, 2);

    await reprocessSession(sessionId);

    const remaining = await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all();
    expect(remaining).toHaveLength(0);
  });

  test("updates lap_detector_version on session after reprocess", async () => {
    const binPath = join(tmpDir, "session.bin");
    emptyBin(binPath);
    sessionId = await insertTestSession(binPath, "0.9.0");

    await reprocessSession(sessionId);

    const updated = await db.select({ v: sessions.lapDetectorVersion }).from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(updated?.v).not.toBe("0.9.0");
    expect(updated?.v).toBeTruthy();
  });

  test("skips additional meta frames inside bin during replay", async () => {
    // Build a bin with: meta frame + another meta frame (should be skipped gracefully)
    const binPath = join(tmpDir, "session.bin");
    const meta1 = Buffer.alloc(8);
    meta1.writeUInt32LE(META_FRAME_MAGIC, 0);
    meta1.writeUInt32LE(0, 4);
    const meta2 = Buffer.alloc(8);
    meta2.writeUInt32LE(META_FRAME_MAGIC, 0);
    meta2.writeUInt32LE(0, 4);
    writeFileSync(binPath, Buffer.concat([meta1, meta2]));

    sessionId = await insertTestSession(binPath, "0.9.0");
    // Should not throw — meta frames are silently skipped
    const result = await reprocessSession(sessionId);
    expect(result.lapsDetected).toBe(0);
  });

  test("handles truncated frame at end of file gracefully", async () => {
    const binPath = join(tmpDir, "session.bin");
    // meta frame + a truncated packet (declares 10 bytes, only 2 present)
    const meta = Buffer.alloc(8);
    meta.writeUInt32LE(META_FRAME_MAGIC, 0);
    meta.writeUInt32LE(0, 4);
    const truncated = Buffer.alloc(6);
    truncated.writeUInt32LE(10, 0); // claims 10 bytes
    truncated.writeUInt8(0xAA, 4);
    truncated.writeUInt8(0xBB, 5);
    writeFileSync(binPath, Buffer.concat([meta, truncated]));

    sessionId = await insertTestSession(binPath, "0.9.0");
    // Should not throw — truncated frame causes loop to break
    const result = await reprocessSession(sessionId);
    expect(result.lapsDetected).toBe(0);
  });
});
