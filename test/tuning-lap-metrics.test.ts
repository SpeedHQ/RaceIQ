import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "../shared/types";
import { deriveFuelPerLap } from "../server/tuning-lap-metrics";

/** Pure per-lap metric derivation behind GET /api/tuning-sessions/:id/lap-metrics
 *  (plan §2, Phase C). Tests the compute directly — importing the composed app
 *  would bind the UDP socket as a side effect. */

/** Minimal packet: only the fields the fuel derivation reads. */
function pkt(fuel: number, accFuelPerLap?: number): TelemetryPacket {
  return {
    Fuel: fuel,
    acc: accFuelPerLap != null ? ({ fuelPerLap: accFuelPerLap } as TelemetryPacket["acc"]) : undefined,
  } as unknown as TelemetryPacket;
}

describe("deriveFuelPerLap", () => {
  test("prefers the parser-provided per-lap fuel field (latest positive frame)", () => {
    // acc.fuelPerLap present → used regardless of the Fuel delta.
    const packets = [pkt(50, 0), pkt(48, 2.7), pkt(46, 2.75)];
    expect(deriveFuelPerLap(packets)).toBe(2.75);
  });

  test("falls back to Δ remaining fuel when no per-lap field is present", () => {
    const packets = [pkt(50), pkt(49), pkt(47.4)];
    // 50 − 47.4 = 2.6
    expect(deriveFuelPerLap(packets)).toBe(2.6);
  });

  test("falls back to Δ fuel when the per-lap field is only ever zero", () => {
    const packets = [pkt(30, 0), pkt(28.8, 0)];
    expect(deriveFuelPerLap(packets)).toBe(1.2);
  });

  test("omits (undefined) for legacy laps with no telemetry", () => {
    expect(deriveFuelPerLap([])).toBeUndefined();
    expect(deriveFuelPerLap([pkt(50, 2.7)])).toBeUndefined();
  });

  test("omits when neither source is usable (flat/rising fuel, no field)", () => {
    expect(deriveFuelPerLap([pkt(50), pkt(50)])).toBeUndefined();
    expect(deriveFuelPerLap([pkt(50), pkt(51)])).toBeUndefined();
  });
});
