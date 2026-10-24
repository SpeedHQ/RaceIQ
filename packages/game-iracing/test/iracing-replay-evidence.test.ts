import { describe, expect, test } from "bun:test";
import { normalizeIRacingFrame } from "../src/normalizer";
import { sampleFrame } from "./support/games/iracing-sdk";
import { compileTelemetryResolver } from "@raceiq/telemetry-core/telemetry/resolver/compile";
import { TELEMETRY_CATALOG } from "@raceiq/shared/telemetry/catalog/data";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

describe("iRacing replay source evidence", () => {
  test("missing or invalid lap distance cannot place replay at start/finish", () => {
    for (const fraction of [undefined, -1, 1.5, NaN, Infinity]) {
      const source = sampleFrame();
      const values = { ...source.values };
      if (fraction === undefined) delete values.LapDistPct;
      else values.LapDistPct = fraction;
      delete values.LapDist;
      const packet = normalizeIRacingFrame({ ...source, values });
      expect(Number.isFinite(packet.iracing!.lapDistancePct)).toBe(false);
      expect(Number.isFinite(packet.DistanceTraveled)).toBe(false);
      const resolver = compileTelemetryResolver<{ packet: TelemetryPacket; nativeValues: typeof values }>(TELEMETRY_CATALOG, { simulator: "iracing", requested: [{ semanticId: "timing.lap-fraction" }] });
      const view = resolver.createFrameView({ packet, nativeValues: values }, { timestamp: { domain: "session", milliseconds: 1000 }, updateSequence: 1n });
      const resolved = view.resolveNumber(resolver.slot("timing.lap-fraction"));
      expect(resolved.state).not.toBe("ok");
    }
  });

  test("partial or absent pit wear never becomes fresh tyre health", () => {
    const source = sampleFrame();
    const values = { ...source.values };
    delete values.LFwearL;
    expect(Number.isFinite(normalizeIRacingFrame({ ...source, values }).TireWearFL)).toBe(false);
    values.LFwearL = 1.2;
    expect(Number.isFinite(normalizeIRacingFrame({ ...source, values }).TireWearFL)).toBe(false);
    values.LFwearL = 1;
    values.LFwearM = 0.9;
    values.LFwearR = 0.8;
    expect(normalizeIRacingFrame({ ...source, values }).TireWearFL).toBeCloseTo(0.2);
  });

  test("missing attitude and acceleration stay unavailable rather than level and zero G", () => {
    const source = sampleFrame();
    const values = { ...source.values };
    for (const key of ["Yaw", "Pitch", "Roll", "LatAccel", "LongAccel"]) delete values[key];
    const packet = normalizeIRacingFrame({ ...source, values });
    for (const value of [packet.Yaw, packet.Pitch, packet.Roll, packet.AccelerationX, packet.AccelerationZ]) expect(Number.isFinite(value)).toBe(false);
  });
});
