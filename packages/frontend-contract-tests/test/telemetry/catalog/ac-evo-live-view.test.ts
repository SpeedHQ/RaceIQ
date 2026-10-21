import { expect, test } from "bun:test";
import { readKunosFrames } from "@raceiq/capture-formats/kunos/dump";
import { createAcEvoParserCache, parseAcEvoBuffers } from "@raceiq/game-ac-evo/parser";
import { LiveTelemetryProjector } from "@raceiq/telemetry-core/telemetry/live-projector";
import { buildLiveTelemetryView } from "client/src/lib/live-telemetry-view";

const RECORDING = "test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz";

test("AC Evo live tire grid receives distinct tread bands and core from native recording", () => {
  const native = readKunosFrames(RECORDING, 2001)[2000];
  const packet = parseAcEvoBuffers(native.physics, native.graphics, native.staticData, createAcEvoParserCache());
  expect(packet).not.toBeNull();
  const projection = new LiveTelemetryProjector().project({ packet: packet!, receivedAtMs: packet!.TimestampMS });
  const view = buildLiveTelemetryView(projection.schema!, projection.frame!);
  const frontLeft = view?.tires.surfaceTemperatureC?.fl;
  const frontRight = view?.tires.surfaceTemperatureC?.fr;
  expect(frontLeft?.inner).toBeCloseTo(68.6294, 3);
  expect(frontLeft?.middle).toBeCloseTo(66.4841, 3);
  expect(frontLeft?.outer).toBeCloseTo(64.5461, 3);
  expect(frontRight?.inner).toBeCloseTo(56.542, 3);
  expect(frontRight?.outer).toBeCloseTo(53.6113, 3);
  expect(view?.tires.coreTemperatureC?.fl).toBeCloseTo(61.0005, 3);
});
