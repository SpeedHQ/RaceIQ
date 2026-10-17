import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { iracingRoutes } from "../../src/routes/games/iracing";
import { createIRacingIncidentFixture, createIRacingIncidentMainFixture, type IRacingIncidentFixture, type IRacingIncidentFixtureRecord } from "../support/iracing-incident-fixture";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";

initGameAdapters({ iracingAdapter: true, f1Experiments: true });
initServerGameAdapters({ iracingAdapter: true, f1Experiments: true });

const sessionIds: number[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  for (const sessionId of sessionIds.splice(0)) {
    await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface WindowInput { lapId: number; lapNumber: number; rawByteOffset: number; rawFrameCount: number; isValid?: boolean; lapTime?: number; invalidReason?: string }
async function seed(fixture: IRacingIncidentFixture | null, options: { gameId?: string; source?: string; windows?: WindowInput[]; malformedTail?: Buffer; sharedRawFile?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "raceiq-iracing-incidents-"));
  tempDirs.push(dir);
  const rawFile = fixture ? options.sharedRawFile ?? join(dir, "capture.ibt") : options.sharedRawFile ?? null;
  if (fixture && !options.sharedRawFile) await writeFile(rawFile!, options.malformedTail ? Buffer.concat([fixture.bytes, options.malformedTail]) : fixture.bytes);
  else if (fixture && options.malformedTail) await writeFile(rawFile!, Buffer.concat([fixture.bytes, options.malformedTail]));
  const inserted = await db.insert(sessions).values({ gameId: options.gameId ?? "iracing", carId: "incident-fixture-car", trackId: "incident-fixture-track", source: options.source ?? "ibt", rawFile })
    .returning({ id: sessions.id }).get();
  const sessionId = inserted!.id;
  sessionIds.push(sessionId);
  const windows: WindowInput[] = options.windows ?? fixture?.windows.map((w, i) => ({ lapId: w.lapId, lapNumber: i + 1, rawByteOffset: w.rawByteOffset, rawFrameCount: w.rawFrameCount })) ?? [];
  const lapIds: number[] = [];
  for (const window of windows) {
    const lap = await db.insert(laps).values({ sessionId, lapNumber: window.lapNumber, lapTime: window.lapTime ?? 40, isValid: window.isValid ?? true,
      invalidReason: window.invalidReason ?? null, rawByteOffset: window.rawByteOffset, rawFrameCount: window.rawFrameCount })
      .returning({ id: laps.id }).get();
    lapIds.push(lap!.id);
  }
  return { sessionId, lapIds, windows };
}
function sample(lapId: number, index: number, values: Record<string, number | boolean | string | Array<number | boolean>> = {}, extra: Record<string, unknown> = {}): IRacingIncidentFixtureRecord {
  return { kind: "sample", sample: { lapId, values: { SessionTime: 50 + index * 0.05, SessionTick: 1000 + index, Lap: lapId,
    LapCurrentLapTime: index * 0.05, LapLastLapTime: 0, PlayerCarIdx: 0, PlayerCarMyIncidentCount: 0, PlayerTrackSurface: 3, Speed: 20, ...values }, ...extra } };
}
const report = (id: number) => iracingRoutes.request(`/api/iracing/sessions/${id}/incidents`);

describe("iRacing incident report endpoint", () => {
  test("isolates lap windows in gzip shared capture and resolves trimmed replay cursor with simulator time", async () => {
    const records: IRacingIncidentFixtureRecord[] = [];
    for (let i = 0; i < 2; i++) records.push(sample(10, i, { SessionTime: 60 + i * .05, SessionTick: 1200 + i, Lap: 0, LapCurrentLapTime: 20 + i * .05 }, { owned: false, frameTimeMs: 1_790_000_000_000 + i * 50 }));
    for (let i = 0; i < 8; i++) records.push(sample(11, i, { SessionTime: 60.1 + i * .05, SessionTick: 1300 + i, Lap: 1, LapCurrentLapTime: i * .05,
      PlayerCarMyIncidentCount: i >= 2 ? 1 : 0, Speed: i === 2 ? 41.234 : 30 + i }, { frameTimeMs: 1_790_000_000_000 + (i + 2) * 50 }));
    records.push(sample(12, 10, { SessionTime: 60.5, SessionTick: 1308, Lap: 2, LapCurrentLapTime: 0, LapLastLapTime: .4 }, { owned: false, frameTimeMs: 1_790_000_000_000 + 500 }));
    const fixture = createIRacingIncidentFixture({ records, gzip: true });
    const seeded = await seed(fixture, { windows: [{ lapId: 11, lapNumber: 4, rawByteOffset: fixture.samples[0]!.rawOffset, rawFrameCount: 10, isValid: false }] });
    const response = await report(seeded.sessionId);
    expect(response.status).toBe(200);
    const body = await response.json() as { observedIncidentPoints: number | null; events: Array<{ kind: string; replay: { frameIndex: number; lapTimeSec: number | null } | null }> };
    expect(body.observedIncidentPoints).toBe(1);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.kind).toBe("incident-points");
    expect(body.events[0]!.replay).not.toBeNull();
    const replay = await getLapById(seeded.lapIds[0]!);
    expect(replay).toBeTruthy();
    expect(replay!.telemetry[body.events[0]!.replay!.frameIndex]!.Speed).toBe(41.234);
  });

  test("reports personal count increases and sampled spans from owned windows only", async () => {
    const seeded = await seed(createIRacingIncidentMainFixture());
    const response = await report(seeded.sessionId);
    expect(response.status).toBe(200);
    const body = await response.json() as { observedIncidentPoints: number | null; offTrackSpans: number | null; events: Array<{ kind: string; points?: number }> };
    expect(body.observedIncidentPoints).toBe(3);
    expect(body.offTrackSpans).toBe(2);
    expect(body.events.filter((e) => e.kind === "incident-points").map((e) => e.points)).toEqual([1, 2]);
    expect(body.events).toHaveLength(4);
  });

  test("isolates second session sharing source path from foreign lap frames", async () => {
    const fixture = createIRacingIncidentMainFixture();
    const first = await seed(fixture);
    const sharedRawFile = (await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, first.sessionId)).get())!.rawFile!;
    const second = await seed(fixture, { sharedRawFile, windows: [{ lapId: 99, lapNumber: 7, rawByteOffset: fixture.windows[1]!.rawByteOffset, rawFrameCount: fixture.windows[1]!.rawFrameCount }] });
    const body = await (await report(second.sessionId)).json();
    expect(body.coverage.totalLaps).toBe(1);
    expect(body.observedIncidentPoints).toBe(2);
    expect(body.events.every((event: { lapId: number }) => event.lapId === second.lapIds[0])).toBe(true);
  });

  test("leaves missing or ambiguous retained replay matches without targets", async () => {
    const records = [sample(1, 0, { PlayerCarMyIncidentCount: 0 }), sample(1, 1, { PlayerCarMyIncidentCount: 1, SessionTime: 50, SessionTick: 1000 }),
      sample(1, 2, { PlayerCarMyIncidentCount: 2, SessionTime: 50, SessionTick: 1000 })];
    const fixture = createIRacingIncidentFixture({ records });
    const window = fixture.windows[0]!;
    const seeded = await seed(fixture, { windows: [{ lapId: 1, lapNumber: 1, rawByteOffset: window.rawByteOffset, rawFrameCount: window.rawFrameCount }] });
    const body = await (await report(seeded.sessionId)).json();
    expect(body.events.filter((event: { kind: string }) => event.kind === "incident-points").every((event: { replay: unknown }) => event.replay === null)).toBe(true);
  });

  test("ignores metadata/context as observations and recovers after malformed frame", async () => {
    const fixture = createIRacingIncidentFixture({ records: [
      sample(1, 0, { PlayerCarMyIncidentCount: 0 }, { owned: false }),
      { kind: "malformed", bytes: Buffer.from([4, 0, 0, 0, 1, 2, 3, 4]) },
      sample(1, 1, { PlayerCarMyIncidentCount: 1 }, { owned: false }),
      { kind: "segment-boundary" },
      { kind: "sample", sample: { context: true, values: { SessionTime: 50.1, SessionTick: 1002, PlayerCarMyIncidentCount: 50, PlayerTrackSurface: 0 } } },
      sample(1, 3, { PlayerCarMyIncidentCount: 2 }, { owned: false }),
      sample(1, 4, { PlayerCarMyIncidentCount: 3 }, { owned: false }),
    ], metadataFrames: 2 });
    const seeded = await seed(fixture, { windows: [{ lapId: 1, lapNumber: 1, rawByteOffset: fixture.samples[0]!.rawOffset, rawFrameCount: fixture.samples.length + 1 }] });
    const response = await report(seeded.sessionId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.observedIncidentPoints).toBe(1);
    expect(body.events.filter((event: { kind: string }) => event.kind === "incident-points").map((event: { points: number }) => event.points)).toEqual([1]);
  });

  test("does not fall back from absent personal count to flags or team counter", async () => {
    const records = [0, 1, 2].map((index) => {
      const record = sample(1, index, { PlayerIncidents: 9, PlayerCarTeamIncidentCount: 20 + index });
      if (record.kind === "sample") delete record.sample.values.PlayerCarMyIncidentCount;
      return record;
    });
    const seeded = await seed(createIRacingIncidentFixture({ records }));
    const body = await (await report(seeded.sessionId)).json();
    expect(body.observedIncidentPoints).toBeNull();
    expect(body.coverage.incidentStatus).toBe("unavailable");
    expect(body.offTrackSpans).toBe(0);
  });

  test("fails when malformed tail is required by saved lap window", async () => {
    const fixture = createIRacingIncidentFixture({ records: [sample(1, 0), sample(1, 1)] });
    const window = fixture.windows[0]!;
    const required = await seed(fixture, { malformedTail: Buffer.from([0xff, 0xff, 0xff, 0xff]), windows: [
      { lapId: 1, lapNumber: 1, rawByteOffset: window.rawByteOffset, rawFrameCount: window.rawFrameCount + 1 },
    ] });
    expect((await report(required.sessionId)).status).toBe(500);
  });


  test("returns unavailable evidence for absent source, MoTeC archive, missing windows and missing file", async () => {
    const absent = await seed(null);
    expect((await (await report(absent.sessionId)).json()).coverage.reasons).toContain("capture-unavailable");
    const motec = await seed(null, { source: "motec" });
    expect((await (await report(motec.sessionId)).json()).coverage.reasons).toContain("unsupported-capture");
    const fixture = createIRacingIncidentMainFixture();
    const missingWindow = await seed(fixture, { windows: [{ lapId: 1, lapNumber: 1, rawByteOffset: fixture.decompressedBytes.length + 50, rawFrameCount: 2 }] });
    expect((await (await report(missingWindow.sessionId)).json()).coverage.reasons).toContain("missing-lap-window");
    const missingFile = await seed(fixture);
    await rm(join(tempDirs[tempDirs.length - 1]!, "capture.ibt"));
    expect((await (await report(missingFile.sessionId)).json()).coverage.reasons).toContain("capture-unavailable");
  });

  test("marks short, overlapping and misaligned windows partial", async () => {
    const fixture = createIRacingIncidentMainFixture();
    const first = fixture.windows[0]!;
    const short = await seed(fixture, { windows: [{ lapId: 1, lapNumber: 1, rawByteOffset: first.rawByteOffset, rawFrameCount: fixture.samples.length + 10 }] });
    expect((await (await report(short.sessionId)).json()).coverage.reasons).toContain("missing-lap-window");
    const overlap = await seed(fixture, { windows: [
      { lapId: 1, lapNumber: 1, rawByteOffset: first.rawByteOffset, rawFrameCount: 2 },
      { lapId: 2, lapNumber: 2, rawByteOffset: first.rawByteOffset, rawFrameCount: 2 },
    ] });
    expect((await (await report(overlap.sessionId)).json()).coverage.reasons).toContain("missing-lap-window");
    const misaligned = await seed(fixture, { windows: [{ lapId: 1, lapNumber: 1, rawByteOffset: first.rawByteOffset + 1, rawFrameCount: 2 }] });
    expect((await (await report(misaligned.sessionId)).json()).coverage.reasons).toContain("missing-lap-window");
  });

  test("keeps clean-streak eligibility separate and preserves surface evidence when personal counter is absent", async () => {
    const records: IRacingIncidentFixtureRecord[] = [];
    for (let lap = 1; lap <= 4; lap++) for (let i = 0; i < 3; i++) records.push(sample(lap, (lap - 1) * 3 + i, { PlayerCarMyIncidentCount: 0, PlayerTrackSurface: i === 1 ? 0 : 3,
      PlayerIncidents: 99, PlayerCarTeamIncidentCount: 100 }));
    const fixture = createIRacingIncidentFixture({ records });
    const windows = fixture.windows.map((w, i) => ({ lapId: w.lapId, lapNumber: i + 1, rawByteOffset: w.rawByteOffset, rawFrameCount: w.rawFrameCount,
      isValid: i !== 1, invalidReason: i === 2 ? "outlap" : undefined }));
    const eligible = await seed(fixture, { windows });
    const body = await (await report(eligible.sessionId)).json();
    expect(body.coverage.surfaceStatus).not.toBe("unavailable");
    expect(body.offTrackSpans).toBe(4);
    expect(body.observedIncidentPoints).toBe(0);
    expect(body.longestCleanLapStreak).toBe(1);

    const missingCounter = [sample(21, 0), sample(21, 1, { PlayerTrackSurface: 0 }), sample(21, 2, { PlayerTrackSurface: 3 })];
    for (const record of missingCounter) if (record.kind === "sample") delete record.sample.values.PlayerCarMyIncidentCount;
    const surfaceOnly = await seed(createIRacingIncidentFixture({ records: missingCounter }));
    const independent = await (await report(surfaceOnly.sessionId)).json();
    expect(independent.observedIncidentPoints).toBeNull();
    expect(independent.offTrackSpans).toBe(1);
  });

  test("decodes context, stops before malformed unowned tail and fails on malformed owned frames", async () => {
    const fixture = createIRacingIncidentMainFixture();
    expect((await report((await seed(fixture, { malformedTail: Buffer.from([0xff, 0xff, 0xff, 0xff]) })).sessionId)).status).toBe(200);
    const malformed = createIRacingIncidentFixture({ records: [sample(1, 0), { kind: "malformed" }, sample(1, 2)] });
    const failed = await report((await seed(malformed)).sessionId);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain("capture.ibt");
    const context = createIRacingIncidentFixture({ records: [
      { kind: "sample", sample: { owned: false, values: { SessionTime: 50, SessionTick: 1000, PlayerCarMyIncidentCount: 0, PlayerTrackSurface: 3 } } },
      { kind: "segment-boundary" }, { kind: "segment-context" },
      { kind: "sample", sample: { context: true, values: { SessionTime: 50.1, SessionTick: 1002, PlayerCarMyIncidentCount: 0, PlayerTrackSurface: 3 } } },
      { kind: "segment-context-end" }, sample(2, 2),
    ] });
    expect((await report((await seed(context)).sessionId)).status).toBe(200);
  });

  test("returns 404 for wrong-game and absent sessions before capture access", async () => {
    const wrong = await seed(null, { gameId: "acc" });
    const response = await report(wrong.sessionId);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
    expect((await report(2_000_000_000)).status).toBe(404);
  });
});
