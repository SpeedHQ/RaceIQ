import { describe, expect, test } from "bun:test";
import { initServerGameAdapters } from "../../server/games/init";
import { accServerAdapter } from "../../server/games/acc";
import { acEvoServerAdapter } from "../../server/games/ac-evo";
import { iracingServerAdapter } from "../../server/games/iracing";
import { f1ServerAdapter } from "../../server/games/f1-2025";
import { initGameAdapters } from "../../shared/games/init";
import { packet } from "../support/telemetry/resolver";
import type { RaceEventObservation } from "../../server/games/types";
import { LiveTelemetryProjector } from "../../server/telemetry/live-projector";
import {
  applyRaceEventSemanticProjection,
  RACE_EVENT_SEMANTIC_IDS,
  RaceEventSemanticProjector,
  type RaceEventSemanticEvidence,
  type RaceEventSemanticFrame,
} from "../../server/race-events/semantic-projector";

initGameAdapters();
initServerGameAdapters();

function normalizedIRacingPacket({
  timestampMs,
  pitStall = false,
  pitServiceStatus,
  tireCount,
  tireWear,
  mandatoryRepair,
  optionalRepair,
}: {
  timestampMs: number;
  pitStall?: boolean;
  pitServiceStatus: number;
  tireCount: number;
  tireWear?: readonly [number, number, number, number];
  mandatoryRepair: number;
  optionalRepair: number;
}) {
  return packet("iracing", {
    TimestampMS: timestampMs,
    TireWearFL: tireWear?.[0],
    TireWearFR: tireWear?.[1],
    TireWearRL: tireWear?.[2],
    TireWearRR: tireWear?.[3],
    iracing: {
      sessionTick: timestampMs,
      sessionNum: 1,
      sessionFlags: 0x4,
      sessionState: 4,
      driverCarIdx: 0,
      trackLengthM: 1_000,
      lapDistanceM: 100,
      lapDistancePct: 0.1,
      onPitRoad: pitStall,
      playerTrackSurface: 0,
      incidents: 0,
      trackWetness: 0,
      PlayerCarInPitStall: pitStall,
      PlayerCarPitSvStatus: pitServiceStatus,
      TireSetsUsed: tireCount,
      PitRepairLeft: mandatoryRepair,
      PitOptRepairLeft: optionalRepair,
      carName: "test-car",
      carClassName: "test-class",
      trackName: "test-track",
    },
  });
}
function normalizedF1Packet({
  resultSource,
  resultStatus,
  safetyCarStatus,
  vehicleFIAFlags,
}: {
  resultSource: "lap-data" | "final-classification";
  resultStatus: number;
  safetyCarStatus?: number;
  vehicleFIAFlags?: number;
}) {
  return packet("f1-2025", {
    f1: {
      playerCarIndex: 0,
      resultSource,
      resultStatus,
      safetyCarStatus,
      vehicleFIAFlags,
    } as never,
  });
}

function evidence<T>(
  value: T | undefined,
  state: RaceEventSemanticEvidence<T>["state"] = "ok",
  freshness: RaceEventSemanticEvidence<T>["freshness"] = "fresh",
  sourceFreshness: RaceEventSemanticEvidence<T>["sourceFreshness"] = null,
): RaceEventSemanticEvidence<T> {
  return { value, state, freshness, sourceFreshness };
}

function observation(): RaceEventObservation {
  return {
    gameId: "acc",
    sessionUid: null,
    receivedAtMs: 10,
    sourceTimeMs: 10,
    sourceSequences: [],
    lapNumber: 1,
    currentLapTimeMs: 1_000,
    lastLapTimeMs: null,
    trackDistanceM: 10,
    trackDistancePct: null,
    worldPosition: null,
    sessionPhase: "unknown",
    nativeRaceControlCode: "yellow",
    cautionKind: "unknown",
    gridStart: null,
    terminalObserved: null,
    rosterAuthoritative: false,
    participants: [
      {
        participantId: "local-player",
        participantKind: "player",
        sourceId: null,
        identityState: "stable",
        driverId: null,
        teamId: null,
        displayName: null,
        vehicleId: null,
        pitState: "unknown",
        nativePitCode: "in_pit",
        position: 1,
        speedMps: 20,
        fuelLitres: 20,
        tireCompound: null,
        tireWear: { fl: 0.8, fr: 0.8, rl: 0.8, rr: 0.8 },
        damage: null,
        penaltyValue: null,
        incidentCount: null,
        retirementStatus: "unknown",
        nativeRetirementCode: null,
      },
    ],
  };
}

function semantic(overrides: Partial<RaceEventSemanticFrame> = {}): RaceEventSemanticFrame {
  return {
    raceControlPhase: evidence<NonNullable<RaceEventSemanticFrame["raceControlPhase"]["value"]>>(undefined, "missing", "unknown"),
    cautionKind: evidence<NonNullable<RaceEventSemanticFrame["cautionKind"]["value"]>>(undefined, "missing", "unknown"),
    pitState: evidence<NonNullable<RaceEventSemanticFrame["pitState"]["value"]>>(undefined, "missing", "unknown"),
    pitServiceStatus: evidence<NonNullable<RaceEventSemanticFrame["pitServiceStatus"]["value"]>>(undefined, "missing", "unknown"),
    tireChangeCounts: evidence<NonNullable<RaceEventSemanticFrame["tireChangeCounts"]["value"]>>(undefined, "missing", "unknown"),
    repairEvidence: evidence<NonNullable<RaceEventSemanticFrame["repairEvidence"]["value"]>>(undefined, "missing", "unknown"),

    ...overrides,
  };
}

describe("race-event semantic projection", () => {
  test("projects canonical facts and resolved tire wear without inspecting simulator identity", () => {
    expect(RACE_EVENT_SEMANTIC_IDS.join(",")).not.toContain("tires.tire-wear");
    const liveProjector = new LiveTelemetryProjector();
    const tireWearSample = liveProjector.resolve(
      packet("acc", {
        TireWearFL: 0.8,
        TireWearFR: 0.7,
        TireWearRL: 0.6,
        TireWearRR: 0.5,
      }),
      10,
    ).sample;
    const projected = applyRaceEventSemanticProjection(
      observation(),
      semantic({
        raceControlPhase: evidence("caution"),
        cautionKind: evidence("local-yellow"),
        pitState: evidence("pit-stall"),
        pitServiceStatus: evidence("in-progress"),
        tireChangeCounts: evidence({ fl: 2, fr: 2, rl: 2, rr: 2 }),
        repairEvidence: evidence({ mandatory: 8, optional: 3 }),
      }),
      tireWearSample,
    );

    expect(projected).toMatchObject({
      sessionPhase: "caution",
      cautionKind: "local-yellow",
      raceControlEvidence: "authoritative",
      participants: [
        {
          pitState: "pit-stall",
          pitServiceStatus: "in-progress",
          tireChangeCounts: { fl: 2, fr: 2, rl: 2, rr: 2 },
          repairRemainingSeconds: { mandatory: 8, optional: 3 },
          tireWear: { fl: 0.8, fr: 0.7, rl: 0.6, rr: 0.5 },
          tireWearFreshness: "continuous",
        },
      ],
    });
  });

  test("does not project stale canonical values", () => {
    const projected = applyRaceEventSemanticProjection(
      observation(),
      semantic({
        raceControlPhase: evidence("checkered", "stale", "stale"),
        pitState: evidence("pit-stall", "stale", "stale"),
      }),
    );

    expect(projected.sessionPhase).toBe("unknown");
    expect(projected.participants[0]).toMatchObject({
      pitState: "unknown",
      tireWear: { fl: 0.8, fr: 0.8, rl: 0.8, rr: 0.8 },
    });
  });

  test("does not project unknown timestamp-domain evidence", () => {
    const projected = applyRaceEventSemanticProjection(
      observation(),
      semantic({
        raceControlPhase: evidence("checkered", "ok", "unknown"),
        cautionKind: evidence("full-course-yellow", "ok", "unknown"),
        pitState: evidence("pit-stall", "ok", "unknown"),
        pitServiceStatus: evidence("in-progress", "ok", "unknown"),
        tireChangeCounts: evidence({ fl: 2, fr: 2, rl: 2, rr: 2 }, "ok", "unknown"),
        repairEvidence: evidence({ mandatory: 8, optional: 3 }, "ok", "unknown"),
      }),
    );

    expect(projected).toMatchObject({
      sessionPhase: "unknown",
      cautionKind: "unknown",
      participants: [
        {
          pitState: "unknown",
          tireWear: { fl: 0.8, fr: 0.8, rl: 0.8, rr: 0.8 },
        },
      ],
    });
    expect(projected).not.toHaveProperty("raceControlEvidence");
    expect(projected.participants[0]).not.toHaveProperty("pitServiceStatus");
    expect(projected.participants[0]).not.toHaveProperty("tireChangeCounts");
    expect(projected.participants[0]).not.toHaveProperty("repairRemainingSeconds");
  });

  test("does not project missing resolved tire wear", () => {
    const input = observation();
    input.participants[0]!.tireWear = null;
    const projected = applyRaceEventSemanticProjection(input, semantic(), { sequence: "0", observedAtMs: 0, values: {} });

    expect(projected.participants[0]).toMatchObject({ tireWear: null });
    expect(projected.participants[0]).not.toHaveProperty("tireWearFreshness");
  });

  test("does not project malformed canonical tire wear", () => {
    const malformedValues: readonly unknown[] = [
      [0.8, 0.7, 0.6],
      [0.8, 0.7, 0.6, Number.NaN],
      [0.8, 0.7, 0.6, 1.1],
    ];

    for (const value of malformedValues) {
      const input = observation();
      input.participants[0]!.tireWear = null;
      const projected = applyRaceEventSemanticProjection(input, semantic(), { sequence: "0", observedAtMs: 0, values: { "tires.tire-wear": value as never } });

      expect(projected.participants[0]).toMatchObject({ tireWear: null });
      expect(projected.participants[0]).not.toHaveProperty("tireWearFreshness");
    }
  });

  test("keeps direct adapter projector-owned facts neutral without semantic context", () => {
    const direct = accServerAdapter.toRaceEventObservation(
      packet("acc", {
        acc: { flagStatus: "yellow", pitStatus: "in_pit" } as never,
      }),
      { receivedAtMs: 10, sourceSequences: [] },
    );

    expect(direct).toMatchObject({
      sessionPhase: "unknown",
      cautionKind: "unknown",
      participants: [{ pitState: "unknown", nativePitCode: "in_pit" }],
    });
  });

  test("projects ACC and AC Evo native race-control flags through game-owned semantics", () => {
    const cases = [
      ["acc", "none", "green"],
      ["acc", "yellow", "caution"],
      ["acc", "checkered", "checkered"],
      ["ac-evo", "none", "green"],
      ["ac-evo", "green", "green"],
      ["ac-evo", "yellow", "caution"],
      ["ac-evo", "red", "red"],
      ["ac-evo", "checkered", "checkered"],
    ] as const;

    for (const [gameId, flagStatus, expectedPhase] of cases) {
      const projector = new RaceEventSemanticProjector();
      const native = packet(gameId, {
        acc: { flagStatus } as never,
      });
      const semantic = projector.project(native, 1_000);
      const adapter = gameId === "acc" ? accServerAdapter : acEvoServerAdapter;
      const projected = applyRaceEventSemanticProjection(
        adapter.toRaceEventObservation(native, {
          receivedAtMs: 1_000,
          sourceSequences: [],
          semantic,
        }),
        semantic,
      );

      expect(semantic.raceControlPhase).toMatchObject({
        state: "ok",
        value: expectedPhase,
      });
      expect(projected).toMatchObject({
        sessionPhase: expectedPhase,
        nativeRaceControlCode: flagStatus,
        raceControlEvidence: "authoritative",
      });
    }

    for (const gameId of ["acc", "ac-evo"] as const) {
      const native = packet(gameId, {
        IsRaceOn: 0,
        acc: { flagStatus: "none" } as never,
      });
      const semantic = new RaceEventSemanticProjector().project(native, 1_000);
      const adapter = gameId === "acc" ? accServerAdapter : acEvoServerAdapter;
      const projected = applyRaceEventSemanticProjection(
        adapter.toRaceEventObservation(native, {
          receivedAtMs: 1_000,
          sourceSequences: [],
          semantic,
        }),
        semantic,
      );

      expect(semantic.raceControlPhase).toMatchObject({
        state: "ok",
        value: "inactive",
      });
      expect(projected).toMatchObject({
        sessionPhase: "inactive",
        nativeRaceControlCode: "none",
        raceControlEvidence: "authoritative",
      });
    }

    for (const gameId of ["acc", "ac-evo"] as const) {
      const native = packet(gameId, { acc: { flagStatus: "black" } as never });
      const semantic = new RaceEventSemanticProjector().project(native, 1_000);
      const adapter = gameId === "acc" ? accServerAdapter : acEvoServerAdapter;
      const projected = applyRaceEventSemanticProjection(
        adapter.toRaceEventObservation(native, {
          receivedAtMs: 1_000,
          sourceSequences: [],
          semantic,
        }),
        semantic,
      );

      expect(semantic.raceControlPhase).toMatchObject({
        state: "missing",
        value: undefined,
      });
      expect(projected).toMatchObject({
        sessionPhase: "unknown",
        nativeRaceControlCode: "black",
      });
      expect(projected.raceControlEvidence).toBeUndefined();
    }
  });

  test("keeps F1 lap-data result status live and finishes only final classification", () => {
    const projector = new RaceEventSemanticProjector();
    const live = normalizedF1Packet({
      resultSource: "lap-data",
      resultStatus: 3,
      safetyCarStatus: 0,
      vehicleFIAFlags: 0,
    });
    const liveSemantic = projector.project(live, 1_000);
    const liveObservation = applyRaceEventSemanticProjection(
      f1ServerAdapter.toRaceEventObservation(live, {
        receivedAtMs: 1_000,
        sourceSequences: [],
        semantic: liveSemantic,
      }),
      liveSemantic,
    );

    expect(liveSemantic.raceControlPhase).toMatchObject({
      state: "ok",
      value: "green",
    });
    expect(liveObservation).toMatchObject({
      sessionPhase: "green",
      terminalObserved: null,
      nativeRaceControlCode: 0,
      raceControlEvidence: "authoritative",
    });

    const finalClassification = normalizedF1Packet({
      resultSource: "final-classification",
      resultStatus: 3,
    });
    const finalSemantic = projector.project(finalClassification, 1_100);
    const finalObservation = applyRaceEventSemanticProjection(
      f1ServerAdapter.toRaceEventObservation(finalClassification, {
        receivedAtMs: 1_100,
        sourceSequences: [],
        semantic: finalSemantic,
      }),
      finalSemantic,
    );

    expect(finalSemantic.raceControlPhase).toMatchObject({
      state: "ok",
      value: "finished",
    });
    expect(finalObservation).toMatchObject({
      sessionPhase: "finished",
      terminalObserved: true,
      nativeRaceControlCode: 3,
    });
  });
  test("reobserves unchanged iRacing pit snapshots after reconnect and timebase resets", () => {
    const projector = new LiveTelemetryProjector();
    const snapshot = {
      TireWearFL: 0.1,
      TireWearFR: 0.2,
      TireWearRL: 0.3,
      TireWearRR: 0.4,
    };

    const first = projector.resolve(
      packet("iracing", {
        TimestampMS: 1_000,
        ...snapshot,
      }),
      1_000,
    ).sample;
    expect(first.values["tires.tire-wear"]).toEqual([0.1, 0.2, 0.3, 0.4]);

    projector.reset();
    const reconnected = projector.resolve(
      packet("iracing", {
        TimestampMS: 32_000,
        ...snapshot,
      }),
      32_000,
    ).sample;
    expect(reconnected.values["tires.tire-wear"]).toEqual([0.1, 0.2, 0.3, 0.4]);

    const replaySeek = projector.resolve(
      packet("iracing", {
        TimestampMS: 1_000,
        ...snapshot,
      }),
      1_000,
    ).sample;
    expect(replaySeek.values["tires.tire-wear"]).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  test("resolves iRacing structured pit evidence from normalized packets", () => {
    const projector = new RaceEventSemanticProjector();
    const normalized = normalizedIRacingPacket({
      timestampMs: 1_000,
      pitStall: true,
      pitServiceStatus: 1,
      tireCount: 2,
      tireWear: [0.8, 0.7, 0.6, 0.5],
      mandatoryRepair: 8,
      optionalRepair: 3,
    });
    const frame = projector.project(normalized, 2_000);
    const tireWearSample = new LiveTelemetryProjector().resolve(normalized, 2_000).sample;
    const projected = applyRaceEventSemanticProjection(
      iracingServerAdapter.toRaceEventObservation(normalized, {
        receivedAtMs: 2_000,
        sourceSequences: [],
        semantic: frame,
      }),
      frame,
      tireWearSample,
    );

    expect(frame.pitState.value).toBe("pit-stall");
    expect(frame.pitServiceStatus.value).toBe("in-progress");
    expect(frame.tireChangeCounts.value).toEqual({ fl: 2, fr: 2, rl: 2, rr: 2 });
    expect(frame.repairEvidence.value).toEqual({ mandatory: 8, optional: 3 });
    expect(tireWearSample.values["tires.tire-wear"]).toEqual([0.8, 0.7, 0.6, 0.5]);
    expect(projected.participants).toEqual([
      expect.objectContaining({
        pitState: "pit-stall",
        pitServiceStatus: "in-progress",
        tireChangeCounts: { fl: 2, fr: 2, rl: 2, rr: 2 },
        repairRemainingSeconds: { mandatory: 8, optional: 3 },
        tireWear: { fl: 0.8, fr: 0.7, rl: 0.6, rr: 0.5 },
        tireWearFreshness: "pit-snapshot",
      }),
    ]);
  });
});
