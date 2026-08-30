import { afterEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";
import * as replayStorage from "../../server/db/telemetry-replay-storage";
import type { SessionCaptureSource } from "../../server/session-capture/source-loader";
import { packet } from "../support/telemetry/resolver";
const realParseRawLapFrames = replayStorage.parseRawLapFrames;
const realParseSessionLapsBatched = replayStorage.parseSessionLapsBatched;

const parseRawLapFrames = mock(async () => {
  throw new Error("per-lap fallback should not run");
});
const parseSessionLapsBatched = mock(async (
  _source: SessionCaptureSource,
  metas: Array<{ id: number }>,
) => new Map(metas.map(({ id }) => [id, [packet("ac-evo")]])));
let stubsActive = false;

const parseRawLapFramesGate = (
  ...args: Parameters<typeof replayStorage.parseRawLapFrames>
) => stubsActive
  ? parseRawLapFrames()
  : realParseRawLapFrames(...args);
const parseSessionLapsBatchedGate = (
  source: SessionCaptureSource,
  metas: Parameters<typeof replayStorage.parseSessionLapsBatched>[1],
) => stubsActive
  ? parseSessionLapsBatched(source, metas)
  : realParseSessionLapsBatched(source, metas);

mock.module("../../server/db/telemetry-replay-storage", () => ({
  ...replayStorage,
  parseRawLapFrames: parseRawLapFramesGate,
  parseSessionLapsBatched: parseSessionLapsBatchedGate,
}));

// Bun module mocks are process-global and cannot be restored. These wrappers
// delegate to real implementations whenever this test is not active.
const { getLapsByIds } = await import("../../server/db/lap-read-queries");
const sessionIds: number[] = [];

afterEach(async () => {
  stubsActive = false;
  parseRawLapFrames.mockClear();
  parseSessionLapsBatched.mockClear();
  for (const sessionId of sessionIds.splice(0)) {
    await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
});

test("getLapsByIds batches cache misses from one session", async () => {
  stubsActive = true;
  const session = await db
    .insert(sessions)
    .values({
      carOrdinal: 1,
      trackOrdinal: 2,
      gameId: "ac-evo",
      rawFile: "/virtual/ac-evo-session.bin",
    })
    .returning({ id: sessions.id })
    .get();
  sessionIds.push(session.id);
  const inserted = await db
    .insert(laps)
    .values([
      { sessionId: session.id, lapNumber: 1, lapTime: 90, isValid: true, rawByteOffset: 12, rawFrameCount: 100 },
      { sessionId: session.id, lapNumber: 2, lapTime: 91, isValid: true, rawByteOffset: 1_012, rawFrameCount: 100 },
    ])
    .returning({ id: laps.id })
    .all();

  const result = await getLapsByIds(inserted.map(({ id }) => id));

  expect(result).toHaveLength(2);
  expect(parseSessionLapsBatched).toHaveBeenCalledTimes(1);
  expect(parseSessionLapsBatched.mock.calls[0]?.[1]).toHaveLength(2);
  expect(parseRawLapFrames).not.toHaveBeenCalled();
});
