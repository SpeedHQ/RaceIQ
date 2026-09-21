import { expect, test } from "bun:test";
import { join } from "node:path";
import { ensureInit, parseDump } from "../support/recordings/parse-dump";
import { LiveTelemetryProjector } from "../../server/telemetry/live-projector";
import { CrewChiefTriggerCatalog } from "../../server/live-strategy/crewchief-triggers/catalog";
import type { TelemetryPacket } from "../../shared/telemetry/types";

ensureInit();

const RECORDING = join("test", "artifacts", "sessions", "acc-2026-04-12T21-16-07-841Z.bin.gz");

test("ACC fixture lap can drive artificial fuel and pit strategy scenarios", async () => {
  const { rawPackets } = await parseDump("acc", RECORDING, { capturePackets: true });
  const source = rawPackets.find((packet) => packet.acc?.fuelPerLap && packet.acc.fuelPerLap > 0);
  expect(source?.acc?.fuelPerLap).toBeGreaterThan(0);
  if (!source?.acc?.fuelPerLap) return;

  const projector = new LiveTelemetryProjector({
    engineerSemanticIds: ["fuel.remaining-volume", "fuel.fuel-per-lap"],
    allowUnsupportedGame: true,
    engineerEnabled: true,
  });
  const catalog = new CrewChiefTriggerCatalog({ allowUnsupportedGame: true });
  const scenarioPacket = (fuelLaps: number): TelemetryPacket => ({
    ...source,
    Fuel: source.acc!.fuelPerLap * fuelLaps,
  });
  const consume = (fuelLaps: number) => catalog.consume(projector.project({
    packet: scenarioPacket(fuelLaps),
    sessionId: 1,
    receivedAtMs: fuelLaps * 1_000,
  }).semanticFrame).events.filter((event) => event.family === "Fuel").map((event) => event.eventKey);

  expect(consume(3)).toEqual([]);
  expect(consume(1.8)).toEqual(["fuel-low"]);
  expect(consume(0.8)).toEqual(["fuel-critical"]);
  expect(consume(0.7)).toEqual([]);
  expect(consume(3)).toEqual([]);
  expect(consume(1.5)).toEqual(["fuel-low"]);
});
