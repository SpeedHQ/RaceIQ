/**
 * Wire-codec parity for the batch lap-trace path. The server builds a LapTrace
 * and ships it as base64 Float32 columns (/api/laps/traces); the client decodes
 * back to Float32Arrays. Round-trip must be exact, and encodeLapTrace →
 * decodeLapTrace must reproduce the original trace bit-for-bit.
 */
import { describe, test, expect } from "bun:test";
import { initGameAdapters } from "../../../shared/games/init";
import { downsampleLap } from "../../../shared/racing/laps/trace/build";
import {
  f32ToBase64,
  base64ToF32,
  encodeLapTrace,
  decodeLapTrace,
} from "../../../shared/racing/laps/trace/codec";
import type { LapTrace } from "../../../shared/racing/laps/trace/types";
import type { TelemetryPacket } from "../../../shared/telemetry/types";

initGameAdapters();

function expectF32Equal(a: Float32Array | null, b: Float32Array | null) {
  if (a === null || b === null) {
    expect(a).toBe(b as null);
    return;
  }
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
}

describe("base64 Float32 codec", () => {
  test("round-trips arbitrary values incl. negatives, fractions, extremes", () => {
    const arr = new Float32Array([0, -1, 1, 0.5, -0.001, 123456.78, -987654.3, 3.4e38, -3.4e38]);
    const back = base64ToF32(f32ToBase64(arr));
    expectF32Equal(back, arr);
  });

  test("empty array round-trips to empty", () => {
    const back = base64ToF32(f32ToBase64(new Float32Array(0)));
    expect(back.length).toBe(0);
  });

  test("large array (50k samples) round-trips exactly", () => {
    const arr = new Float32Array(50_000);
    for (let i = 0; i < arr.length; i++) arr[i] = Math.sin(i) * 1000;
    const back = base64ToF32(f32ToBase64(arr));
    expectF32Equal(back, arr);
  });

  test("decoding a subarray view does not leak neighbouring samples", () => {
    const parent = new Float32Array([9, 9, 1, 2, 3, 9, 9]);
    const view = parent.subarray(2, 5); // [1,2,3]
    const back = base64ToF32(f32ToBase64(view));
    expectF32Equal(back, new Float32Array([1, 2, 3]));
  });
});

describe("encodeLapTrace / decodeLapTrace", () => {
  test("reproduces a full LapTrace exactly", () => {
    // Synthetic telemetry with distance, inputs, and ACC tire channels.
    const telemetry: TelemetryPacket[] = [];
    for (let i = 0; i < 200; i++) {
      telemetry.push({
        DistanceTraveled: i * 5,
        CurrentLap: i * 0.05,
        TimestampMS: i * 16,
        Accel: (i % 256),
        Brake: ((i * 3) % 256),
        Steer: ((i % 257) - 128),
        Speed: 40 + (i % 60),
        TireTempFL: 80 + (i % 10),
        TireTempFR: 82 + (i % 10),
        TireTempRL: 78 + (i % 10),
        TireTempRR: 79 + (i % 10),
        TireSlipAngleFL: 0.05 + (i % 5) * 0.01,
        TireSlipAngleFR: 0.05 + (i % 5) * 0.01,
        TireSlipAngleRL: 0.02,
        TireSlipAngleRR: 0.02,
        AccelerationX: Math.sin(i) * 2,
        AccelerationZ: Math.cos(i) * -3,
        NormSuspensionTravelFL: 0.3 + (i % 10) * 0.01,
        NormSuspensionTravelFR: 0.31,
        NormSuspensionTravelRL: 0.4,
        NormSuspensionTravelRR: 0.41,
        TireCombinedSlipFL: 0.05,
        TireCombinedSlipFR: 0.06,
        TireCombinedSlipRL: 0.03,
        TireCombinedSlipRR: 0.04,
        BrakeTempFrontLeft: 350 + (i % 10),
        BrakeTempFrontRight: 360,
        BrakeTempRearLeft: 300,
        BrakeTempRearRight: 310,
      } as unknown as TelemetryPacket);
    }
    const trace = downsampleLap(1, 2, true, telemetry, null) as LapTrace;
    expect(trace).not.toBeNull();

    const decoded = decodeLapTrace(encodeLapTrace(trace));

    expect(decoded.lapId).toBe(trace.lapId);
    expect(decoded.lapNumber).toBe(trace.lapNumber);
    expect(decoded.isValid).toBe(trace.isValid);
    expect(decoded.n).toBe(trace.n);
    expectF32Equal(decoded.frac, trace.frac);
    expectF32Equal(decoded.throttle, trace.throttle);
    expectF32Equal(decoded.brake, trace.brake);
    expectF32Equal(decoded.steer, trace.steer);
    expectF32Equal(decoded.speedKmh, trace.speedKmh);
    expectF32Equal(decoded.timeS, trace.timeS);
    expect(decoded.tire).toEqual(trace.tire);
    expect(decoded.pressure).toEqual(trace.pressure);
    if (trace.tireTempTrace) {
      expectF32Equal(decoded.tireTempTrace!.FL, trace.tireTempTrace.FL);
      expectF32Equal(decoded.tireTempTrace!.RR, trace.tireTempTrace.RR);
    }
    expect(decoded.pressureTrace).toBe(null); // no pressure channels in fixture

    // New balance/grip/suspension channels round-trip bit-exact too.
    expect(trace.balance).not.toBeNull();
    expect(trace.latG).not.toBeNull();
    expect(trace.longG).not.toBeNull();
    expect(trace.suspTravel).not.toBeNull();
    expect(trace.combinedSlip).not.toBeNull();
    expectF32Equal(decoded.balance, trace.balance);
    expectF32Equal(decoded.latG, trace.latG);
    expectF32Equal(decoded.longG, trace.longG);
    expectF32Equal(decoded.suspTravel!.FL, trace.suspTravel!.FL);
    expectF32Equal(decoded.suspTravel!.RR, trace.suspTravel!.RR);
    expectF32Equal(decoded.combinedSlip!.FL, trace.combinedSlip!.FL);
    expectF32Equal(decoded.combinedSlip!.RR, trace.combinedSlip!.RR);

    expect(trace.brakeTemp).not.toBeNull();
    expect(decoded.brakeTemp).toEqual(trace.brakeTemp);
    expect(trace.brakeTempTrace).not.toBeNull();
    expectF32Equal(decoded.brakeTempTrace!.FL, trace.brakeTempTrace!.FL);
    expectF32Equal(decoded.brakeTempTrace!.RR, trace.brakeTempTrace!.RR);
  });

  test("balance/latG/longG/suspTravel/combinedSlip encode/decode to null when absent", () => {
    const telemetry: TelemetryPacket[] = [];
    for (let i = 0; i < 20; i++) {
      telemetry.push({
        DistanceTraveled: i * 5,
        CurrentLap: i * 0.05,
        TimestampMS: i * 16,
        Accel: 0,
        Brake: 0,
        Steer: 0,
        Speed: 30,
      } as unknown as TelemetryPacket);
    }
    const trace = downsampleLap(1, 2, true, telemetry, null) as LapTrace;
    const decoded = decodeLapTrace(encodeLapTrace(trace));
    expect(decoded.balance).toBeNull();
    expect(decoded.latG).toBeNull();
    expect(decoded.longG).toBeNull();
    expect(decoded.suspTravel).toBeNull();
    expect(decoded.combinedSlip).toBeNull();
    expect(decoded.brakeTemp).toBeNull();
    expect(decoded.brakeTempTrace).toBeNull();
  });
});
