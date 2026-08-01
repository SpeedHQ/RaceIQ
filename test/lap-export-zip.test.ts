/**
 * buildLapsZip — the export half of the lap/session ZIP feature.
 *
 * The zip is a *slice of the session's raw capture*, not a re-encoded blob, so
 * what matters here is the byte maths: which frames land in the slice, that the
 * 12-byte meta frame is re-prepended, that the +1 trigger frame needed to
 * complete the final lap on replay is included, and that the manifest lists
 * every lap the importer will actually recreate (including laps that fall
 * *between* two cherry-picked ones).
 *
 * Uses the real (test) SQLite DB directly — same convention as
 * laps-issues-route.test.ts — since getLapsRaw joins laps→sessions with no
 * mockable seam. Frames are synthetic: buildLapsZip never parses them.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { unzipSync } from "fflate";
import { gunzipSync } from "zlib";
import { rmSync } from "fs";
import { db } from "../server/db/index";
import { sessions, laps } from "../server/db/schema";
import { eq } from "drizzle-orm";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { META_FRAME_MAGIC } from "../server/session-recorder";
import { buildLapsZip, LAPS_ZIP_VERSION, type LapsZipManifest } from "../server/zip";
import {
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
  IRacingSourceFrameEncoder,
  isIRacingSessionFrame,
  type IRacingSourceFrameV2,
} from "../server/games/iracing/source-frame";
import type { GameId } from "../shared/types";

initGameAdapters();
initServerGameAdapters();

const PAYLOAD = 8;
const FRAME = 4 + PAYLOAD; // uint32 LE length prefix + payload
const META = 12;
/** Byte offset of frame `i` in a capture that starts with the meta frame. */
const frameAt = (i: number) => META + i * FRAME;

/** [meta frame][len][payload]... with payload[0] = frame index, so slices are identifiable. */
function makeCapture(frameCount: number): Buffer {
  const buf = Buffer.alloc(META + frameCount * FRAME);
  buf.writeUInt32LE(META_FRAME_MAGIC, 0);
  buf.writeUInt32LE(4, 4);
  buf.writeUInt32LE(0, 8);
  for (let i = 0; i < frameCount; i++) {
    const at = frameAt(i);
    buf.writeUInt32LE(PAYLOAD, at);
    buf.writeUInt8(i, at + 4);
  }
  return buf;
}

/** Frame indices present in an exported slice, read back from payload[0]. */
function frameIndices(slice: Buffer): number[] {
  const out: number[] = [];
  let at = META;
  while (at + 4 <= slice.length) {
    const len = slice.readUInt32LE(at);
    if (len <= 0 || at + 4 + len > slice.length) break;
    out.push(slice.readUInt8(at + 4));
    at += 4 + len;
  }
  return out;
}

function readEntry(bytes: Uint8Array, file: string): Buffer {
  const unzipped = unzipSync(bytes);
  expect(Object.keys(unzipped)).toContain(file);
  return Buffer.from(gunzipSync(Buffer.from(unzipped[file])));
}

function readManifest(bytes: Uint8Array): LapsZipManifest {
  const unzipped = unzipSync(bytes);
  return JSON.parse(new TextDecoder().decode(unzipped["manifest.json"]));
}

describe("buildLapsZip", () => {
  const sessionIds: number[] = [];
  const tmpFiles: string[] = [];

  afterEach(async () => {
    for (const sid of sessionIds) {
      await db.delete(laps).where(eq(laps.sessionId, sid)).run();
      await db.delete(sessions).where(eq(sessions.id, sid)).run();
    }
    sessionIds.length = 0;
    for (const f of tmpFiles) rmSync(f, { force: true });
    tmpFiles.length = 0;
  });

  async function insertSession(
    rawFile: string | null,
    gameId: GameId = "fm-2023",
  ): Promise<number> {
    const row = await db
      .insert(sessions)
      .values({ carOrdinal: 3000, trackOrdinal: 434343, gameId, rawFile })
      .returning({ id: sessions.id })
      .get();
    sessionIds.push(row!.id);
    return row!.id;
  }

  async function insertLap(
    sessionId: number,
    lapNumber: number,
    rawByteOffset: number | null,
    rawFrameCount: number | null
  ): Promise<number> {
    const row = await db
      .insert(laps)
      .values({
        sessionId,
        lapNumber,
        lapTime: 90 + lapNumber,
        isValid: true,
        rawByteOffset,
        rawFrameCount,
      })
      .returning({ id: laps.id })
      .get();
    return row!.id;
  }

  /** 5-frame capture, laps at frames [0,1], [2,3], [4]. */
  async function fixture(): Promise<{ sid: number; lapIds: number[] }> {
    const path = `${process.env.DATA_DIR ?? "."}/zip-test-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
    await Bun.write(path, makeCapture(5));
    tmpFiles.push(path);
    const sid = await insertSession(path);
    const lapIds = [
      await insertLap(sid, 1, frameAt(0), 2),
      await insertLap(sid, 2, frameAt(2), 2),
      await insertLap(sid, 3, frameAt(4), 1),
    ];
    return { sid, lapIds };
  }

  test("single lap exports its frames plus the trigger frame that completes it", async () => {
    const { lapIds } = await fixture();
    const { bytes, manifest } = await buildLapsZip([lapIds[0]]);

    expect(manifest.version).toBe(LAPS_ZIP_VERSION);
    expect(manifest.entries).toHaveLength(1);

    const slice = readEntry(bytes, manifest.entries[0].file);
    expect(slice.readUInt32LE(0)).toBe(META_FRAME_MAGIC); // meta frame re-prepended
    expect(frameIndices(slice)).toEqual([0, 1, 2]); // lap 1's frames + 1 trigger
  });

  test("manifest lists laps carried along inside the exported span", async () => {
    const { lapIds } = await fixture();
    // Cherry-pick laps 1 and 3 — lap 2 sits between them and rides along.
    const { bytes, manifest } = await buildLapsZip([lapIds[0], lapIds[2]]);

    const slice = readEntry(bytes, manifest.entries[0].file);
    expect(frameIndices(slice)).toEqual([0, 1, 2, 3, 4]);
    expect(manifest.entries[0].laps.map((l) => l.lapNumber)).toEqual([1, 2, 3]);
  });

  test("entry filename starts with the gameId so import can detect the game", async () => {
    const { lapIds } = await fixture();
    const { manifest } = await buildLapsZip([lapIds[0]]);
    expect(manifest.entries[0].file.startsWith("fm-2023-")).toBe(true);
    expect(manifest.entries[0].file.endsWith(".bin.gz")).toBe(true);
    expect(manifest.entries[0].gameId).toBe("fm-2023");
  });

  test("manifest.json is present and round-trips", async () => {
    const { lapIds } = await fixture();
    const { bytes, manifest } = await buildLapsZip([lapIds[0]]);
    expect(readManifest(bytes)).toEqual(JSON.parse(JSON.stringify(manifest)));
  });

  test("iRacing later-lap slices carry the preceding session frame", async () => {
    const encoder = new IRacingSourceFrameEncoder();
    const base: IRacingSourceFrameV2 = {
      schemaVersion: 2,
      session: {
        sessionId: 1,
        subSessionId: 2,
        sessionNum: 0,
        driverCarIdx: 0,
        trackId: 434343,
        trackName: "Packed Test Track",
        trackLengthM: 5000,
        sectorStarts: [0, 0.5],
        carId: 3000,
        carName: "Packed Test Car",
        carClassId: 1,
        carClassName: "Test",
        engineIdleRpm: 900,
        engineRedlineRpm: 8000,
        engineCylinderCount: 8,
      },
      values: { SessionTick: 0 },
    };
    const frames = [0, 1, 2, 3].map((tick) =>
      encoder.encode({
        ...base,
        values: { SessionTick: tick },
      }),
    );
    const offsets: number[] = [];
    let offset = META;
    const records = frames.map((frame) => {
      offsets.push(offset);
      const record = Buffer.allocUnsafe(4 + frame.length);
      record.writeUInt32LE(frame.length, 0);
      frame.copy(record, 4);
      offset += record.length;
      return record;
    });
    const meta = makeCapture(0).subarray(0, META);
    const path = `${process.env.DATA_DIR ?? "."}/zip-test-iracing-${Date.now()}.bin`;
    await Bun.write(path, Buffer.concat([meta, ...records]));
    tmpFiles.push(path);

    const sid = await insertSession(path, "iracing");
    const lapId = await insertLap(sid, 2, offsets[2]!, 1);
    const { bytes, manifest } = await buildLapsZip([lapId]);
    const slice = readEntry(bytes, manifest.entries[0]!.file);

    const exportedFrames: Buffer[] = [];
    let at = META;
    while (at + 4 <= slice.length) {
      const length = slice.readUInt32LE(at);
      if (length <= 0 || at + 4 + length > slice.length) break;
      exportedFrames.push(slice.subarray(at + 4, at + 4 + length));
      at += 4 + length;
    }
    expect(exportedFrames).toHaveLength(3);
    expect(isIRacingSessionFrame(exportedFrames[0]!)).toBe(true);

    const decoder = createIRacingSourceDecoderState();
    expect(
      exportedFrames.map(
        (frame) =>
          decodeIRacingSourceFrame(frame, decoder)?.values.SessionTick,
      ),
    ).toEqual([0, 2, 3]);
  });

  test("unknown lap ids are rejected", async () => {
    await expect(buildLapsZip([-1])).rejects.toThrow(/No laps matched/);
  });

  test("laps with no raw capture are rejected rather than exported empty", async () => {
    const sid = await insertSession(null); // legacy row: no capture on disk
    const lapId = await insertLap(sid, 1, null, null);
    await expect(buildLapsZip([lapId])).rejects.toThrow(/raw capture/);
  });

  test("a capture missing from disk is skipped", async () => {
    const path = `${process.env.DATA_DIR ?? "."}/zip-test-gone-${Date.now()}.bin`;
    const sid = await insertSession(path); // never written
    const lapId = await insertLap(sid, 1, frameAt(0), 2);
    await expect(buildLapsZip([lapId])).rejects.toThrow(/raw capture/);
  });
});
