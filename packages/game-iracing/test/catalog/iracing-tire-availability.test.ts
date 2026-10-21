import { expect, test } from "bun:test";
import { IRacingSourceFrameEncoder } from "@raceiq/capture-formats/iracing/source-frame";
import { compileTelemetryResolver } from "@raceiq/telemetry-core/telemetry/resolver/compile";
import { iracingParser } from "../../src/game-parser";
import { sampleFrame } from "../support/games/iracing-sdk";

const channels = [
  "tire.temperature.surface.representative",
  "tire.temperature.surface.inner",
  "tire.temperature.surface.middle",
  "tire.temperature.surface.outer",
  "tire.temperature.core",
  "tire.temperature.carcass.representative",
  "tire.temperature.carcass.left",
  "tire.temperature.carcass.middle",
  "tire.temperature.carcass.right",
  "tires.tire-pressure",
] as const;

test("iRacing pit snapshots never become canonical live tire temperatures or pressures", () => {
  const encoder = new IRacingSourceFrameEncoder();
  const state = iracingParser.createParserState!();
  const resolver = compileTelemetryResolver({
    simulator: "iracing",
    requested: channels.map((semanticId) => ({ semanticId })),
  });
  for (const [index, onPitRoad] of [false, true, false].entries()) {
    const source = sampleFrame();
    source.values.OnPitRoad = onPitRoad;
    source.values.SessionTime = 125.5 + index;
    for (const corner of ["LF", "RF", "LR", "RR"]) {
      for (const band of ["L", "M", "R"]) source.values[`${corner}tempC${band}`] = 80 + index;
      source.values[`${corner}coldPressure`] = 180;
    }
    const packet = iracingParser.tryParse(encoder.encode(source), state)!;
    // Keep the native pit snapshot available for source inspection, not live readings.
    expect(packet.TireCarcassTempMiddleFL).toBe(80 + index);
    expect(packet.TirePressureFrontLeft).toBeGreaterThan(0);
    const frame = resolver.createFrameView(packet, {
      timestamp: { domain: "session", milliseconds: index * 1_000 },
      updateSequence: BigInt(index),
    });
    for (const semanticId of channels) {
      const slot = resolver.slot(semanticId);
      expect(frame.resolveValue(slot)).toMatchObject({ state: "missing", mappingStatus: "unavailable" });
      expect(frame.readValue(slot)).toBeUndefined();
    }
  }
});
