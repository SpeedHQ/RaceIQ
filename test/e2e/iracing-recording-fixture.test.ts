import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readIRacingFrames } from "../../server/games/iracing/recorder";
import { rebuildRaceEventTimeline } from "../../server/race-events/rebuild";
import { deriveRaceResult } from "../../server/race-results/derive";
import { extractRaceSource } from "../../server/race-results/source";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { currentTelemetryVersionIdentity } from "../../server/telemetry/pipeline-ports";
import { RaceEventsAppendedMessageSchema, type RaceEvent } from "../../shared/racing/events/contracts";
import { LOCAL_PLAYER_EVIDENCE } from "../../shared/racing/quality/contracts";
import type { DumpResult } from "../support/recordings/parse-dump";
import { parseDump } from "../support/recordings/parse-dump";

const FIXTURE = "test/artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz";

function raceEventTimeline(result: DumpResult): RaceEvent[] {
  return result.wsNotifications.filter(({ type }) => type === "race-events-appended").flatMap((message) => RaceEventsAppendedMessageSchema.parse(message).events);
}

function projectStableEvent(event: RaceEvent) {
  const {
    createdAt: _createdAt,
    receivedAtMs: _receivedAtMs,
    lapId: _lapId,
    sourceKind: _sourceKind,
    sourceGeneration: _sourceGeneration,
    analysisGenerationId: _analysisGenerationId,
    contentHash: _contentHash,
    ...semantic
  } = event;
  return semantic;
}

let recording: DumpResult;
let roadAmericaRecording: DumpResult;

beforeAll(async () => {
  recording = await parseDump("iracing", FIXTURE);
  roadAmericaRecording = await parseDump("iracing", "test/artifacts/sessions/iracing-road-america-gt3.bin.gz");
});

afterAll(() => stopMaintenanceTasks());

describe("committed iRacing recorder fixture", () => {
  test("replays every recorded SDK tick through the production parser", () => {
    expect(roadAmericaRecording.rawPackets).toHaveLength(138);
    expect(
      roadAmericaRecording.sessions.map(({ carOrdinal, trackOrdinal, gameId, sourceKind, ownership, sessionType, sourceChannelProfile, versionIdentity }) => ({
        carOrdinal,
        trackOrdinal,
        gameId,
        sourceKind,
        ownership,
        sessionType,
        sourceChannelProfile,
        versionIdentity,
      })),
    ).toEqual([
      {
        carOrdinal: 42,
        trackOrdinal: 99,
        gameId: "iracing",
        sourceKind: "native-live",
        ownership: undefined,
        sessionType: undefined,
        sourceChannelProfile: undefined,
        versionIdentity: undefined,
      },
    ]);
    expect(roadAmericaRecording.carModel).toBe("GT3 Test Car");
    expect(roadAmericaRecording.trackName).toBe("Road America");

    const speeds = roadAmericaRecording.rawPackets.map((packet) => packet.Speed);
    const brakeInputs = roadAmericaRecording.rawPackets.map((packet) => packet.Brake);
    expect(Math.max(...speeds)).toBeGreaterThan(70);
    expect(Math.max(...brakeInputs)).toBeGreaterThan(150);
  });

  test("keeps delayed native timing attached to the two physical laps", () => {
    expect(roadAmericaRecording.laps).toHaveLength(2);
    expect(
      roadAmericaRecording.laps.map((lap) => ({
        lapNumber: lap.lapNumber,
        lapTime: lap.lapTime,
        isValid: lap.isValid,
        rawFrameCount: lap.rawFrameCount,
      })),
    ).toEqual([
      {
        lapNumber: 1,
        lapTime: 31.917,
        isValid: true,
        rawFrameCount: 65,
      },
      {
        lapNumber: 2,
        lapTime: 32.045,
        isValid: true,
        rawFrameCount: 62,
      },
    ]);
  });

  test("persists native three-sector timing from the recording", () => {
    for (const lap of roadAmericaRecording.laps) {
      expect(lap.sectors).not.toBeNull();
      const sectors = lap.sectors!;
      expect(sectors).toHaveLength(3);
      expect(sectors[0]).toBeGreaterThan(10);
      expect(sectors[1]).toBeGreaterThan(10);
      expect(sectors[2]).toBeGreaterThan(9);
      expect(sectors.reduce((sum, time) => sum + time, 0)).toBeCloseTo(lap.lapTime, 6);
    }
  });
});

describe("committed iRacing seed fixture", () => {
  test("replays the compact real-telemetry window through the production parser", () => {
    expect(recording.rawPackets).toHaveLength(6_357);
    expect(
      recording.sessions.map(({ carOrdinal, trackOrdinal, gameId, sourceKind, ownership, sessionType, sourceChannelProfile, versionIdentity }) => ({
        carOrdinal,
        trackOrdinal,
        gameId,
        sourceKind,
        ownership,
        sessionType,
        sourceChannelProfile,
        versionIdentity,
      })),
    ).toEqual([
      {
        carOrdinal: 206,
        trackOrdinal: 192,
        gameId: "iracing",
        sourceKind: "native-live",
        ownership: undefined,
        sessionType: undefined,
        sourceChannelProfile: undefined,
        versionIdentity: undefined,
      },
    ]);
    expect(recording.carModel).toBe("Aston Martin Vantage GT3 EVO");
    expect(recording.trackName).toBe("Daytona International Speedway");

    const speeds = recording.rawPackets.map((packet) => packet.Speed);
    const brakeInputs = recording.rawPackets.map((packet) => packet.Brake);
    expect(Math.max(...speeds)).toBeGreaterThan(70);
    expect(Math.max(...brakeInputs)).toBeGreaterThan(150);
    expect(recording.rawPackets.some((packet) => packet.iracing?.onPitRoad)).toBe(true);
    expect(recording.rawPackets.some((packet) => packet.iracing?.onPitRoad === false)).toBe(true);
  });

  test("retains complete laps around lap 415's pit service", () => {
    expect(recording.laps.map((lap) => lap.lapNumber)).toEqual([414, 415, 416, 417]);

    const pitEntry = recording.rawPackets.findIndex((packet, index) => packet.iracing?.onPitRoad === true && recording.rawPackets[index - 1]?.iracing?.onPitRoad === false);
    const pitExit = recording.rawPackets.findIndex((packet, index) => packet.iracing?.onPitRoad === false && recording.rawPackets[index - 1]?.iracing?.onPitRoad === true);
    expect(pitEntry).toBeGreaterThan(0);
    expect(recording.rawPackets[pitEntry]?.LapNumber).toBe(414);
    expect(pitExit).toBeGreaterThan(pitEntry);
    expect(recording.rawPackets[pitExit]?.LapNumber).toBe(415);

    const pitLap = recording.laps.find((lap) => lap.lapNumber === 415);
    expect(pitLap).toBeDefined();
    expect(pitLap!.packets.some((packet) => packet.iracing?.onPitRoad)).toBe(true);
    expect(pitLap!.packets[0]?.Fuel).toBeLessThan(2);
    expect(pitLap!.packets.at(-1)?.Fuel).toBeGreaterThan(100);
  });

  test("emits durable pit-service timeline from the real fixture", () => {
    const events = raceEventTimeline(recording);
    const pitEntry = events.find(({ eventType }) => eventType === "pit_entry");
    expect(pitEntry).toBeDefined();
    expect(pitEntry!.lapNumber).toBe(414);
    expect(pitEntry!.lifecycleId).toMatch(/^pit-visit:sha256:[0-9a-f]{64}$/);
    expect(pitEntry!.eventId).toMatch(/^race-event:sha256:[0-9a-f]{64}$/);

    const visitEvents = events.filter(({ lifecycleId }) => lifecycleId === pitEntry!.lifecycleId);
    expect(visitEvents.map(({ eventType }) => eventType)).toEqual([
      "pit_entry",
      "pit_stall_arrival",
      "pit_service_started",
      "fuel_service_observed",
      "pit_service_completed",
      "pit_stall_departure",
      "pit_exit",
    ]);
    expect(visitEvents.map(({ lapNumber }) => lapNumber)).toEqual([414, 415, 415, 415, 415, 415, 415]);
    expect(visitEvents.every(({ lifecycleId }) => lifecycleId === pitEntry!.lifecycleId)).toBe(true);
    expect(visitEvents.slice(1).every(({ linkedEventId }) => linkedEventId === pitEntry!.eventId)).toBe(true);
    expect(visitEvents.find(({ eventType }) => eventType === "pit_stall_arrival")).toMatchObject({
      evidenceKind: "inferred",
      confidence: "medium",
    });
    const fuelService = visitEvents.find((event): event is Extract<RaceEvent, { eventType: "fuel_service_observed" }> => event.eventType === "fuel_service_observed");
    if (!fuelService) {
      throw new Error("Expected fuel_service_observed event in pit visit");
    }
    const {
      payload: { beforeLitres, afterLitres, addedLitres },
    } = fuelService;
    expect(typeof beforeLitres).toBe("number");
    expect(Number.isFinite(beforeLitres)).toBe(true);
    expect(typeof afterLitres).toBe("number");
    expect(Number.isFinite(afterLitres)).toBe(true);
    expect(typeof addedLitres).toBe("number");
    expect(Number.isFinite(addedLitres)).toBe(true);
    expect(addedLitres).toBeGreaterThan(0);
    const result = deriveRaceResult(extractRaceSource("iracing", recording.rawPackets), events);
    expect(result.pitCount).toBe(1);
    expect(result.eventIds).toEqual(
      visitEvents.filter(({ eventType }) => eventType === "pit_entry" || eventType === "fuel_service_observed" || eventType === "pit_service_completed").map(({ eventId }) => eventId),
    );
    expect(result.fuelStrategy).toMatchObject({
      services: [{ eventId: fuelService.eventId }],
    });
  });

  test("rebuilds stable semantic IDs and event order from the same raw frames", async () => {
    const liveEvents = raceEventTimeline(recording);
    const sessionIds = [...new Set(liveEvents.map(({ sessionId }) => sessionId))];
    expect(sessionIds).toHaveLength(1);
    const frames = readIRacingFrames(FIXTURE).map((frame, rawByteOffset) => ({
      frame,
      rawByteOffset,
    }));
    const input = {
      sessionId: sessionIds[0]!,
      gameId: "iracing" as const,
      frames,
      sourceKind: "raceiq-raw" as const,
      participant: LOCAL_PLAYER_EVIDENCE,
      versionIdentity: currentTelemetryVersionIdentity("iracing"),
      sourceVerification: {
        state: "verified" as const,
        sourceGeneration: "sha256:iracing-daytona-fixture-source",
      },
      canonicalVerification: {
        state: "verified" as const,
        sourceGeneration: "sha256:iracing-daytona-fixture-canonical",
      },
    };

    const first = await rebuildRaceEventTimeline(input);
    const second = await rebuildRaceEventTimeline(input);

    expect(first.events.map(projectStableEvent)).toEqual(liveEvents.map(projectStableEvent));
    expect(second.events.map(projectStableEvent)).toEqual(first.events.map(projectStableEvent));
    const source = extractRaceSource("iracing", recording.rawPackets);
    const liveResultEventIds = deriveRaceResult(source, liveEvents).eventIds;
    expect(deriveRaceResult(source, first.events).eventIds).toEqual(liveResultEventIds);
    expect(deriveRaceResult(source, second.events).eventIds).toEqual(liveResultEventIds);
  });

  test("persists native five-sector timing from the recording", () => {
    for (const lap of recording.laps) {
      expect(lap.sectors).not.toBeNull();
      const sectors = lap.sectors!;
      expect(sectors).toHaveLength(5);
      expect(sectors.every((sector) => sector > 10)).toBe(true);
      expect(sectors.reduce((sum, time) => sum + time, 0)).toBeCloseTo(lap.lapTime, 6);
    }
  });
});
