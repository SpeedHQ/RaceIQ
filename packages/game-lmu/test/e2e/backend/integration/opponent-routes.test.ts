import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { importSessionBin } from "@raceiq/backend-core/session-capture/import-capture";
import { startSessionOpponentRemoval } from "@raceiq/backend-core/session-capture/opponent-removal";
import { getRecordingMaintenanceController } from "@raceiq/backend-core/session-capture/maintenance-runtime";
import { SparseSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { lmuServerAdapter } from "@raceiq/game-lmu";
import { registerServerGame } from "@raceiq/backend-core/games/registry";
import { encodeLmuResolvedValue } from "@raceiq/shared/telemetry/lmu-context";
import { describe, expect, test } from "bun:test";
import type { LmuCompetitor, LmuLiveContext } from "@raceiq/shared/telemetry/lmu";
import type { ResolvedValue } from "@raceiq/shared/telemetry/resolver/contracts";
import { replayRoutes } from "@raceiq/lap-replay/server";
import { alignLmuOpponentPositionTraces, buildLmuOpponentSemanticFrames, groupOpponentSessions } from "@raceiq/lap-replay/test-support/opponents";
import { indexLmuOpponentLaps, projectLmuOpponentTelemetry, LmuOpponentSourceError, type LmuOpponentCaptureFrame } from "@raceiq/backend-core/lap-analysis/lmu-opponent-laps";

const observation = <T>(semanticId: string, value: T | null, sequence = 1n): ResolvedValue<T> => ({
  semanticId, value, unit: semanticId.startsWith("motion.competitor.position.") || semanticId.endsWith("lap-distance") ? "m" :
    semanticId.endsWith("orientation") ? "matrix" : semanticId.endsWith(".speed") ? "m/s" : "s", mappingStatus: "direct",
  state: "ok", confidence: 1, freshness: "fresh",
  confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 },
  provenance: {
    simulator: "lmu", parserId: "lmu-native", parserVersion: "1", sourceChannel: semanticId,
    resolverVersion: "1", catalogVersion: "1", catalogHash: "fixture",
    observedAt: { domain: "session", milliseconds: Number(sequence) }, sourceObservation: {
      timestamp: { domain: "session", milliseconds: Number(sequence) }, updateSequence: sequence,
    },
  }, schemaVersion: "1", limitations: [],
});

function sourceUpdate(frame: LmuOpponentCaptureFrame, sequence: bigint, milliseconds = Number(sequence)): LmuOpponentCaptureFrame {
  const timestamp = { domain: "session" as const, milliseconds };
  const competitors = frame.competitors.map((competitor) => ({
    ...competitor,
    channels: Object.fromEntries(Object.entries(competitor.channels).map(([semanticId, channel]) => [
      semanticId,
      {
        ...channel,
        provenance: {
          ...channel.provenance,
          observedAt: timestamp,
          sourceObservation: { timestamp, updateSequence: sequence },
        },
      },
    ])),
  }));
  return {
    ...frame,
    competitors,
    ...(frame.lmuContext ? { lmuContext: { ...frame.lmuContext, competitors } } : {}),
  };
}

function frame(sequence: number, distance: number, lap = 1): LmuOpponentCaptureFrame {
  const update = BigInt(sequence);
  const channels = {
    "race.competitor.lap-distance": observation("race.competitor.lap-distance", distance, update),
    "race.competitor.current-lap-number": observation("race.competitor.current-lap-number", lap, update),
    "race.competitor.last-lap-time": observation("race.competitor.last-lap-time", 101.2, update),
    "race.competitor.scoring-time": observation("race.competitor.scoring-time", 10 + distance * 100, update),
    "race.competitor.lap-start-time": observation("race.competitor.lap-start-time", 10, update),
    "motion.competitor.position.x": observation("motion.competitor.position.x", distance * 10, update),
    "motion.competitor.position.y": observation("motion.competitor.position.y", 4, update),
    "motion.competitor.position.z": observation("motion.competitor.position.z", distance * -20, update),
    "motion.competitor.speed": observation("motion.competitor.speed", 50, update),
    "motion.competitor.orientation": observation("motion.competitor.orientation", [0, 0, -1, 0, 1, 0, 1, 0, 0], update),
    "identity.competitor.driver-name": observation("identity.competitor.driver-name", "Driver A", update),
  };
  const context: LmuLiveContext = {
    schemaVersion: 1,
    key: { sessionKey: "session-generation-1", captureSequence: String(sequence), frameTime: { domain: "session", milliseconds: sequence * 20 } },
    playerVehicleId: null, status: "active", supplemental: [],
    competitors: [{ vehicleId: 2, incarnation: 0, isPlayer: false, channels }],
  };
  const competitor: LmuCompetitor = context.competitors![0]!;
  return {
    sessionKey: context.key.sessionKey, captureSequence: context.key.captureSequence,
    frameTime: sequence * 20, competitors: [competitor], sourceFrame: Buffer.alloc(0), parserBootstrap: null, lmuContext: context,
  };
}


describe("opponent lap indexing", () => {
  test("requires two observed metre-distance wraps for complete coverage", () => {
    const frames = [
      frame(1, 400, 1), frame(2, 850, 1), frame(3, 3, 2),
      frame(4, 500, 2), frame(5, 990, 2), frame(6, 4, 3),
    ];
    const laps = indexLmuOpponentLaps(frames);
    expect(laps).toHaveLength(2);
    expect(laps.map(({ coverage }) => coverage)).toEqual(["partial", "complete"]);
    expect(laps[0]).toMatchObject({ startSequence: "1", endSequence: "3", lapNumber: 1 });
    expect(laps[1]).toMatchObject({ startSequence: "3", endSequence: "6", lapNumber: 2 });
    expect(indexLmuOpponentLaps([frame(1, 400, 1), frame(2, 600, 1), frame(3, 350, 1), frame(4, 700, 1)]))
      .toHaveLength(1);
    expect(indexLmuOpponentLaps([frame(1, 400, 1), frame(2, 3, 4)])).toHaveLength(1);
  });

  test("resynchronizes after lap-counter jump without completing across it", () => {
    const laps = indexLmuOpponentLaps([
      frame(1, 400, 1), frame(2, 700, 1), frame(3, 20, 4),
      frame(4, 800, 4), frame(5, 5, 5), frame(6, 900, 5), frame(7, 2, 6),
    ]);
    expect(laps.map(({ coverage }) => coverage)).toEqual(["partial", "partial", "complete"]);
    expect(laps[2]).toMatchObject({ startSequence: "5", endSequence: "7", lapNumber: 5 });
  });
  test("keeps scalar lap reports from creating laps and rebuilds stable identities", () => {
    const frames = [frame(1, 400), frame(2, 500), frame(3, 3, 2)];
    const first = indexLmuOpponentLaps(frames);
    const rebuilt = indexLmuOpponentLaps(frames);
    expect(first.map((lap) => lap.opponentLapId)).toEqual(rebuilt.map((lap) => lap.opponentLapId));
    expect(first[0]).toMatchObject({
      coverage: "partial", validity: "unknown", lapNumber: 1,
      sessionKey: "session-generation-1", vehicleId: 2, incarnation: 0,
    });
    expect(indexLmuOpponentLaps([frame(1, 400), frame(2, 500)])[0]).toMatchObject({ coverage: "partial" });
  });

  test("projects source-backed opponent values into canonical replay semantics", () => {
    const competitor = frame(1, 0.5).competitors[0]!;
    const projected = projectLmuOpponentTelemetry(competitor);
    const value = (semanticId: string) => projected.find((entry) => entry.semanticId === semanticId);
    expect(value("motion.position-x")).toMatchObject({ value: 5, state: "ok" });
    expect(value("motion.position-y")).toMatchObject({ value: 4, state: "ok" });
    expect(value("motion.position-z")).toMatchObject({ value: -10, state: "ok" });
    expect(value("motion.speed")).toMatchObject({ value: 50, state: "ok" });
    expect(value("motion.yaw")).toMatchObject({ value: Math.PI / 2, state: "ok", mappingStatus: "derived" });
    expect(value("timing.distance-traveled")).toMatchObject({ value: 0.5, state: "ok" });
    expect(value("timing.current-lap")).toMatchObject({ value: 50, state: "ok", mappingStatus: "derived" });

    const orientation = competitor.channels["motion.competitor.orientation"]!;
    const badMatrix = {
      ...competitor,
      channels: { ...competitor.channels, "motion.competitor.orientation": { ...orientation, value: [1] } },
    };
    expect(projectLmuOpponentTelemetry(badMatrix).find((entry) => entry.semanticId === "motion.yaw"))
      .toMatchObject({ value: null, state: "missing" });
    for (const matrix of [
      [0, 0, Number.NaN, 0, 1, 0, 1, 0, 0],
      Array.from({ length: 9 }, () => 0),
    ]) {
      const invalidMatrix = {
        ...competitor,
        channels: { ...competitor.channels, "motion.competitor.orientation": { ...orientation, value: matrix } },
      };
      expect(projectLmuOpponentTelemetry(invalidMatrix).find((entry) => entry.semanticId === "motion.yaw"))
        .toMatchObject({ value: null, state: "missing" });
    }

    const lapStart = competitor.channels["race.competitor.lap-start-time"]!;
    const mismatchedClock = {
      ...competitor,
      channels: {
        ...competitor.channels,
        "race.competitor.lap-start-time": {
          ...lapStart,
          provenance: {
            ...lapStart.provenance,
            sourceObservation: { ...lapStart.provenance.sourceObservation!, updateSequence: 2n },
          },
        },
      },
    };
    expect(projectLmuOpponentTelemetry(mismatchedClock).find((entry) => entry.semanticId === "timing.current-lap"))
      .toMatchObject({ value: null, state: "missing" });
  });

  test("uses safe replay ordinals for large scoring counters and leaves gaps between observations", () => {
    const start = 9_007_199_254_740_993n;
    const interval = indexLmuOpponentLaps([
      sourceUpdate(frame(1, 300, 1), start),
      sourceUpdate(frame(2, 500, 1), start + 1n),
      sourceUpdate(frame(3, 900, 1), start + 3n),
      sourceUpdate(frame(4, 2, 2), start + 4n),
    ])[0]!;
    const replay = buildLmuOpponentSemanticFrames(interval);
    expect(replay.map(({ sequence }) => sequence)).toEqual([1, 2, 4]);
    expect(replay.map(({ sequence }) => Number.isSafeInteger(sequence))).toEqual([true, true, true]);
    const value = replay[2]!.values.find((entry) => entry.semanticId === "timing.current-lap")!;
    expect((value as ResolvedValue<number>).provenance.sourceObservation?.updateSequence).toBe(start + 3n);
    expect(value.limitations).toContain("1 source scoring update(s) unavailable before this frame.");
    expect(() => buildLmuOpponentSemanticFrames(indexLmuOpponentLaps([
      sourceUpdate(frame(1, 300), start), sourceUpdate(frame(2, 500), start - 1n),
      sourceUpdate(frame(3, 900), start + 1n), sourceUpdate(frame(4, 2, 2), start + 2n),
    ])[0]!)).toThrow(LmuOpponentSourceError);
    const repeated = indexLmuOpponentLaps([
      sourceUpdate(frame(1, 300), start), sourceUpdate(frame(2, 500), start),
      sourceUpdate(frame(3, 900), start + 1n), sourceUpdate(frame(4, 2, 2), start + 2n),
    ])[0]!;
    expect(buildLmuOpponentSemanticFrames(repeated).map(({ sequence }) => sequence)).toEqual([1, 2]);
  });

  test("preserves forward-clock counter restarts as discontinuous opponent observations", () => {
    const interval = indexLmuOpponentLaps([
      sourceUpdate(frame(1, 300), 23n, 3_320_200),
      sourceUpdate(frame(2, 500), 2n, 3_320_800),
      sourceUpdate(frame(3, 700), 1n, 3_331_000),
      sourceUpdate(frame(4, 900), 1n, 3_331_600),
      sourceUpdate(frame(5, 2, 2), 2n, 3_332_000),
    ])[0]!;
    const replay = buildLmuOpponentSemanticFrames(interval);
    expect(replay.map((entry) => entry.sequence)).toEqual([1, 3, 5, 7]);
    expect(replay.map((entry) => entry.observedAt.milliseconds)).toEqual([3_320_200, 3_320_800, 3_331_000, 3_331_600]);
    expect(replay.map((entry) => (entry.values[0] as ResolvedValue<number>).provenance.sourceObservation?.updateSequence))
      .toEqual([23n, 2n, 1n, 1n]);
    expect(replay.map((entry) => entry.values.find((value) => value.semanticId === "motion.position-x")?.value))
      .toEqual([3000, 5000, 7000, 9000]);
  });

  test("leaves replay gaps for missing native captures even when scoring counters are adjacent", () => {
    const interval = indexLmuOpponentLaps([
      sourceUpdate(frame(1, 300), 1n), sourceUpdate(frame(3, 900), 2n), sourceUpdate(frame(4, 2, 2), 3n),
    ])[0]!;
    expect(buildLmuOpponentSemanticFrames(interval).map((entry) => entry.sequence)).toEqual([1, 3]);
  });

  test("replays canonical samples on scoring timestamps with source gaps retained", () => {
    const interval = indexLmuOpponentLaps([
      frame(1, 300, 1),
      sourceUpdate(frame(2, 500), 3n),
      sourceUpdate(frame(3, 900), 4n),
      frame(4, 2, 2),
      frame(5, 500, 2),
      frame(6, 900, 2),
      frame(7, 3, 3),
    ])[1]!;
    const frames = buildLmuOpponentSemanticFrames(interval);
    expect(frames.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(frames[0]).toMatchObject({
      observedAt: { domain: "session", milliseconds: 4 },
      receivedAt: { domain: "wall-clock", milliseconds: 80 },
      lmu: { key: { captureSequence: "4" } },
    });
    expect(frames[0]?.values.map((entry) => entry.semanticId)).toEqual([
      "motion.position-x", "motion.position-y", "motion.position-z", "motion.speed",
      "timing.distance-traveled", "motion.yaw", "timing.current-lap",
    ]);
    expect(frames[0]?.values.find((entry) => entry.semanticId === "timing.current-lap"))
      .toMatchObject({ value: 200, state: "ok" });
    const repeated = indexLmuOpponentLaps([
      frame(1, 300, 1), frame(2, 900, 1), frame(3, 2, 2),
      frame(4, 900, 2), frame(5, 3, 3),
    ])[1]!;
    expect(buildLmuOpponentSemanticFrames(repeated).map((entry) => entry.sequence)).toEqual([1, 2]);
  });

  test("builds distance-aligned position traces without interpolating across source-update gaps", () => {
    const opponent = indexLmuOpponentLaps([
      frame(1, 0.01), frame(2, 0.5), frame(3, 0.99), frame(4, 0.01, 2),
    ])[0]!;
    const playerRows = [frame(1, 0.01), frame(2, 0.5), frame(3, 0.99)].map((source) => ({
      competitor: { ...source.competitors[0]!, vehicleId: 1, isPlayer: true },
      captureSequence: source.captureSequence,
    }));
    const traces = alignLmuOpponentPositionTraces(playerRows, opponent, { step: 0.1, start: 0.1, end: 0.9 });
    if (!traces || "error" in traces) throw new Error("Expected paired position traces");
    const x = traces.traces.find((trace) => trace.semanticId === "motion.position-x");
    expect(x?.player[0]).toMatchObject({ state: "ok", mappingStatus: "derived" });
    expect(x?.player[0]?.value).toBeCloseTo(1, 12);
    expect(x?.opponent[0]).toMatchObject({ state: "ok", mappingStatus: "derived" });
    expect(x?.opponent[0]?.value).toBeCloseTo(1, 12);
    expect(traces.traces.find((trace) => trace.semanticId === "motion.speed")?.player[0])
      .toMatchObject({ value: 50, unit: "m/s", state: "ok", mappingStatus: "derived" });

    const gappedPlayerRows = [frame(1, 0.01), frame(2, 0.5), frame(4, 0.99)].map((source) => ({
      competitor: { ...source.competitors[0]!, vehicleId: 1, isPlayer: true },
      captureSequence: source.captureSequence,
    }));
    const gapped = alignLmuOpponentPositionTraces(gappedPlayerRows, opponent, { step: 0.1, start: 0.1, end: 0.9 });
    if (!gapped || "error" in gapped) throw new Error("Expected gapped trace response");
    expect(gapped.traces.find((trace) => trace.semanticId === "motion.position-x")?.player[6])
      .toMatchObject({ value: null, state: "missing" });
    expect(gapped.traces.find((trace) => trace.semanticId === "motion.speed")?.player[6])
      .toMatchObject({ value: null, state: "missing" });
  });

  test("keeps new positions when a restarted counter repeats at later source times", () => {
    const frames = [
      sourceUpdate(frame(1, 10), 1n, 1000),
      sourceUpdate(frame(2, 50), 1n, 2000),
      sourceUpdate(frame(3, 90), 1n, 3000),
      sourceUpdate(frame(4, 2, 2), 1n, 4000),
    ];
    const opponent = indexLmuOpponentLaps(frames)[0]!;
    const playerRows = [frame(1, 10), frame(2, 50), frame(3, 90)].map((source) => ({
      competitor: { ...source.competitors[0]!, vehicleId: 1, isPlayer: true }, captureSequence: source.captureSequence,
    }));
    const aligned = alignLmuOpponentPositionTraces(playerRows, opponent, { step: 40 });
    if (!aligned || "error" in aligned) throw new Error("Expected recorded positions after counter restart");
    expect(aligned.traces.find((trace) => trace.semanticId === "motion.position-x")?.opponent.map((value) => value.value))
      .toEqual([100, 500, 900]);
  });

  test("preserves capture continuity across repeated scoring observations", () => {
    for (const [duplicateCapture, nextCapture, expectedSequence, expectedMiddle] of [
      [2, 3, 2, 500],
      [3, 4, 3, null],
    ] as const) {
      const interval = indexLmuOpponentLaps([
        sourceUpdate(frame(1, 10), 1n, 1000),
        sourceUpdate(frame(duplicateCapture, 10), 1n, 1000),
        sourceUpdate(frame(nextCapture, 90), 2n, 2000),
        sourceUpdate(frame(nextCapture + 1, 2, 2), 3n, 3000),
      ])[0]!;
      expect(buildLmuOpponentSemanticFrames(interval).map((entry) => entry.sequence)).toEqual([1, expectedSequence]);
      const playerRows = [frame(1, 10), frame(2, 90)].map((source) => ({
        competitor: { ...source.competitors[0]!, vehicleId: 1, isPlayer: true }, captureSequence: source.captureSequence,
      }));
      const aligned = alignLmuOpponentPositionTraces(playerRows, interval, { step: 40 });
      if (!aligned || "error" in aligned) throw new Error("Expected gap-preserving source position trace");
      expect(aligned.traces.find((trace) => trace.semanticId === "motion.position-x")?.opponent.map((value) => value.value))
        .toEqual([100, expectedMiddle, 900]);
    }
  });

  test("separates reused vehicle identity by incarnation", () => {
    const old = frame(1, 0.5);
    const departed: LmuOpponentCaptureFrame = { ...frame(2, 0.6), competitors: [] };
    const rejoined = frame(3, 0.4);
    const next = frame(4, 0.6);
    const competitor = rejoined.competitors[0]!;
    const nextCompetitor = next.competitors[0]!;
    rejoined.competitors = [{ ...competitor, incarnation: 1 }];
    next.competitors = [{ ...nextCompetitor, incarnation: 1 }];
    const laps = indexLmuOpponentLaps([old, departed, rejoined, next]);
    expect(laps).toHaveLength(2);
    expect(laps[0]?.opponentLapId).not.toBe(laps[1]?.opponentLapId);
    expect(laps.every((lap) => lap.coverage === "partial")).toBe(true);
  });

  test("groups same-name opponents only by generation, vehicle ID, and incarnation", () => {
    const lap = (opponentLapId: string, sessionKey: string, vehicleId: number, incarnation: number, lapNumber: number) => ({
      opponentLapId, sessionKey, vehicleId, incarnation, lapNumber,
      driverName: "Same driver", carName: "Same car", className: "Same class",
      coverage: "partial" as const, validity: "unknown" as const,
      lapTime: encodeLmuResolvedValue(observation<number>("race.competitor.last-lap-time", null)),
      sectors: [], comparableSemanticIds: [], mode: "timing-only" as const, reasons: [],
    });
    const laps = [
      lap("b-lap-2", "generation-b", 7, 0, 2),
      lap("a-lap-1", "generation-a", 7, 0, 1),
      lap("a-rejoin", "generation-a", 7, 1, 1),
      lap("other-vehicle", "generation-a", 8, 0, 1),
      lap("a-lap-1-earlier-id", "generation-a", 7, 0, 1),
    ];
    const sessions = groupOpponentSessions(laps);
    expect(sessions).toHaveLength(4);
    expect(new Set(sessions.map((session) => session.opponentSessionId)).size).toBe(4);
    expect(sessions.map((session) => [session.sessionKey, session.vehicleId, session.incarnation, session.lapIds]))
      .toEqual([
        ["generation-a", 7, 0, ["a-lap-1", "a-lap-1-earlier-id"]],
        ["generation-b", 7, 0, ["b-lap-2"]],
        ["generation-a", 7, 1, ["a-rejoin"]],
        ["generation-a", 8, 0, ["other-vehicle"]],
      ]);
  });
});

describe("opponent route serialization", () => {
  test("imports native capture and returns completed/partial timing through HTTP", async () => {
    initGameAdapters();
    registerServerGame(lmuServerAdapter);
    const imported = await importSessionBin(makeLmuOpponentCapture(), "lmu", {
      notifyDriverProfile: false,
      recorder: new SparseSessionRecorderAdapter("mine", {}, "offline"),
    });
    const sessionIds = [...new Set(imported.laps.map((lap) => lap.sessionId))];
    try {
      const lapId = imported.laps[0]!.lapId;
      const response = await replayRoutes.request(`/api/laps/${lapId}/opponent-laps`, { headers: { "X-Game-Id": "lmu" } });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        sourceRevision: string;
        sessions: { opponentSessionId: string; sessionKey: string; vehicleId: number; incarnation: number;
          driverName: string | null; carName: string | null; className: string | null; lapIds: string[] }[];
        laps: { opponentLapId: string; sessionKey: string; vehicleId: number; incarnation: number;
          lapNumber: number | null; lapTime: { value: number | null; state: string }; coverage: string }[];
      };
      const repeated = await replayRoutes.request(`/api/laps/${lapId}/opponent-laps`, { headers: { "X-Game-Id": "lmu" } });
      const repeatedBody = await repeated.json() as typeof body;
      expect(body.sessions).toEqual(repeatedBody.sessions);
      expect(body.sessions.length).toBeGreaterThan(0);
      expect(new Set(body.sessions.map((session) => session.opponentSessionId)).size).toBe(body.sessions.length);
      for (const session of body.sessions) {
        const grouped = body.laps.filter((lap) => lap.sessionKey === session.sessionKey &&
          lap.vehicleId === session.vehicleId && lap.incarnation === session.incarnation)
          .sort((a, b) => (a.lapNumber ?? 0) - (b.lapNumber ?? 0) || a.opponentLapId.localeCompare(b.opponentLapId))
          .map((lap) => lap.opponentLapId);
        expect(session.lapIds).toEqual(grouped);
      }
      expect(body.laps.every((lap) => body.sessions.some((session) => session.lapIds.includes(lap.opponentLapId)))).toBe(true);
      const completed = body.laps.find((lap) => lap.coverage === "complete");
      const partial = body.laps.findLast((lap) => lap.coverage === "partial");
      expect(completed?.lapTime.value).toBe(18);
      expect(partial?.lapTime).toMatchObject({ value: null, state: "missing" });
      expect(JSON.stringify(body)).not.toContain("BigInt");
      const semantic = await replayRoutes.request(
        `/api/laps/${lapId}/opponent-laps/${completed!.opponentLapId}/semantic-telemetry?sourceRevision=${body.sourceRevision}`,
        { headers: { "X-Game-Id": "lmu" } },
      );
      expect(semantic.status, await semantic.clone().text()).toBe(200);
      const replay = await semantic.json() as { envelopes: { sequence: number; values: unknown[] }[] };
      expect(replay.envelopes.length).toBeGreaterThan(0);
      expect(replay.envelopes.every((entry) => Number.isSafeInteger(entry.sequence))).toBe(true);
      const racingRead = replayRoutes.request(
        `/api/laps/${lapId}/opponent-laps/${completed!.opponentLapId}/semantic-telemetry?sourceRevision=${body.sourceRevision}`,
        { headers: { "X-Game-Id": "lmu" } },
      );
      await startSessionOpponentRemoval({ sessionIds });
      await Promise.all([...getRecordingMaintenanceController().fibers].map((fiber) =>
        new Promise<void>((resolve) => fiber.addObserver(() => resolve()))));
      const raced = await racingRead;
      expect([200, 409]).toContain(raced.status);
      if (raced.status === 409) expect(await raced.json()).toMatchObject({ code: "SOURCE_CHANGED" });
      const stale = await replayRoutes.request(
        `/api/laps/${lapId}/opponent-laps/${completed!.opponentLapId}/semantic-telemetry?sourceRevision=${body.sourceRevision}`,
        { headers: { "X-Game-Id": "lmu" } },
      );
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "SOURCE_CHANGED" });
      const removedCatalog = await replayRoutes.request(`/api/laps/${lapId}/opponent-laps`, { headers: { "X-Game-Id": "lmu" } });
      expect(removedCatalog.status).toBe(200);
      expect(await removedCatalog.json()).toMatchObject({ opponentRetention: "removed", sessions: [], laps: [] });
      const player = await replayRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, { headers: { "X-Game-Id": "lmu" } });
      expect(player.status).toBe(200);
    } finally {
      await Promise.all(sessionIds.map(deleteSession));
    }
  });
});

test("encodes opponent observation integers losslessly", () => {
  const huge = 9_007_199_254_740_993n;
  const value = observation("race.competitor.scoring-time", 1, huge);
  const encoded = encodeLmuResolvedValue({
    ...value,
    provenance: {
      ...value.provenance,
      observedAt: { domain: "monotonic", nanoseconds: huge },
      sourceObservation: { timestamp: { domain: "monotonic", nanoseconds: huge }, updateSequence: huge },
    },
  });
  expect(encoded.provenance.sourceObservation).toEqual({
    timestamp: { domain: "monotonic", nanoseconds: huge.toString() },
    updateSequence: huge.toString(),
  });
  expect(JSON.parse(JSON.stringify(encoded)).provenance.observedAt.nanoseconds).toBe(huge.toString());
});

describe("opponent Hono request validation", () => {
  test("rejects malformed IDs, unknown body fields, and incomplete ranges with contract error", async () => {
    const malformedId = await replayRoutes.request("/api/laps/0/opponent-laps", { headers: { "X-Game-Id": "lmu" } });
    expect(malformedId.status).toBe(400);
    expect(await malformedId.json()).toMatchObject({ code: "INVALID_OPPONENT_COMPARISON" });

    const unknownField = await replayRoutes.request("/api/laps/1/opponent-comparison", {
      method: "POST", headers: { "X-Game-Id": "lmu", "Content-Type": "application/json" },
      body: JSON.stringify({ opponentLapId: "lap", sourceRevision: "revision", step: 1, extra: true }),
    });
    expect(unknownField.status).toBe(400);
    expect(await unknownField.json()).toMatchObject({ code: "INVALID_OPPONENT_COMPARISON" });

    const badRange = await replayRoutes.request("/api/laps/1/opponent-comparison", {
      method: "POST", headers: { "X-Game-Id": "lmu", "Content-Type": "application/json" },
      body: JSON.stringify({ opponentLapId: "lap", sourceRevision: "revision", step: 0.1, start: 4, end: 4 }),
    });
    expect(badRange.status).toBe(400);
    expect(await badRange.json()).toMatchObject({ code: "INVALID_OPPONENT_COMPARISON" });

    const unknownQuery = await replayRoutes.request(
      "/api/laps/1/opponent-laps/opaque/semantic-telemetry?sourceRevision=revision&unexpected=1",
      { headers: { "X-Game-Id": "lmu" } },
    );
    expect(unknownQuery.status).toBe(400);
    expect(await unknownQuery.json()).toMatchObject({ code: "INVALID_OPPONENT_COMPARISON" });
  });
});
