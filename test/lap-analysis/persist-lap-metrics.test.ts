/**
 * persistLapMetrics writes precomputed fuel/tyre onto the lap at save time, so
 * /lap-metrics is a pure column read for laps recorded going forward (no
 * first-open telemetry decode). Verifies derivation + that nothing is written
 * when no channel is usable.
 */
import { describe, test, expect } from "bun:test";
import { persistLapMetrics } from "../../server/lap-analysis/metrics-store";
import { CapturingDbAdapter } from "../../server/telemetry/pipeline-ports";
import type { TelemetryPacket } from "../../shared/telemetry/types";


function mkPackets(opts: {
  gameId: TelemetryPacket["gameId"];
  fuelPerLap?: number;
  tyreWear?: number[];
  fuel?: [number, number];
  fuelCapacity?: number;
}): TelemetryPacket[] {
  const base = (i: number) => ({ gameId: opts.gameId, DistanceTraveled: i * 5, Speed: 50 } as unknown as TelemetryPacket);
  const a = base(0);
  const b = base(1);
  if (opts.fuel) { (a as any).Fuel = opts.fuel[0]; (b as any).Fuel = opts.fuel[1]; }
  if (opts.fuelCapacity != null) { (a as any).FuelCapacity = opts.fuelCapacity; (b as any).FuelCapacity = opts.fuelCapacity; }
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
    await persistLapMetrics(db, 42, mkPackets({ gameId: "acc", fuelPerLap: 2.7, tyreWear: [0.1, 0.12, 0.2, 0.18] }));
    expect(db.lapMetrics).toHaveLength(1);
    expect(db.lapMetrics[0]).toEqual({ lapId: 42, fuelPerLap: 2.7, tyreWear: 20 });
  });

  test("falls back to fuel delta when no per-lap field", async () => {
    const db = new CapturingDbAdapter();
    await persistLapMetrics(db, 7, mkPackets({ gameId: "acc", fuel: [50, 47.5] }));
    expect(db.lapMetrics[0]).toEqual({ lapId: 7, fuelPerLap: 2.5, tyreWear: null });
  });

  test("converts F1 fuel fraction delta to litres using tank capacity", async () => {
    const db = new CapturingDbAdapter();
    await persistLapMetrics(db, 8, mkPackets({ gameId: "f1-2025", fuel: [0.7, 0.65], fuelCapacity: 110 }));
    expect(db.lapMetrics[0]).toEqual({ lapId: 8, fuelPerLap: 5.5, tyreWear: null });
  });

  test("omits Forza fuel fraction when no litre capacity contract exists", async () => {
    const db = new CapturingDbAdapter();
    await persistLapMetrics(db, 9, mkPackets({ gameId: "fm-2023", fuel: [0.7, 0.65] }));
    expect(db.lapMetrics).toHaveLength(0);
  });

  test("writes nothing when no channel is usable", async () => {
    const db = new CapturingDbAdapter();
    await persistLapMetrics(db, 10, mkPackets({ gameId: "acc" }));
    expect(db.lapMetrics).toHaveLength(0);
  });
});
