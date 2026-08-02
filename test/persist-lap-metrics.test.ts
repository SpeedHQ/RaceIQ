/**
 * persistLapMetrics writes precomputed fuel/tyre onto the lap at save time, so
 * /lap-metrics is a pure column read for laps recorded going forward (no
 * first-open telemetry decode). Verifies derivation + that nothing is written
 * when no channel is usable.
 */
import { describe, test, expect } from "bun:test";
import { persistLapMetrics } from "../server/lap-analysis/metrics-store"
import { CapturingDbAdapter } from "../server/pipeline-adapters";
import type { TelemetryPacket } from "../shared/types";

function mkPackets(opts: { fuelPerLap?: number; tyreWear?: number[]; fuel?: [number, number] }): TelemetryPacket[] {
  const base = (i: number) => ({ DistanceTraveled: i * 5, Speed: 50 } as unknown as TelemetryPacket);
  const a = base(0);
  const b = base(1);
  if (opts.fuel) { (a as any).Fuel = opts.fuel[0]; (b as any).Fuel = opts.fuel[1]; }
  if (opts.fuelPerLap != null) (b as any).acc = { fuelPerLap: opts.fuelPerLap };
  if (opts.tyreWear) {
    const [fl, fr, rl, rr] = opts.tyreWear;
    (b as any).TireWearFL = fl; (b as any).TireWearFR = fr; (b as any).TireWearRL = rl; (b as any).TireWearRR = rr;
  }
  return [a, b];
}

describe("persistLapMetrics", () => {
  test("persists game-reported fuelPerLap + worst-tyre wear", async () => {
    const db = new CapturingDbAdapter();
    await persistLapMetrics(db, 42, mkPackets({ fuelPerLap: 2.7, tyreWear: [0.1, 0.12, 0.2, 0.18] }));
    expect(db.lapMetrics).toHaveLength(1);
    expect(db.lapMetrics[0]).toEqual({ lapId: 42, fuelPerLap: 2.7, tyreWear: 20 });
  });

  test("falls back to fuel delta when no per-lap field", async () => {
    const db = new CapturingDbAdapter();
    await persistLapMetrics(db, 7, mkPackets({ fuel: [50, 47.5] }));
    expect(db.lapMetrics[0]).toEqual({ lapId: 7, fuelPerLap: 2.5, tyreWear: null });
  });

  test("writes nothing when no channel is usable", async () => {
    const db = new CapturingDbAdapter();
    await persistLapMetrics(db, 9, mkPackets({}));
    expect(db.lapMetrics).toHaveLength(0);
  });
});
