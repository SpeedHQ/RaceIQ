import { describe, test, expect } from "bun:test";
import type { SemanticTelemetrySample } from "../../shared/telemetry/replay/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { computeCornerMetrics, type CornerDef } from "../../server/ai/corner-data";

/**
 * `computeCornerMetrics` is the single source of truth for per-corner telemetry
 * math — consumed by both `buildCornerData` (prompt string) and the
 * `get_corner_metrics` agent tool (structured output). These tests pin the pure
 * math so both consumers stay honest.
 *
 * Speed is `sqrt(Vx^2 + Vy^2 + Vz^2) * factor`, factor = 2.237 (mph) / 3.6 (kmh).
 * By keeping Vy = Vz = 0 the speed of a packet is simply `|Vx| * factor`.
 */

function pkt(overrides: Partial<TelemetryPacket>): SemanticTelemetrySample {
  const packet = {
    gameId: "f1-2025",
    IsRaceOn: 1,
    TimestampMS: 0,
    DistanceTraveled: 0,
    VelocityX: 0,
    VelocityY: 0,
    VelocityZ: 0,
    Gear: 1,
    Accel: 0,
    Brake: 0,
    TireSlipAngleFL: 0,
    TireSlipAngleFR: 0,
    TireSlipAngleRL: 0,
    TireSlipAngleRR: 0,
    ...overrides,
  } as TelemetryPacket;
  return {
    values: {
      "timing.distance-traveled": packet.DistanceTraveled,
      "motion.velocity-x": packet.VelocityX,
      "motion.velocity-y": packet.VelocityY,
      "motion.velocity-z": packet.VelocityZ,
      "inputs.gear": packet.Gear,
      "inputs.accel": packet.Accel,
      "inputs.brake": packet.Brake,
      "tires.tire-slip-angle": [packet.TireSlipAngleFL, packet.TireSlipAngleFR, packet.TireSlipAngleRL, packet.TireSlipAngleRR],
    },
    sequence: String(packet.TimestampMS),
    observedAtMs: packet.TimestampMS,
  };
}

// One corner spanning DistanceTraveled 100..200.
const corner: CornerDef = { index: 1, label: "T1", distanceStart: 100, distanceEnd: 200 };

// Approach packets (0..80) then corner packets (100..200).
// Braking (Brake=200) at 60 and 80 only -> contiguous braking ends 40m before apex.
const speedPackets = () =>
  [
    pkt({ DistanceTraveled: 0, VelocityX: 60, Brake: 0 }),
    pkt({ DistanceTraveled: 20, VelocityX: 60, Brake: 0 }),
    pkt({ DistanceTraveled: 40, VelocityX: 60, Brake: 0 }),
    pkt({ DistanceTraveled: 60, VelocityX: 55, Brake: 200 }),
    pkt({ DistanceTraveled: 80, VelocityX: 52, Brake: 200 }),
    // corner packets (in range 100..200)
    pkt({ DistanceTraveled: 100, VelocityX: 50, Gear: 4, Accel: 0, TireSlipAngleFL: 10, TireSlipAngleFR: 10, TireSlipAngleRL: 2, TireSlipAngleRR: 2 }),
    pkt({ DistanceTraveled: 120, VelocityX: 30, Gear: 3, Accel: 0, TireSlipAngleFL: 10, TireSlipAngleFR: 10, TireSlipAngleRL: 2, TireSlipAngleRR: 2 }),
    pkt({ DistanceTraveled: 140, VelocityX: 20, Gear: 2, Accel: 0, TireSlipAngleFL: 10, TireSlipAngleFR: 10, TireSlipAngleRL: 2, TireSlipAngleRR: 2 }),
    pkt({ DistanceTraveled: 160, VelocityX: 25, Gear: 2, Accel: 200, TireSlipAngleFL: 10, TireSlipAngleFR: 10, TireSlipAngleRL: 2, TireSlipAngleRR: 2 }),
    pkt({ DistanceTraveled: 180, VelocityX: 35, Gear: 3, Accel: 200, TireSlipAngleFL: 10, TireSlipAngleFR: 10, TireSlipAngleRL: 2, TireSlipAngleRR: 2 }),
    pkt({ DistanceTraveled: 200, VelocityX: 45, Gear: 4, Accel: 200, TireSlipAngleFL: 10, TireSlipAngleFR: 10, TireSlipAngleRL: 2, TireSlipAngleRR: 2 }),
  ].map((sample, index) => ({
    ...sample,
    sequence: String(index),
    observedAtMs: index * 20,
  }));

describe("computeCornerMetrics", () => {
  test("returns [] for empty corners or empty packets", () => {
    expect(computeCornerMetrics(speedPackets(), [])).toEqual([]);
    expect(computeCornerMetrics([], [corner])).toEqual([]);
  });

  test("skips corners with no packets in their distance range", () => {
    const away: CornerDef = { index: 2, label: "T2", distanceStart: 5000, distanceEnd: 5100 };
    const out = computeCornerMetrics(speedPackets(), [corner, away]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("T1");
  });

  test("computes entry/min/exit speed from the corner packets (mph)", () => {
    const [m] = computeCornerMetrics(speedPackets(), [corner], "mph");
    expect(m.entrySpeed).toBeCloseTo(50 * 2.237, 3); // first packet in range
    expect(m.minSpeed).toBeCloseTo(20 * 2.237, 3); // slowest
    expect(m.exitSpeed).toBeCloseTo(45 * 2.237, 3); // last packet in range
  });

  test("scales speed by the kmh factor when requested", () => {
    const [m] = computeCornerMetrics(speedPackets(), [corner], "kmh");
    expect(m.entrySpeed).toBeCloseTo(50 * 3.6, 3);
    expect(m.minSpeed).toBeCloseTo(20 * 3.6, 3);
  });

  test("picks the most common positive gear", () => {
    // gears 4,3,2,2,3,4 -> tie broken toward the first-seen gear (4)
    const [m] = computeCornerMetrics(speedPackets(), [corner]);
    expect(m.gear).toBe(4);
  });

  test("measures contiguous braking distance before the apex", () => {
    // Braking at 60 and 80, apex at 100 -> 40m of braking
    const [m] = computeCornerMetrics(speedPackets(), [corner]);
    expect(m.brakingDistance).toBeCloseTo(40, 5);
  });

  test("reports throttle-on distance from the first hard-throttle packet", () => {
    // Accel first exceeds 0.5 at distance 160 -> 60m into the corner
    const [m] = computeCornerMetrics(speedPackets(), [corner]);
    expect(m.throttleOnDist).toBeCloseTo(60, 5);
  });

  test("derives time-in-corner from semantic observation timestamps", () => {
    const [m] = computeCornerMetrics(speedPackets(), [corner]);
    expect(m.timeInCorner).toBeCloseTo(0.1, 5);
  });

  test("classifies balance as understeer when front slip dominates", () => {
    const [m] = computeCornerMetrics(speedPackets(), [corner]);
    expect(m.balance).toBe("understeer");
  });

  test("classifies balance as oversteer / neutral from slip ratio", () => {
    const base = { index: 1, label: "C", distanceStart: 0, distanceEnd: 100 } satisfies CornerDef;
    const over = [
      pkt({ DistanceTraveled: 10, VelocityX: 30, TireSlipAngleFL: 2, TireSlipAngleFR: 2, TireSlipAngleRL: 10, TireSlipAngleRR: 10 }),
      pkt({ DistanceTraveled: 50, VelocityX: 30, TireSlipAngleFL: 2, TireSlipAngleFR: 2, TireSlipAngleRL: 10, TireSlipAngleRR: 10 }),
    ];
    const neutral = [
      pkt({ DistanceTraveled: 10, VelocityX: 30, TireSlipAngleFL: 5, TireSlipAngleFR: 5, TireSlipAngleRL: 5, TireSlipAngleRR: 5 }),
      pkt({ DistanceTraveled: 50, VelocityX: 30, TireSlipAngleFL: 5, TireSlipAngleFR: 5, TireSlipAngleRL: 5, TireSlipAngleRR: 5 }),
    ];
    expect(computeCornerMetrics(over, [base])[0].balance).toBe("oversteer");
    expect(computeCornerMetrics(neutral, [base])[0].balance).toBe("neutral");
  });

  test("keeps unavailable gear and slip balance unavailable", () => {
    const samples: SemanticTelemetrySample[] = [
      {
        values: {
          "timing.distance-traveled": 120,
          "motion.velocity-x": 30,
          "motion.velocity-y": 0,
          "motion.velocity-z": 0,
        },
        sequence: "1",
        observedAtMs: 16,
      },
    ];
    const [metrics] = computeCornerMetrics(samples, [corner]);
    expect(metrics.gear).toBeNull();
    expect(metrics.balance).toBeNull();
  });
});
