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
let parallelGate = false;
const pendingParses: Array<() => void> = [];
let resolveAllParsesStarted: (() => void) | undefined;
const parseSessionLapsBatched = mock(async (
  _source: SessionCaptureSource,
  metas: Array<{ id: number }>,
) => {
  if (parallelGate) {
    await new Promise<void>((resolve) => {
      pendingParses.push(resolve);
      if (pendingParses.length === 2) resolveAllParsesStarted?.();
    });
  }
  return new Map(metas.map(({ id }) => [id, [packet("ac-evo")]]));
});
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

const { getLapsByIds } = await import("../../server/db/lap-read-queries");

// Bun module mocks are process-global and cannot be restored. These wrappers
const sessionIds: number[] = [];
afterEach(async () => {
  stubsActive = false;
  parallelGate = false;
  resolveAllParsesStarted = undefined;
  pendingParses.splice(0).forEach((resolve) => resolve());
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

  const result = await getLapsByIds(inserted.map(({ id }) => id), { parallelSessionDecodes: true });

  expect(result).toHaveLength(2);
  expect(parseSessionLapsBatched).toHaveBeenCalledTimes(1);
  expect(parseSessionLapsBatched.mock.calls[0]?.[1]).toHaveLength(2);
  expect(parseRawLapFrames).not.toHaveBeenCalled();
});

test("getLapsByIds decodes different sessions in parallel and preserves order", async () => {
  stubsActive = true;
  parallelGate = true;
  const insertedSessions = await db
    .insert(sessions)
    .values([
      { carOrdinal: 1, trackOrdinal: 2, gameId: "ac-evo", rawFile: "/virtual/session-a.bin" },
      { carOrdinal: 1, trackOrdinal: 2, gameId: "ac-evo", rawFile: "/virtual/session-b.bin" },
    ])
    .returning({ id: sessions.id })
    .all();
  sessionIds.push(...insertedSessions.map(({ id }) => id));
  const inserted = await db
    .insert(laps)
    .values(insertedSessions.map(({ id }, index) => ({
      sessionId: id,
      lapNumber: index + 1,
      lapTime: 90 + index,
      isValid: true,
      rawByteOffset: 12,
      rawFrameCount: 100,
    })))
    .returning({ id: laps.id })
    .all();
  const requestedIds = inserted.map(({ id }) => id).reverse();

  let allParsesStarted = new Promise<void>((resolve) => {
    resolveAllParsesStarted = resolve;
  });
  const resultPromise = getLapsByIds(requestedIds, { parallelSessionDecodes: true });
  await allParsesStarted;
  expect(pendingParses).toHaveLength(2);
  pendingParses.splice(0).forEach((resolve) => resolve());

  const result = await resultPromise;
  expect(parseSessionLapsBatched).toHaveBeenCalledTimes(2);
  expect(result.map(({ id }) => id)).toEqual(requestedIds);
});
