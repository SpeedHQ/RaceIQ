import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { eq, inArray } from "drizzle-orm";
import { db, client } from "@raceiq/backend-core/db/index";
import { commitSessionDownsample, commitSessionDownsampleCap } from "@raceiq/backend-core/db/lap-reprocessing-queries";
import { compareAnalyses, dashboardSummaryState, experiments, lapAnalyses, lapMetrics, laps, lineSpreadCache, sessions } from "@raceiq/backend-core/db/schema";
import { iterateSessionFrames } from "@raceiq/capture-formats/session/framing";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";
import { initServerGameAdapters } from "../../src/games/init";
import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { processDashboardSession } from "@raceiq/backend-core/session-capture/dashboard-processor";
const trackedSessions: number[] = [];
const trackedLaps: number[] = [];
const trackedExperiments: number[] = [];
const path = resolve("recording-publication-test.bin");
const fixture = resolve(import.meta.dir, "../../../../test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz");
const tempDirs: string[] = [];

beforeAll(() => initServerGameAdapters(developmentReleaseFeatures));

const newPath = resolve("recording-publication-test-downsample.bin");

async function seedSession(rawFile = path, cap: number | null = null) {
  const result = await db
    .insert(sessions)
    .values({ gameId: "fm-2023", carId: "publication-test", trackId: "publication-test", rawFile, downsampledFrequencyHz: cap, notes: "session notes" })
    .returning({ id: sessions.id })
    .get();
  trackedSessions.push(result.id);
  await db.update(dashboardSummaryState).set({ captureDirty: 0, captureReady: 1 }).where(eq(dashboardSummaryState.sessionId, result.id));
  return result.id;
}
async function seedLap(sessionId: number, rawByteOffset: number | null, rawFrameCount: number | null, favorite = false) {
  const result = await db
    .insert(laps)
    .values({
      sessionId,
      lapNumber: trackedLaps.length + 1,
      lapTime: 91,
      isValid: true,
      isFavorite: favorite,
      notes: "lap notes",
      tuneId: null,
      profileId: null,
      carSetup: '{"x":1}',
      experimentId: null,
      rawByteOffset,
      rawFrameCount,
      fuelPerLap: 4.5,
      tyreWear: 0.2,
    })
    .returning({ id: laps.id })
    .get();
  trackedLaps.push(result.id);
  await db.insert(lapMetrics).values({ lapId: result.id, insights: "{}", segmentStats: "{}" });
  await db.insert(lapAnalyses).values({ lapId: result.id, analysis: "cached" });
  return result.id;
}
async function clean() {
  if (trackedLaps.length) {
    await db.delete(compareAnalyses).where(inArray(compareAnalyses.lapAId, trackedLaps));
    await db.delete(compareAnalyses).where(inArray(compareAnalyses.lapBId, trackedLaps));
    await db.delete(lapMetrics).where(inArray(lapMetrics.lapId, trackedLaps));
    await db.delete(lapAnalyses).where(inArray(lapAnalyses.lapId, trackedLaps));
    await db.delete(laps).where(inArray(laps.id, trackedLaps));
    trackedLaps.length = 0;
  }
  if (trackedSessions.length) {
    await db.delete(dashboardSummaryState).where(inArray(dashboardSummaryState.sessionId, trackedSessions));
    for (const id of trackedSessions.splice(0)) await deleteSession(id);
  }
  if (trackedExperiments.length) {
    const experimentIds = trackedExperiments.splice(0);
    await db.delete(lineSpreadCache).where(inArray(lineSpreadCache.experimentId, experimentIds));
    await db.delete(experiments).where(inArray(experiments.id, experimentIds));
  }
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
}
afterEach(clean);

test("validated publication makes capture facts processable without postcommit finalization", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "downsample-publication-"));
  tempDirs.push(dir);
  const converted = await convertSeedFramesToSparse("acc", iterateSessionFrames(gunzipSync(await readFile(fixture))));
  tempDirs.push(dirname(converted.path));
  const replacement = resolve(dir, "replacement.bin");
  await writeFile(replacement, await readFile(converted.path));
  const session = await db.insert(sessions).values({
    gameId: "acc", carId: "7", trackId: "8", ownership: "mine",
    createdAt: "2026-04-23T16:42:16.158Z", sessionType: "practice", rawFile: converted.path,
  }).returning({ id: sessions.id }).get();
  trackedSessions.push(session.id);
  await commitSessionDownsample({
    oldRawFile: converted.path, newRawFile: replacement, sessionIds: [session.id], targetHz: 50, lapIndexes: [],
  });
  expect(await db.select().from(dashboardSummaryState).where(eq(dashboardSummaryState.sessionId, session.id)).get())
    .toMatchObject({ captureDirty: 1, captureReady: 1 });
  expect(await processDashboardSession(session.id)).toBe(true);
  const summary = await client.execute({
    sql: `SELECT st.capture_dirty, st.source_revision, st.published_revision,
      p.duration_status, p.sector_status, p.weather_status
      FROM dashboard_summary_state st JOIN dashboard_session_summaries p ON p.session_id=st.session_id
      WHERE st.session_id=?`,
    args: [session.id],
  });
  const facts = summary.rows[0];
  expect(facts?.capture_dirty).toBe(0);
  expect(facts?.published_revision).toBe(facts?.source_revision);
  expect(facts?.duration_status).toMatch(/^(available|unavailable)$/);
  expect(facts?.sector_status).toMatch(/^(available|unavailable)$/);
  expect(facts?.weather_status).toMatch(/^(available|unavailable)$/);
});

test("full publication atomically updates shared aliases and indexes while preserving user metadata and invalidating derived data", async () => {
  const first = await seedSession(path, 90);
  const second = await seedSession(relative(process.cwd(), path), 70);
  const a = await seedLap(first, 100, 20);
  const b = await seedLap(second, 100, 20);
  const nullIndex = await seedLap(first, null, 0);
  const experiment = await db.insert(experiments).values({ gameId: "fm-2023", name: "Recording publication" }).returning({ id: experiments.id }).get();
  trackedExperiments.push(experiment.id);
  await db.update(laps).set({ experimentId: experiment.id }).where(inArray(laps.id, [a, b, nullIndex]));
  await db.insert(compareAnalyses).values({ lapAId: a, lapBId: b, analysis: "compare" });
  await db.insert(lineSpreadCache).values({ experimentId: experiment.id, lapSetHash: "set", trace: "trace" });
  await commitSessionDownsample({
    oldRawFile: path,
    newRawFile: newPath,
    sessionIds: [first, second],
    targetHz: 50,
    lapIndexes: [
      { lapId: a, expectedRawByteOffset: 100, expectedRawFrameCount: 20, rawByteOffset: 80, rawFrameCount: 12 },
      { lapId: b, expectedRawByteOffset: 100, expectedRawFrameCount: 20, rawByteOffset: 80, rawFrameCount: 12 },
    ],
  });
  const updatedSessions = await db
    .select()
    .from(sessions)
    .where(inArray(sessions.id, [first, second]))
    .all();
  expect(updatedSessions.map((s) => s.rawFile)).toEqual([newPath, newPath]);
  expect(updatedSessions.map((s) => s.downsampledFrequencyHz)).toEqual([50, 50]);
  expect(updatedSessions.map((s) => s.notes)).toEqual(["session notes", "session notes"]);
  const updated = await db
    .select()
    .from(laps)
    .where(inArray(laps.id, [a, b, nullIndex]))
    .all();
  expect(updated.find((l) => l.id === a)).toMatchObject({ rawByteOffset: 80, rawFrameCount: 12, fuelPerLap: null, tyreWear: null, notes: "lap notes", lapTime: 91, carSetup: '{"x":1}' });
  expect(updated.find((l) => l.id === nullIndex)).toMatchObject({ rawByteOffset: null, rawFrameCount: 0, fuelPerLap: null });
  expect(updated.map(lap => lap.experimentId)).toEqual([experiment.id, experiment.id, experiment.id]);
  expect(
    await db
      .select()
      .from(lapMetrics)
      .where(inArray(lapMetrics.lapId, [a, b, nullIndex]))
      .all(),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(lapAnalyses)
      .where(inArray(lapAnalyses.lapId, [a, b, nullIndex]))
      .all(),
  ).toHaveLength(0);
  expect(await db.select().from(lineSpreadCache).where(eq(lineSpreadCache.experimentId, experiment.id)).all()).toHaveLength(0);
  expect(
    await db
      .select()
      .from(dashboardSummaryState)
      .where(inArray(dashboardSummaryState.sessionId, [first, second]))
      .all(),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ captureDirty: 1, captureReady: 1 })]));
});

test("cap-only publication preserves lower caps and leaves indexes and derived caches intact", async () => {
  const first = await seedSession(path, 40);
  const second = await seedSession(path, null);
  const a = await seedLap(first, 10, 5);
  const b = await seedLap(second, 20, 6);
  await commitSessionDownsampleCap({
    oldRawFile: path,
    sessionIds: [first, second],
    targetHz: 50,
    lapIndexes: [
      { lapId: a, expectedRawByteOffset: 10, expectedRawFrameCount: 5 },
      { lapId: b, expectedRawByteOffset: 20, expectedRawFrameCount: 6 },
    ],
  });
  expect(
    (
      await db
        .select()
        .from(sessions)
        .where(inArray(sessions.id, [first, second]))
        .all()
    ).map((s) => s.downsampledFrequencyHz),
  ).toEqual([40, 50]);
  expect(
    await db
      .select()
      .from(lapMetrics)
      .where(inArray(lapMetrics.lapId, [a, b]))
      .all(),
  ).toHaveLength(2);
  expect(
    await db
      .select()
      .from(lapAnalyses)
      .where(inArray(lapAnalyses.lapId, [a, b]))
      .all(),
  ).toHaveLength(2);
  expect(
    (
      await db
        .select()
        .from(laps)
        .where(inArray(laps.id, [a, b]))
        .all()
    ).map((l) => [l.rawByteOffset, l.rawFrameCount, l.fuelPerLap]),
  ).toEqual([
    [10, 5, 4.5],
    [20, 6, 4.5],
  ]);
});

test("stale references, changed indexes, and favorites reject without partial database mutation", async () => {
  const first = await seedSession(path);
  const a = await seedLap(first, 100, 20);
  const before = await db.select().from(sessions).where(eq(sessions.id, first)).get();
  await expect(
    commitSessionDownsample({
      oldRawFile: path,
      newRawFile: newPath,
      sessionIds: [first],
      targetHz: 50,
      lapIndexes: [{ lapId: a, expectedRawByteOffset: 101, expectedRawFrameCount: 20, rawByteOffset: 80, rawFrameCount: 12 }],
    }),
  ).rejects.toThrow("lap indexes changed");
  expect(await db.select().from(sessions).where(eq(sessions.id, first)).get()).toEqual(before);
  expect((await db.select().from(laps).where(eq(laps.id, a)).get())?.rawByteOffset).toBe(100);
  await db.update(laps).set({ isFavorite: true }).where(eq(laps.id, a));
  await expect(commitSessionDownsampleCap({ oldRawFile: path, sessionIds: [first], targetHz: 50, lapIndexes: [{ lapId: a, expectedRawByteOffset: 100, expectedRawFrameCount: 20 }] })).rejects.toThrow(
    "favorite",
  );
  expect((await db.select().from(sessions).where(eq(sessions.id, first)).get())?.downsampledFrequencyHz).toBeNull();
});
