import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { processTelemetryBatch, type TelemetryBatchBootstrap, type TelemetryBatchFrame, type TelemetryBatchInput, type TelemetryBatchOptions } from "../../src/processor/batch";
import { packet as fixturePacket } from "../support-resolver";

function packet(values: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return fixturePacket("fm-2023", {
    carId: "native-car", trackId: "native-track", sessionUID: "native-session",
    IsRaceOn: 1, LapNumber: 7, CurrentLap: 0, LastLap: 0, DistanceTraveled: 0, TimestampMS: 1,
    ...values,
  });
}

function inputs(packets: readonly TelemetryPacket[], offset = 1_000): TelemetryBatchFrame[] {
  return packets.map((_packet, index) => {
    const data = Buffer.alloc(4);
    data.writeUInt32LE(index);
    return { data, rawByteOffset: offset + index * 10 };
  });
}

function parser(packets: readonly TelemetryPacket[]): TelemetryBatchOptions<null>["parser"] {
  return {
    createParserState: () => null,
    tryParse: data => packets[data.readUInt32LE(0)] ?? null,
  };
}

function completeLap(lapNumber = 7, startTimestamp = 0): TelemetryPacket[] {
  return [
    ...Array.from({ length: 35 }, (_, index) => packet({
      LapNumber: lapNumber, CurrentLap: index, DistanceTraveled: index * 100, TimestampMS: startTimestamp + index + 1,
    })),
    packet({ LapNumber: lapNumber + 1, CurrentLap: 0, LastLap: 34, DistanceTraveled: 3_500, TimestampMS: startTimestamp + 36 }),
  ];
}

const bootstrap: TelemetryBatchBootstrap = {
  type: "parser-bootstrap", gameId: "fm-2023", formatVersion: 1, payload: Buffer.from("native-car"),
};

describe("pure telemetry batch validation", () => {
  test("retains source IDs and real detector time/count without counting the completion trigger twice", async () => {
    const packets = completeLap();
    const result = await processTelemetryBatch("fm-2023", inputs(packets), { parser: parser(packets) });
    expect(result.logicalLapCount).toBe(1);
    expect(result.sessions).toEqual([{ sessionKey: 1, gameId: "fm-2023", carId: "native-car", trackId: "native-track", sessionUID: "native-session" }]);
    expect(result.laps).toMatchObject([{ sessionKey: 1, lapNumber: 7, lapTime: 34, byteOffset: 1_000, frameCount: 35, complete: true }]);
    expect(result.laps[0]!.packets).toEqual(packets.slice(0, 35));
  });

  test("counts a short partial logical lap even when detector persistence omits it", async () => {
    const packets = [packet({ CurrentLap: 2 }), packet({ CurrentLap: 3, TimestampMS: 2 })];
    const result = await processTelemetryBatch("fm-2023", inputs(packets), { parser: parser(packets) });
    expect(result.logicalLapCount).toBe(1);
    expect(result.laps).toEqual([]);
  });

  test("counts both completed laps rather than accepting multiple logical laps as one", async () => {
    const packets = [...completeLap(), ...completeLap(8, 100)];
    const result = await processTelemetryBatch("fm-2023", inputs(packets), { parser: parser(packets) });
    expect(result.logicalLapCount).toBe(2);
    expect(result.laps.map(lap => [lap.lapNumber, lap.lapTime, lap.complete])).toEqual([[7, 34, true], [8, 34, true]]);
  });

  test("counts telemetry after completion even when its partial lap is too short to persist", async () => {
    const packets = [
      ...completeLap(),
      ...Array.from({ length: 9 }, (_, index) => packet({ LapNumber: 8, CurrentLap: index + 1, LastLap: 34, TimestampMS: 40 + index })),
    ];
    const result = await processTelemetryBatch("fm-2023", inputs(packets), { parser: parser(packets) });
    expect(result.logicalLapCount).toBe(2);
    expect(result.laps.map(lap => [lap.lapNumber, lap.complete])).toEqual([[7, true]]);
  });

  test("counts a source completion suppressed by native timing without counting its zero-time trigger twice", async () => {
    const packets = completeLap();
    packets[35] = { ...packets[35]!, LastLap: 0 };
    const result = await processTelemetryBatch("fm-2023", inputs(packets), { parser: parser(packets) });
    expect(result.logicalLapCount).toBe(1);
    expect(result.laps).toEqual([]);
  });

  test("does not merge short partials across native session identities", async () => {
    const packets = [
      packet({ CurrentLap: 3 }),
      packet({ CurrentLap: 4, sessionUID: "second-native-session", TimestampMS: 2 }),
    ];
    const result = await processTelemetryBatch("fm-2023", inputs(packets), { parser: parser(packets) });
    expect(result.logicalLapCount).toBe(2);
    expect(result.sessions.map(session => session.sessionUID)).toEqual(["native-session", "second-native-session"]);
    expect(result.laps).toEqual([]);
  });

  test("does not promote a prior session's zero-time finish trigger into another lap", async () => {
    const suppressed = completeLap();
    suppressed[35] = { ...suppressed[35]!, LastLap: 0 };
    const next = completeLap().map(value => ({ ...value, sessionUID: "second-native-session" }));
    const packets = [...suppressed, ...next];
    const result = await processTelemetryBatch("fm-2023", inputs(packets), { parser: parser(packets) });
    expect(result.logicalLapCount).toBe(2);
    expect(result.laps.map(lap => [lap.sessionKey, lap.lapNumber, lap.lapTime])).toEqual([[2, 7, 34]]);
  });

  test("iRacing delayed native finish evidence completes one lap; later native telemetry starts another", async () => {
    const native = {
      sessionTick: 1, sessionNum: 1, driverCarIdx: 0, trackLengthM: 3_500, lapDistanceM: 0, lapDistancePct: 0,
      onPitRoad: false, playerTrackSurface: 3, incidents: 0, trackWetness: 0,
      carName: "native-car", carClassName: "native-class", trackName: "native-track",
    };
    const packets = [
      ...Array.from({ length: 35 }, (_, index) => packet({
        gameId: "iracing", CurrentLap: index, LastLap: 20, TimestampMS: index + 1, DistanceTraveled: index * 100,
        iracing: { ...native, sdkCurrentLapTime: index },
      })),
      ...[35, 36].map(current => packet({
        gameId: "iracing", LapNumber: 8, CurrentLap: current, LastLap: 20, TimestampMS: current + 1,
        iracing: { ...native, sdkCurrentLapTime: current },
      })),
      packet({ gameId: "iracing", LapNumber: 8, CurrentLap: 0, LastLap: 34, TimestampMS: 38, iracing: { ...native, sdkCurrentLapTime: 0 } }),
    ];
    const context: TelemetryBatchInput[] = [{ type: "segment-context", completeLapStart: true }, { type: "segment-context-end" }];
    const exact = await processTelemetryBatch("iracing", [...context, ...inputs(packets)], { parser: parser(packets) });
    expect(exact.logicalLapCount).toBe(1);
    expect(exact.laps.map(lap => [lap.lapNumber, lap.lapTime, lap.complete])).toEqual([[7, 34, true]]);
    packets.push(packet({ gameId: "iracing", LapNumber: 8, CurrentLap: 1, LastLap: 34, TimestampMS: 39, iracing: { ...native, sdkCurrentLapTime: 1 } }));
    const tail = await processTelemetryBatch("iracing", [...context, ...inputs(packets)], { parser: parser(packets) });
    expect(tail.logicalLapCount).toBe(2);
    expect(tail.laps.map(lap => [lap.lapNumber, lap.lapTime, lap.complete])).toEqual([[7, 34, true]]);
  });

  test("context telemetry and empty segment boundaries never become logical laps", async () => {
    const packets = completeLap();
    const frames = inputs(packets);
    const result = await processTelemetryBatch("fm-2023", [
      { type: "segment-boundary" }, { type: "segment-context" }, ...frames,
      { type: "segment-context-end" }, { type: "segment-boundary" }, ...frames,
      { type: "segment-boundary" }, { type: "segment-boundary" },
    ], { parser: parser(packets) });
    expect(result.logicalLapCount).toBe(1);
    expect(result.sessions.map(session => session.sessionKey)).toEqual([1]);
    expect(result.laps.map(lap => lap.lapNumber)).toEqual([7]);
  });

  test("restores actual checkpoint state without reviving driver freshness; real context can refresh it", async () => {
    const packets = completeLap();
    const options: TelemetryBatchOptions<{ carId: string; driverFresh: boolean }> = {
      parser: {
        createParserState: () => ({ carId: "", driverFresh: false }),
        restoreParserCheckpoint: (_state, payload) => ({ carId: Buffer.from(payload).toString(), driverFresh: true }),
        invalidateDriverEvidence: state => { state.driverFresh = false; },
        tryParse: (data, state) => {
          if (data.length === 0) { state.driverFresh = true; return null; }
          const value = packets[data.readUInt32LE(0)]!;
          return {
            ...value, carId: state.carId,
            driverActor: state.driverFresh ? {
              gameId: "fm-2023", source: "native-test", actorId: "observed", bindingScope: "session",
              sessionId: "native-session", clockDomain: "native-test", observedAtMs: value.TimestampMS,
            } : null,
          };
        },
      },
    };
    const restored = await processTelemetryBatch("fm-2023", [bootstrap, ...inputs(packets)], options);
    expect(restored.logicalLapCount).toBe(1);
    expect(restored.sessions[0]!.carId).toBe("native-car");
    expect(restored.laps[0]!.packets.every(value => value.driverActor === null)).toBe(true);
    const refreshed = await processTelemetryBatch("fm-2023", [
      bootstrap, { type: "segment-context" }, { data: Buffer.alloc(0) }, { type: "segment-context-end" }, ...inputs(packets),
    ], options);
    expect(refreshed.logicalLapCount).toBe(1);
    expect(refreshed.laps[0]!.packets.every(value => value.driverActor !== null)).toBe(true);
  });

  test("rejects mismatched game/version, absent restore, and corrupt checkpoints explicitly", async () => {
    const options = { parser: parser([]) };
    await expect(processTelemetryBatch("fm-2023", [bootstrap], options)).rejects.toThrow("Parser checkpoint restore unavailable for fm-2023");
    await expect(processTelemetryBatch("fm-2023", [{ ...bootstrap, gameId: "acc" }], options)).rejects.toThrow("Parser bootstrap does not match game/version");
    await expect(processTelemetryBatch("fm-2023", [{ ...bootstrap, formatVersion: 2 }], options)).rejects.toThrow("Parser bootstrap does not match game/version");
    await expect(processTelemetryBatch("fm-2023", [bootstrap], {
      parser: { ...options.parser, restoreParserCheckpoint: () => { throw new Error("Invalid native checkpoint"); } },
    })).rejects.toThrow("Invalid native checkpoint");
  });

  test("segment boundaries recreate parser state and isolate repeated native lap numbers", async () => {
    const packets = completeLap();
    let stateCount = 0;
    const result = await processTelemetryBatch("fm-2023", [
      ...inputs(packets), { type: "segment-boundary" }, ...inputs(packets, 8_000),
    ], { parser: { ...parser(packets), createParserState: () => { stateCount++; return null; } } });
    expect(stateCount).toBe(2);
    expect(result.logicalLapCount).toBe(2);
    expect(result.laps.map(lap => [lap.sessionKey, lap.lapNumber, lap.byteOffset])).toEqual([[1, 7, 1_000], [2, 7, 8_000]]);
  });

  test("yields macrotasks while parsing parser-only context as well as detector-fed frames", async () => {
    // Real zero-delay command delivery verifies macrotask fairness; fake timers cannot prove event-loop service.
    let parsed = 0;
    let contextCommandAt = -1;
    let detectorCommandAt = -1;
    const frames: TelemetryBatchInput[] = [
      { type: "segment-context" }, ...Array.from({ length: 600 }, () => ({ data: Buffer.alloc(0) })),
      { type: "segment-context-end" }, ...Array.from({ length: 600 }, () => ({ data: Buffer.alloc(0) })),
    ];
    const result = await processTelemetryBatch("fm-2023", frames, {
      parser: {
        createParserState: () => null,
        tryParse: () => {
          parsed++;
          if (parsed === 1) setTimeout(() => { contextCommandAt = parsed; }, 0);
          if (parsed === 601) setTimeout(() => { detectorCommandAt = parsed; }, 0);
          return packet({ CurrentLap: parsed / 100, TimestampMS: parsed });
        },
      },
    });
    expect(contextCommandAt).toBeGreaterThan(0);
    expect(contextCommandAt).toBeLessThanOrEqual(256);
    expect(detectorCommandAt).toBeGreaterThanOrEqual(601);
    expect(detectorCommandAt).toBeLessThanOrEqual(856);
    expect(result.logicalLapCount).toBe(1);
    expect(result.laps).toMatchObject([{ complete: false, lapNumber: 7, lapTime: 12 }]);
  });
});
