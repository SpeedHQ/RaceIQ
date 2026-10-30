import { updateSessionRawFile } from "@raceiq/backend-core/db/session-queries";
import { afterEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import * as replayStorage from "@raceiq/backend-core/db/telemetry-replay-storage";
import type { SessionCaptureSource } from "@raceiq/backend-core/session-capture/source-loader";
import { packet } from "@raceiq/telemetry-core/test-support/telemetry/resolver";
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

mock.module("@raceiq/backend-core/db/telemetry-replay-storage", () => ({
  ...replayStorage,
  parseRawLapFrames: parseRawLapFramesGate,
  parseSessionLapsBatched: parseSessionLapsBatchedGate,
}));

const { getLapById, getLapMetaForProfileScope, getLapsByIds, getSessionLaps } = await import("@raceiq/backend-core/db/lap-read-queries");

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
      carId: "1",
      trackId: "2",
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

test("lap export readiness includes usable legacy raw captures and published bundles", async () => {
  const complete = await db.insert(sessions).values({
    carId: "1", trackId: "2", gameId: "ac-evo",
    captureLayoutVersion: 1, captureManifestFile: "/captures/session-1/manifest.json",
  }).returning({ id: sessions.id }).get();
  const incomplete = await db.insert(sessions).values({
    carId: "1", trackId: "2", gameId: "ac-evo", captureLayoutVersion: 1,
  }).returning({ id: sessions.id }).get();
  const legacy = await db.insert(sessions).values({
    carId: "1", trackId: "2", gameId: "ac-evo", rawFile: "/captures/legacy.bin",
  }).returning({ id: sessions.id }).get();
  sessionIds.push(complete.id, incomplete.id, legacy.id);
  await db.insert(laps).values([
    { sessionId: complete.id, lapNumber: 1, lapTime: 90, isValid: true, captureChunkId: "lap-1" },
    { sessionId: complete.id, lapNumber: 2, lapTime: 91, isValid: true },
    { sessionId: incomplete.id, lapNumber: 1, lapTime: 92, isValid: true, captureChunkId: "lap-3" },
    { sessionId: legacy.id, lapNumber: 1, lapTime: 93, isValid: true, rawByteOffset: 12, rawFrameCount: 100 },
  ]).run();

  const publishedLaps = await getSessionLaps("ac-evo", complete.id);
  const unpublishedLaps = await getSessionLaps("ac-evo", incomplete.id);
  const legacyLaps = await getSessionLaps("ac-evo", legacy.id);

  expect(publishedLaps.map(({ lapNumber, standaloneCaptureReady }) => [lapNumber, standaloneCaptureReady])).toEqual([
    [1, true], [2, false],
  ]);
  expect(unpublishedLaps[0]?.standaloneCaptureReady).toBe(false);
  expect(legacyLaps[0]?.standaloneCaptureReady).toBe(true);
});

test("unpublished and empty legacy captures remain unavailable without binary retries", async () => {
  const inserted = await db.insert(sessions).values([
    { carId: "1", trackId: "2", gameId: "ac-evo", rawFile: "/captures/legacy-manifest.json" },
    { carId: "1", trackId: "2", gameId: "ac-evo", captureLayoutVersion: 1, captureManifestFile: "/captures/registered-manifest.json", rawFile: "/captures/registered-manifest.json" },
    { carId: "1", trackId: "2", gameId: "ac-evo", rawFile: "/captures/empty.bin" },
  ]).returning({ id: sessions.id }).all();
  sessionIds.push(...inserted.map(({ id }) => id));
  const insertedLaps = await db.insert(laps).values([
    { sessionId: inserted[0]!.id, lapNumber: 1, lapTime: 90, isValid: true, rawByteOffset: 115165, rawFrameCount: 0 },
    { sessionId: inserted[0]!.id, lapNumber: 2, lapTime: 91, isValid: true, rawByteOffset: 115165, rawFrameCount: 1 },
    { sessionId: inserted[1]!.id, lapNumber: 3, lapTime: 92, isValid: true, rawByteOffset: 115165, rawFrameCount: 1 },
    { sessionId: inserted[2]!.id, lapNumber: 4, lapTime: 93, isValid: true, rawByteOffset: 12, rawFrameCount: 0 },
  ]).returning({ id: laps.id }).all();
  const ids = insertedLaps.map(({ id }) => id);
  const single = await getSessionLaps("ac-evo", inserted[0]!.id);
  expect(single.map(({ telemetryAvailable, standaloneCaptureReady }) => [telemetryAvailable, standaloneCaptureReady])).toEqual([[false, false], [false, false]]);
  const profile = await getLapMetaForProfileScope("ac-evo", "1", "2");
  expect(profile.filter(({ id }) => ids.includes(id)).map(({ telemetryAvailable, standaloneCaptureReady }) => [telemetryAvailable, standaloneCaptureReady])).toEqual(ids.map(() => [false, false]));
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const id of ids) {
      const result = await getLapById(id);
      expect(result).toMatchObject({ telemetry: [], telemetryAvailable: false, standaloneCaptureReady: false });
      expect(result).not.toHaveProperty("parseError");
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const parallelSessionDecodes of [false, true]) {
      const result = await getLapsByIds(ids, { parallelSessionDecodes });
      expect(result.map(({ id, telemetry, parseError }) => [id, telemetry.length, parseError])).toEqual(ids.map((id) => [id, 0, undefined]));
      expect(result.map(({ telemetryAvailable, standaloneCaptureReady }) => [telemetryAvailable, standaloneCaptureReady])).toEqual(ids.map(() => [false, false]));
    }
  }
  expect(parseRawLapFrames).not.toHaveBeenCalled();
  expect(parseSessionLapsBatched).not.toHaveBeenCalled();
});

test("manifest registration becomes layout-aware before manifest persistence", async () => {
  const session = await db.insert(sessions).values({ carId: "1", trackId: "2", gameId: "ac-evo" }).returning({ id: sessions.id }).get();
  sessionIds.push(session.id);
  const inserted = await db.insert(laps).values({ sessionId: session.id, lapNumber: 1, lapTime: 90, isValid: true, rawByteOffset: 115165, rawFrameCount: 1 }).returning({ id: laps.id }).get();
  await updateSessionRawFile(session.id, "/captures/pending/manifest.json", "test-detector");

  const lap = await getLapById(inserted.id);
  expect(lap).toMatchObject({ telemetry: [], telemetryAvailable: false, standaloneCaptureReady: false });
  expect(lap?.parseError).toBeUndefined();
  expect(parseRawLapFrames).not.toHaveBeenCalled();
});

test("getLapsByIds decodes different sessions in parallel and preserves order", async () => {
  stubsActive = true;
  parallelGate = true;
  const insertedSessions = await db
    .insert(sessions)
    .values([
      { carId: "1", trackId: "2", gameId: "ac-evo", rawFile: "/virtual/session-a.bin" },
      { carId: "1", trackId: "2", gameId: "ac-evo", rawFile: "/virtual/session-b.bin" },
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
