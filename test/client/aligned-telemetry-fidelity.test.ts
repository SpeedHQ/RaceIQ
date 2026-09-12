import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "../../shared/games/init";
import type { AlignedLapSet, AlignedLapTrace, WheelTrace } from "../../shared/racing/laps/alignment/types";
import { semanticTuneSamplesFromAlignedTrace } from "../../client/src/components/tunes/semantic-tune";
import { cropAlignedLapSet, mergeAlignedLapRange, normalizeFidelityRange, shouldLoadHighFidelity } from "../../client/src/lib/aligned-telemetry-fidelity";

initGameAdapters();

const wheel = (values: number[]): WheelTrace<Float32Array> => ({
  FL: new Float32Array(values),
  FR: new Float32Array(values.map((value) => value + 1)),
  RL: new Float32Array(values.map((value) => value + 2)),
  RR: new Float32Array(values.map((value) => value + 3)),
});

function trace(values: number[]): AlignedLapTrace {
  const floats = () => new Float32Array(values);
  return {
    lapId: 1,
    lapNumber: 1,
    lapTime: 60,
    isValid: true,
    frac: new Float32Array(values.map((value) => value / 4)),
    sourceIndices: new Uint32Array(values),
    speedMps: floats(),
    throttle: floats(),
    brake: floats(),
    steer: floats(),
    rpm: floats(),
    gear: new Uint8Array(values),
    positionX: floats(),
    positionZ: floats(),
    yaw: floats(),
    elapsedTimeS: floats(),
    fuel: floats(),
    tireWear: wheel(values),
    tireTemp: wheel(values),
    tirePressure: wheel(values),
    brakeTemp: wheel(values),
    suspTravel: wheel(values),
    combinedSlip: wheel(values),
    balanceDeg: floats(),
    latG: floats(),
    longG: floats(),
    tireAverages: { FL: 1, FR: 2, RL: 3, RR: 4 },
    pressureAverages: { FL: 27, FR: 28, RL: 29, RR: 30 },
    brakeTempAverages: { FL: 300, FR: 301, RL: 302, RR: 303 },
    sectorTimes: [20, 21, 22],
    sectorStarts: [0.33, 0.67],
  };
}

function set(values: number[]): AlignedLapSet {
  return {
    distanceMeters: new Float32Array(values),
    distanceFractions: new Float32Array(values.map((value) => value / 4)),
    nominalSpanMeters: 4,
    distanceStartMeters: values[0]!,
    distanceEndMeters: values.at(-1)!,
    stepMeters: values.length > 1 ? values[1]! - values[0]! : 1,
    referenceLapId: 1,
    laps: [trace(values)],
  };
}

describe("aligned telemetry fidelity", () => {
  test("pads, clamps, and rejects near-full selections", () => {
    expect(shouldLoadHighFidelity(50, 100)).toBe(true);
    expect(shouldLoadHighFidelity(98, 100)).toBe(false);
    expect(normalizeFidelityRange(0, 10, 100)).toEqual({ start: 0, end: 12, step: 0.1 });
    expect(normalizeFidelityRange(95, 100, 100)).toEqual({ start: 93, end: 100, step: 0.1 });
  });

  test("crop and detail preserve wheel columns and sector metadata", () => {
    const base = set([0, 1, 2, 3, 4]);
    const cropped = cropAlignedLapSet(base, 1, 3);
    expect([...cropped.distanceMeters]).toEqual([1, 2, 3]);
    expect([...cropped.laps[0]!.tireWear!.RR]).toEqual([4, 5, 6]);
    expect(cropped.laps[0]!.sectorTimes).toEqual([20, 21, 22]);
    expect(cropped.laps[0]!.sectorStarts).toEqual([0.33, 0.67]);

    const detail = set([1, 1.5, 2]);
    const merged = mergeAlignedLapRange(base, detail);
    expect([...merged.laps[0]!.tirePressure!.FL]).toEqual([1, 1.5, 2]);
    expect(merged.laps[0]!.sectorTimes).toEqual([20, 21, 22]);
  });

  test("aligned semantic adapter exposes per-wheel pressure", () => {
    const samples = semanticTuneSamplesFromAlignedTrace(set([0, 1, 2]).laps[0]!, "acc", 2, 4);
    expect(samples[1]!.tirePressurePsi).toEqual({ fl: 1, fr: 2, rl: 3, rr: 4 });
  });
  test("normalizes reversed and out-of-domain ranges", () => {
    expect(normalizeFidelityRange(90, -10, 100)).toEqual({ start: 0, end: 99, step: 0.1 });
    expect(normalizeFidelityRange(40, 20, 100, 5)).toEqual({ start: 15, end: 45, step: 0.1 });
  });

  test("keeps singleton crops and empty detail responses safe", () => {
    const base = set([0, 1, 2]);
    const singleton = cropAlignedLapSet(base, 1, 1);
    expect([...singleton.distanceMeters]).toEqual([1]);
    expect(singleton.laps[0]!.speedMps.length).toBe(1);
    expect(mergeAlignedLapRange(base, { ...base, distanceMeters: new Float32Array(), laps: [] })).toBe(base);
  });

  test("only requests detail for a materially narrower positive range", () => {
    expect(shouldLoadHighFidelity(1, 100)).toBe(true);
    expect(shouldLoadHighFidelity(98, 100)).toBe(false);
    expect(shouldLoadHighFidelity(0, 100)).toBe(false);
    expect(shouldLoadHighFidelity(-1, 100)).toBe(false);
  });
});
