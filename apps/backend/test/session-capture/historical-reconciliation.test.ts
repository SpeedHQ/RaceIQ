import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions, laps, profiles, tunes, experiments, experimentVersions, lapMetrics } from "@raceiq/backend-core/db/schema";
import { reprocessSession } from "@raceiq/backend-core/session-capture/reprocess";
import { reconcileHistoricalSessions } from "@raceiq/backend-core/session-capture/reconcile";
import { combineRecordingParts } from "@raceiq/backend-core/session-capture/combine-recording-parts";
import type { GameId } from "@raceiq/shared/games/ids";
import { encodeMetaFrame } from "@raceiq/capture-formats/session/framing";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";

initGameAdapters();
initServerGameAdapters();

const createdSessions: number[] = [];
const directories: string[] = [];
const createdProfiles: number[] = [];
const createdTunes: number[] = [];
const createdExperiments: number[] = [];

afterEach(async () => {
  if (createdSessions.length) {
    await db.delete(laps).where(inArray(laps.sessionId, createdSessions)).run();
    await db.delete(sessions).where(inArray(sessions.id, createdSessions)).run();
  }
  if (createdExperiments.length) await db.delete(experiments).where(inArray(experiments.id, createdExperiments)).run();
  if (createdTunes.length) await db.delete(tunes).where(inArray(tunes.id, createdTunes)).run();
  if (createdProfiles.length) await db.delete(profiles).where(inArray(profiles.id, createdProfiles)).run();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  createdSessions.length = 0;
  createdExperiments.length = 0;
  createdTunes.length = 0;
  createdProfiles.length = 0;
  directories.length = 0;
});

async function createSession(gameId: GameId, rawFile: string | null) {
  const row = await db.insert(sessions).values({
    gameId, carId: "wrong historical car", trackId: '["Nurburgring","GP"]',
    rawFile, lapDetectorVersion: null, notes: "keep session note", isFavorite: true,
  }).returning().get();
  createdSessions.push(row.id);
  return row;
}

function captureCopy(fixture: string) {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-historical-reconcile-"));
  directories.push(directory);
  const rawFile = join(directory, "capture.bin.gz");
  copyFileSync(fixture, rawFile);
  return rawFile;
}

describe("historical session reconciliation", () => {
  test("repairs filled Evo IDs and non-Evo laps, preserves user fields, and resumes without replaying successes", async () => {
    const profile = await db.insert(profiles).values({ name: "reconciliation profile" }).returning().get();
    createdProfiles.push(profile.id);
    const tune = await db.insert(tunes).values({
      gameId: "ac-evo", name: "reconciliation setup", author: "driver", carId: "Porsche 992 GT3 R Rennsport", category: "test", settings: "{}",
    }).returning().get();
    createdTunes.push(tune.id);
    const experiment = await db.insert(experiments).values({ gameId: "ac-evo", name: "reconciliation experiment" }).returning().get();
    createdExperiments.push(experiment.id);
    const version = await db.insert(experimentVersions).values({ experimentId: experiment.id, version: 1, label: "original setup" }).returning().get();

    const sources = [
      { gameId: "ac-evo" as const, file: "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz", carId: "Porsche 992 GT3 R Rennsport", trackId: '["Brands Hatch","GP"]' },
      { gameId: "acc" as const, file: "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz", carId: "34", trackId: "2" },
    ];
    const historical: { sessionId: number; lapId: number; lapNumber: number; carId: string; trackId: string }[] = [];
    for (const source of sources) {
      const session = await createSession(source.gameId, captureCopy(source.file));
      await reprocessSession(session.id);
      const lap = await db.select().from(laps).where(eq(laps.sessionId, session.id)).orderBy(laps.lapNumber).get();
      if (!lap) throw new Error("Committed capture did not produce expected lap");
      await db.update(laps).set({
        lapNumber: lap.lapNumber + 100, lapTime: 999, notes: "keep lap note", isFavorite: true,
        profileId: profile.id, tuneId: tune.id, experimentId: experiment.id, experimentVersionId: version.id,
        experimentExcluded: 1, experimentExcludedSource: "manual", carSetup: '{"wing":4}',
        createdAt: "2025-01-02 03:04:05", fuelPerLap: 50, tyreWear: 50,
      }).where(eq(laps.id, lap.id)).run();
      await db.insert(lapMetrics).values({ lapId: lap.id, insights: '[{"old":true}]', segmentStats: "[]" }).run();
      await db.update(sessions).set({ carId: "wrong historical car", trackId: '["Nurburgring","GP"]', lapDetectorVersion: null }).where(eq(sessions.id, session.id)).run();
      historical.push({ sessionId: session.id, lapId: lap.id, lapNumber: lap.lapNumber, carId: source.carId, trackId: source.trackId });
    }

    const missing = await createSession("ac-evo", null);
    await db.insert(laps).values({ sessionId: missing.id, lapNumber: 9, lapTime: 448.243, notes: "source unavailable", isFavorite: true }).run();
    const directory = mkdtempSync(join(tmpdir(), "raceiq-corrupt-reconcile-"));
    directories.push(directory);
    const corruptPath = join(directory, "broken.bin");
    writeFileSync(corruptPath, Buffer.from([255, 255, 255, 127]));
    const corrupt = await createSession("ac-evo", corruptPath);
    await db.insert(laps).values({ sessionId: corrupt.id, lapNumber: 10, lapTime: 1184.841, notes: "keep corrupt history" }).run();

    await reconcileHistoricalSessions();
    for (const expected of historical) {
      const session = await db.select().from(sessions).where(eq(sessions.id, expected.sessionId)).get();
      expect(session).toMatchObject({ carId: expected.carId, trackId: expected.trackId, notes: "keep session note", isFavorite: true });
      expect(session?.lapDetectorVersion).not.toBeNull();
      const lap = await db.select().from(laps).where(eq(laps.id, expected.lapId)).get();
      expect(lap).toMatchObject({
        sessionId: expected.sessionId, lapNumber: expected.lapNumber, notes: "keep lap note", isFavorite: true,
        profileId: profile.id, tuneId: tune.id, experimentId: experiment.id, experimentVersionId: version.id,
        experimentExcluded: 1, experimentExcludedSource: "manual", carSetup: '{"wing":4}', createdAt: "2025-01-02 03:04:05",
        fuelPerLap: null, tyreWear: null,
      });
      expect(lap?.lapTime).not.toBe(999);
      expect(await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, expected.lapId)).all()).toEqual([]);
    }
    for (const [session, note, time] of [[missing, "source unavailable", 448.243], [corrupt, "keep corrupt history", 1184.841]] as const) {
      expect(await db.select().from(sessions).where(eq(sessions.id, session.id)).get()).toMatchObject({ lapDetectorVersion: null, carId: "wrong historical car" });
      expect(await db.select().from(laps).where(eq(laps.sessionId, session.id)).get()).toMatchObject({ notes: note, lapTime: time });
    }
    const first = historical[0]!;
    await db.update(laps).set({ lapTime: 123.456 }).where(eq(laps.id, first.lapId)).run();
    await reconcileHistoricalSessions();
    expect(await db.select().from(laps).where(eq(laps.id, first.lapId)).get()).toMatchObject({ lapTime: 123.456, notes: "keep lap note" });
  }, { timeout: 180_000 });

  test("recomputes historical Tourist attempts with native layout and source finish times", async () => {
    const recording = await combineRecordingParts([
      "test/artifacts/sessions/ac-evo-tourist-2026-10-10.bin.gz.part1",
      "test/artifacts/sessions/ac-evo-tourist-2026-10-10.bin.gz.part2",
    ]);
    try {
      const session = await createSession("ac-evo", recording.path);
      await db.insert(laps).values({ sessionId: session.id, lapNumber: 40, lapTime: 448.243, isValid: true }).run();
      await db.insert(laps).values({ sessionId: session.id, lapNumber: 41, lapTime: 1184.841, isValid: true }).run();
      await reconcileHistoricalSessions();
      expect(await db.select().from(sessions).where(eq(sessions.id, session.id)).get()).toMatchObject({ trackId: '["Nurburgring","Touristenfahrten"]' });
      const repaired = await db.select().from(laps).where(eq(laps.sessionId, session.id)).all();
      expect(repaired.filter((lap) => lap.isValid && lap.invalidReason === null).map((lap) => lap.lapTime).sort((a, b) => a - b)).toEqual([398.781, 401.277]);
      expect(repaired.some((lap) => lap.lapTime === 448.243 || lap.lapTime === 1184.841)).toBe(false);
    } finally {
      recording.cleanup();
    }
  }, { timeout: 180_000 });
  test("keeps historical laps pending when a readable capture yields no detected laps", async () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-no-laps-reconcile-"));
    directories.push(directory);
    const rawFile = join(directory, "unrecognized.bin");
    writeFileSync(rawFile, Buffer.concat([encodeMetaFrame(1), Buffer.from([4, 0, 0, 0, 0, 0, 0, 0])]));
    const session = await createSession("ac-evo", rawFile);
    const saved = await db.insert(laps).values({
      sessionId: session.id, lapNumber: 7, lapTime: 401.277, notes: "unrecoverable annotation", isFavorite: true,
    }).returning().get();
    await reconcileHistoricalSessions();
    expect(await db.select().from(laps).where(eq(laps.id, saved.id)).get()).toMatchObject({
      lapNumber: 7, lapTime: 401.277, notes: "unrecoverable annotation", isFavorite: true,
    });
    expect(await db.select().from(sessions).where(eq(sessions.id, session.id)).get()).toMatchObject({
      lapDetectorVersion: null, carId: "wrong historical car",
    });
  });
});
