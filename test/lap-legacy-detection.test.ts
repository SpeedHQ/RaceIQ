/**
 * Tests for isLegacy detection. A lap is "legacy" (pre-raw-bin-storage) only
 * when its session has no raw_file path. Per-lap rawByteOffset is NOT a
 * reliable signal — post-migration sessions can produce laps without a byte
 * offset (e.g. import-dump path feeds the pipeline without rawBuf).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../server/db/index";
import { sessions, laps } from "../server/db/schema";
import { eq } from "drizzle-orm";
import { getLaps, getLapById, getLapSummariesByTrack } from "../server/db/queries";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";

initGameAdapters();
initServerGameAdapters();

const TRACK_ORDINAL = 424242;

async function insertSession(rawFile: string | null): Promise<number> {
  const row = await db
    .insert(sessions)
    .values({ carOrdinal: 1, trackOrdinal: TRACK_ORDINAL, gameId: "fm-2023", rawFile })
    .returning({ id: sessions.id })
    .get();
  return row!.id;
}

async function insertLap(
  sessionId: number,
  lapNumber: number,
  rawByteOffset: number | null
): Promise<number> {
  const row = await db
    .insert(laps)
    .values({
      sessionId,
      lapNumber,
      lapTime: 90.0,
      isValid: true,
      rawByteOffset,
      rawFrameCount: rawByteOffset == null ? null : 1000,
    })
    .returning({ id: laps.id })
    .get();
  return row!.id;
}

describe("isLegacy detection", () => {
  const sessionIds: number[] = [];

  afterEach(async () => {
    for (const sid of sessionIds) {
      await db.delete(laps).where(eq(laps.sessionId, sid)).run();
      await db.delete(sessions).where(eq(sessions.id, sid)).run();
    }
    sessionIds.length = 0;
  });

  test("pre-migration: session with rawFile=null marks lap legacy", async () => {
    const sid = await insertSession(null);
    sessionIds.push(sid);
    const lapId = await insertLap(sid, 1, null);

    const byId = await getLapById(lapId);
    expect(byId?.isLegacy).toBe(true);

    const list = await getLaps("fm-2023", 50);
    expect(list.find((l) => l.id === lapId)?.isLegacy).toBe(true);

    const byTrack = await getLapSummariesByTrack(TRACK_ORDINAL, "fm-2023");
    expect(byTrack.find((l) => l.lapId === lapId)?.rawFile).toBeNull();
  });

  test("post-migration: session with rawFile set marks lap non-legacy even when rawByteOffset is null", async () => {
    const sid = await insertSession("/tmp/session.bin");
    sessionIds.push(sid);
    const lapId = await insertLap(sid, 1, null);

    const byId = await getLapById(lapId);
    expect(byId?.isLegacy).toBe(false);

    const list = await getLaps("fm-2023", 50);
    expect(list.find((l) => l.id === lapId)?.isLegacy).toBe(false);

    const byTrack = await getLapSummariesByTrack(TRACK_ORDINAL, "fm-2023");
    expect(byTrack.find((l) => l.lapId === lapId)?.rawFile).toBe("/tmp/session.bin");
  });

  test("post-migration: session with rawFile + rawByteOffset set marks lap non-legacy", async () => {
    const sid = await insertSession("/tmp/session.bin");
    sessionIds.push(sid);
    const lapId = await insertLap(sid, 1, 12);

    const byId = await getLapById(lapId);
    expect(byId?.isLegacy).toBe(false);

    const list = await getLaps("fm-2023", 50);
    expect(list.find((l) => l.id === lapId)?.isLegacy).toBe(false);

    const byTrack = await getLapSummariesByTrack(TRACK_ORDINAL, "fm-2023");
    expect(byTrack.find((l) => l.lapId === lapId)?.rawFile).toBe("/tmp/session.bin");
  });
});
