import { describe, expect, test } from "bun:test";
import type { LapMeta } from "../shared/sessions/types";
import type { TelemetryPacket } from "../shared/telemetry/types";
import { consistencyAt, downsampleLap, sampleAt, stintStats } from "../client/src/lib/stint-traces";

function pkt(overrides: Partial<TelemetryPacket>): TelemetryPacket {
  return {
    DistanceTraveled: 0,
    TimestampMS: 0,
    Accel: 0,
    Brake: 0,
    Steer: 0,
    Speed: 0,
    TireTempFL: 0,
    TireTempFR: 0,
    TireTempRL: 0,
    TireTempRR: 0,
    ...overrides,
  } as TelemetryPacket;
}

/** Builds a simple linearly-progressing lap: distance 0..lapDist over
 *  `count` frames, `msPerFrame` apart, constant throttle/brake/steer/speed. */
function makeLap(opts: { count: number; lapDist: number; msPerFrame: number; throttle255: number; brake255: number; steer: number; speedMs: number; tireTemp?: number; startMs?: number }): TelemetryPacket[] {
  const { count, lapDist, msPerFrame, throttle255, brake255, steer, speedMs, tireTemp = 0, startMs = 0 } = opts;
  const out: TelemetryPacket[] = [];
  for (let i = 0; i < count; i++) {
    const tsRaw = startMs + i * msPerFrame;
    out.push(
      pkt({
        DistanceTraveled: (i / (count - 1)) * lapDist,
        TimestampMS: tsRaw % 4294967296,
        Accel: throttle255,
        Brake: brake255,
        Steer: steer,
        Speed: speedMs,
        TireTempFL: tireTemp,
        TireTempFR: tireTemp,
        TireTempRL: tireTemp,
        TireTempRR: tireTemp,
      }),
    );
  }
  return out;
}

describe("downsampleLap", () => {
  test("keeps one sample per raw frame and normalizes channels", () => {
    const telemetry = makeLap({ count: 1000, lapDist: 4000, msPerFrame: 16, throttle255: 255, brake255: 0, steer: 64, speedMs: 50 });
    const trace = downsampleLap(1, 1, true, telemetry, null);
    expect(trace).not.toBeNull();
    expect(trace!.n).toBe(telemetry.length);
    expect(trace!.frac.length).toBe(telemetry.length);
    expect(trace!.throttle.length).toBe(telemetry.length);
    // Accel 255 -> normalized to 1
    expect(trace!.throttle[10]).toBeCloseTo(1, 2);
    expect(trace!.brake[10]).toBeCloseTo(0, 2);
    // Steer 64/128 = 0.5
    expect(trace!.steer[10]).toBeCloseTo(0.5, 2);
    // Speed 50 m/s -> 180 km/h
    expect(trace!.speedKmh[10]).toBeCloseTo(180, 0);
  });

  test("clamps steer to -1..1 even for out-of-range values", () => {
    const telemetry = makeLap({ count: 200, lapDist: 1000, msPerFrame: 16, throttle255: 0, brake255: 0, steer: -200, speedMs: 10 });
    const trace = downsampleLap(1, 1, true, telemetry, null);
    expect(trace!.steer[100]).toBe(-1);
  });

  test("handles TimestampMS u32 wraparound without producing negative/decreasing time", () => {
    const U32_MAX = 4294967296;
    const telemetry = makeLap({ count: 500, lapDist: 2000, msPerFrame: 20, throttle255: 100, brake255: 0, steer: 0, speedMs: 30, startMs: U32_MAX - 5000 });
    const trace = downsampleLap(1, 1, true, telemetry, null);
    expect(trace).not.toBeNull();
    // timeS should be monotonically non-decreasing across bins
    for (let i = 1; i < trace!.timeS.length; i++) {
      expect(trace!.timeS[i]).toBeGreaterThanOrEqual(trace!.timeS[i - 1]);
    }
    // Total elapsed should be close to (500-1)*20ms = ~9.98s
    expect(trace!.timeS[trace!.timeS.length - 1]).toBeGreaterThan(9);
  });

  test("returns null for empty telemetry", () => {
    expect(downsampleLap(1, 1, true, [], null)).toBeNull();
  });

  test("computes per-lap tire averages skipping zero frames", () => {
    const telemetry: TelemetryPacket[] = [
      pkt({ DistanceTraveled: 0, TimestampMS: 0, TireTempFL: 0, TireTempFR: 80, TireTempRL: 80, TireTempRR: 80 }),
      pkt({ DistanceTraveled: 500, TimestampMS: 16, TireTempFL: 90, TireTempFR: 80, TireTempRL: 80, TireTempRR: 80 }),
      pkt({ DistanceTraveled: 1000, TimestampMS: 32, TireTempFL: 90, TireTempFR: 80, TireTempRL: 80, TireTempRR: 80 }),
    ];
    const trace = downsampleLap(1, 1, true, telemetry, null);
    expect(trace!.tire).not.toBeNull();
    expect(trace!.tire!.FL).toBeCloseTo(90, 5); // zero frame skipped
    expect(trace!.tire!.FR).toBeCloseTo(80, 5);
  });

  test("tire is null when a corner has no non-zero frames", () => {
    const telemetry: TelemetryPacket[] = [pkt({ DistanceTraveled: 0, TimestampMS: 0, TireTempFL: 0, TireTempFR: 0, TireTempRL: 0, TireTempRR: 0 }), pkt({ DistanceTraveled: 500, TimestampMS: 16 })];
    const trace = downsampleLap(1, 1, true, telemetry, null);
    expect(trace!.tire).toBeNull();
  });

  test("uses sectorTimes firstDist/lapDist offset when provided", () => {
    const telemetry: TelemetryPacket[] = [];
    for (let i = 0; i < 100; i++) {
      telemetry.push(pkt({ DistanceTraveled: 1000 + i * 10, TimestampMS: i * 16, Accel: 255, Speed: 20 }));
    }
    const trace = downsampleLap(1, 1, true, telemetry, { firstDist: 1000, lapDist: 990 });
    expect(trace).not.toBeNull();
    expect(trace!.frac[0]).toBeGreaterThanOrEqual(0);
    expect(trace!.frac[trace!.frac.length - 1]).toBeLessThanOrEqual(1);
  });
});

describe("downsampleLap — balance/grip/suspension channels", () => {
  test("populates balance (degrees), latG, longG, suspTravel, combinedSlip when source fields present", () => {
    const telemetry: TelemetryPacket[] = [];
    for (let i = 0; i < 50; i++) {
      telemetry.push(
        pkt({
          DistanceTraveled: i * 20,
          TimestampMS: i * 16,
          // Front slips more than rear -> positive balance (understeer).
          TireSlipAngleFL: 0.1,
          TireSlipAngleFR: 0.1,
          TireSlipAngleRL: 0.02,
          TireSlipAngleRR: 0.02,
          AccelerationX: 4.905, // 0.5g lateral
          AccelerationZ: -9.81, // -1g longitudinal (braking)
          NormSuspensionTravelFL: 0.3,
          NormSuspensionTravelFR: 0.3,
          NormSuspensionTravelRL: 0.4,
          NormSuspensionTravelRR: 0.4,
          TireCombinedSlipFL: 0.05,
          TireCombinedSlipFR: 0.05,
          TireCombinedSlipRL: 0.03,
          TireCombinedSlipRR: 0.03,
          BrakeTempFrontLeft: 350,
          BrakeTempFrontRight: 360,
          BrakeTempRearLeft: 300,
          BrakeTempRearRight: 310,
        } as Partial<TelemetryPacket>),
      );
    }
    const trace = downsampleLap(1, 1, true, telemetry, null)!;

    expect(trace.brakeTemp).not.toBeNull();
    expect(trace.brakeTemp!.FL).toBeCloseTo(350, 5);
    expect(trace.brakeTempTrace).not.toBeNull();
    expect(trace.brakeTempTrace!.FR[10]).toBeCloseTo(360, 5);

    expect(trace.balance).not.toBeNull();
    // (0.1 - 0.02) rad * 180/pi ≈ 4.58 deg, positive = understeer
    expect(trace.balance![10]).toBeCloseTo(4.58, 1);

    expect(trace.latG).not.toBeNull();
    expect(trace.latG![10]).toBeCloseTo(0.5, 2);

    expect(trace.longG).not.toBeNull();
    expect(trace.longG![10]).toBeCloseTo(-1, 2);

    expect(trace.suspTravel).not.toBeNull();
    expect(trace.suspTravel!.FL[10]).toBeCloseTo(0.3, 5);
    expect(trace.suspTravel!.RR[10]).toBeCloseTo(0.4, 5);

    expect(trace.combinedSlip).not.toBeNull();
    expect(trace.combinedSlip!.FL[10]).toBeCloseTo(0.05, 5);
  });

  test("nulls balance/latG/longG/suspTravel/combinedSlip when source fields are absent (all zero)", () => {
    const telemetry: TelemetryPacket[] = [];
    for (let i = 0; i < 20; i++) {
      telemetry.push(pkt({ DistanceTraveled: i * 20, TimestampMS: i * 16 }));
    }
    const trace = downsampleLap(1, 1, true, telemetry, null)!;
    expect(trace.balance).toBeNull();
    expect(trace.latG).toBeNull();
    expect(trace.longG).toBeNull();
    expect(trace.suspTravel).toBeNull();
    expect(trace.combinedSlip).toBeNull();
    expect(trace.brakeTemp).toBeNull();
    expect(trace.brakeTempTrace).toBeNull();
  });

  test("oversteer (rear slips more) yields a negative balance", () => {
    const telemetry: TelemetryPacket[] = [];
    for (let i = 0; i < 20; i++) {
      telemetry.push(
        pkt({
          DistanceTraveled: i * 20,
          TimestampMS: i * 16,
          TireSlipAngleFL: 0.02,
          TireSlipAngleFR: 0.02,
          TireSlipAngleRL: 0.15,
          TireSlipAngleRR: 0.15,
        } as Partial<TelemetryPacket>),
      );
    }
    const trace = downsampleLap(1, 1, true, telemetry, null)!;
    expect(trace.balance).not.toBeNull();
    expect(trace.balance![10]).toBeLessThan(0);
  });
});

describe("sampleAt", () => {
  test("interpolates linearly between bins", () => {
    const telemetry = makeLap({ count: 1000, lapDist: 4000, msPerFrame: 16, throttle255: 255, brake255: 0, steer: 0, speedMs: 30 });
    const trace = downsampleLap(1, 1, true, telemetry, null)!;
    const v0 = sampleAt(trace, "throttle", 0);
    const v1 = sampleAt(trace, "throttle", 1);
    expect(v0).toBeCloseTo(1, 1);
    expect(v1).toBeCloseTo(1, 1);
  });
});

describe("consistencyAt", () => {
  test("returns null with fewer than 2 traces", () => {
    const telemetry = makeLap({ count: 200, lapDist: 1000, msPerFrame: 16, throttle255: 128, brake255: 0, steer: 0, speedMs: 20 });
    const trace = downsampleLap(1, 1, true, telemetry, null)!;
    expect(consistencyAt([trace], 0.5, "throttle")).toBeNull();
  });

  test("scores identical traces at 100", () => {
    const telemetry = makeLap({ count: 200, lapDist: 1000, msPerFrame: 16, throttle255: 128, brake255: 0, steer: 0, speedMs: 20 });
    const a = downsampleLap(1, 1, true, telemetry, null)!;
    const b = downsampleLap(2, 2, true, telemetry, null)!;
    expect(consistencyAt([a, b], 0.5, "throttle")).toBeCloseTo(100, 5);
  });

  test("scores diverging traces below 100", () => {
    const telA = makeLap({ count: 200, lapDist: 1000, msPerFrame: 16, throttle255: 255, brake255: 0, steer: 0, speedMs: 20 });
    const telB = makeLap({ count: 200, lapDist: 1000, msPerFrame: 16, throttle255: 0, brake255: 0, steer: 0, speedMs: 20 });
    const a = downsampleLap(1, 1, true, telA, null)!;
    const b = downsampleLap(2, 2, true, telB, null)!;
    const score = consistencyAt([a, b], 0.5, "throttle")!;
    expect(score).toBeLessThan(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

function lapMeta(overrides: Partial<LapMeta>): LapMeta {
  return {
    id: 1,
    sessionId: 1,
    lapNumber: 1,
    lapTime: 90,
    isValid: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("stintStats", () => {
  test("returns undefined stats with 0 eligible laps", () => {
    const stats = stintStats([lapMeta({ id: 1, lapNumber: 1, isValid: false })]);
    expect(stats.n).toBe(0);
    expect(stats.consistency).toBeUndefined();
    expect(stats.degSlopeSPerLap).toBeUndefined();
  });

  test("excludes the first (out) lap and invalid/excluded laps", () => {
    const laps = [
      lapMeta({ id: 1, lapNumber: 1, lapTime: 100 }), // out-lap, excluded from scoring
      lapMeta({ id: 2, lapNumber: 2, lapTime: 90 }),
      lapMeta({ id: 3, lapNumber: 3, lapTime: 91 }),
      lapMeta({ id: 4, lapNumber: 4, lapTime: 200, isValid: false }), // invalid
      lapMeta({ id: 6, lapNumber: 6, lapTime: 400, experimentExcluded: true }), // excluded
    ];
    const stats = stintStats(laps);
    expect(stats.n).toBe(2);
    expect(stats.bestS).toBe(90);
  });

  test("consistency and sd require n>=2, slope requires n>=3", () => {
    const twoLaps = [lapMeta({ id: 1, lapNumber: 1, lapTime: 100 }), lapMeta({ id: 2, lapNumber: 2, lapTime: 90 })];
    // n=1 scored (lap 1 excluded as out-lap)
    const s1 = stintStats(twoLaps);
    expect(s1.n).toBe(1);
    expect(s1.consistency).toBeUndefined();
    expect(s1.sdS).toBeUndefined();

    const threeLaps = [lapMeta({ id: 1, lapNumber: 1, lapTime: 100 }), lapMeta({ id: 2, lapNumber: 2, lapTime: 90 }), lapMeta({ id: 3, lapNumber: 3, lapTime: 92 })];
    const s2 = stintStats(threeLaps);
    expect(s2.n).toBe(2);
    expect(s2.consistency).toBeDefined();
    expect(s2.degSlopeSPerLap).toBeUndefined(); // still n<3 scored

    const fourLaps = [
      lapMeta({ id: 1, lapNumber: 1, lapTime: 100 }),
      lapMeta({ id: 2, lapNumber: 2, lapTime: 90 }),
      lapMeta({ id: 3, lapNumber: 3, lapTime: 91 }),
      lapMeta({ id: 4, lapNumber: 4, lapTime: 92 }),
    ];
    const s3 = stintStats(fourLaps);
    expect(s3.n).toBe(3);
    expect(s3.degSlopeSPerLap).toBeDefined();
    expect(s3.degSlopeSPerLap!).toBeGreaterThan(0); // times increasing with lap number
  });

  test("consistency formula matches clamp(100 - (sd/mean)*100*28, 0, 100)", () => {
    const laps = [lapMeta({ id: 1, lapNumber: 1, lapTime: 100 }), lapMeta({ id: 2, lapNumber: 2, lapTime: 90 }), lapMeta({ id: 3, lapNumber: 3, lapTime: 92 })];
    const stats = stintStats(laps);
    const times = [90, 92];
    const mean = times.reduce((a, b) => a + b, 0) / 2;
    const variance = times.reduce((a, t) => a + (t - mean) ** 2, 0) / 2;
    const sd = Math.sqrt(variance);
    const expected = Math.max(0, Math.min(100, 100 - (sd / mean) * 100 * 28));
    expect(stats.consistency).toBeCloseTo(expected, 5);
  });
});
