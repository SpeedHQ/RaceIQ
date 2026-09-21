import { expect, test } from "bun:test";
import { join } from "node:path";
import { ensureInit, parseDump } from "../support/recordings/parse-dump";
import { LiveTelemetryProjector } from "../../server/telemetry/live-projector";
import { CrewChiefTriggerCatalog } from "../../server/live-strategy/crewchief-triggers/catalog";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { runLiveEngineerSessionReplay, type LiveEngineerReplayScenario } from "../../server/live-strategy/live-engineer-replay";
import type { LiveEngineerSessionReplayV1 } from "../../shared/racing/live/engineer-replay-contracts";

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

const runScenario = (source: TelemetryPacket, scenario: LiveEngineerReplayScenario) => runLiveEngineerSessionReplay({
  session: { id: 1, gameId: "acc" },
  laps: [],
  packets: Array.from({ length: 20 }, (_, index) => ({
    ...source,
    LapNumber: Math.floor(index / 5) + 1,
    TimestampMS: index * 10_000,
    CurrentLap: (index % 5) * 10_000,
    LastLap: 40_000,
  })),
  sourceProfile: {
    gameId: "acc",
    captureKind: "test",
    limitations: [],
    sourceClockCaptured: true,
    segmentCount: 1,
    skippedMalformedFrames: 0,
    nativeSessionInfo: false,
    retainedPrefix: false,
  },
  scenario,
});

const relevantTriggers = (scenario: LiveEngineerSessionReplayV1) => scenario.annotations
  .filter((annotation) => annotation.stage === "trigger")
  .sort((left, right) => left.frameIndex - right.frameIndex)
  .map((annotation) => annotation.action)
  .filter((action) => ["fuel-low", "fuel-critical", "pit-this-lap", "pit-pit-pit", "pit-entry"].includes(action));

test("ACC synthetic fuel shortage spans multiple laps through pit entry", async () => {
  const { rawPackets } = await parseDump("acc", RECORDING, { capturePackets: true });
  const source = rawPackets.find((packet) => packet.acc?.fuelPerLap && packet.acc.fuelPerLap > 0);
  expect(source).toBeDefined();
  if (!source) return;

  const replay = runScenario(source, "critical-fuel-pit-sequence");
  expect(relevantTriggers(replay)).toEqual(["fuel-low", "fuel-critical", "pit-this-lap", "pit-pit-pit", "pit-entry"]);

  const spoken = replay.annotations
    .filter((annotation) => annotation.stage === "callout" || (annotation.stage === "voice-line" && annotation.audioLineId))
    .sort((left, right) => left.frameIndex - right.frameIndex)
    .map((annotation) => annotation.renderedText ?? annotation.audioLineId)
    .filter((text) => ["Fuel is low.", "Fuel is critical.", "Pit this lap.", "Pit pit pit."].includes(text ?? ""));
  expect(spoken).toEqual(["Fuel is low.", "Fuel is critical.", "Pit this lap.", "Pit pit pit."]);
});

test("ACC multi-lap scenarios isolate fuel escalation and scheduled pit sequences", async () => {
  const { rawPackets } = await parseDump("acc", RECORDING, { capturePackets: true });
  const source = rawPackets.find((packet) => packet.acc?.fuelPerLap && packet.acc.fuelPerLap > 0);
  expect(source).toBeDefined();
  if (!source) return;

  expect(relevantTriggers(runScenario(source, "fuel-warning-escalation"))).toEqual(["fuel-low", "fuel-critical"]);
  expect(relevantTriggers(runScenario(source, "scheduled-pit-sequence"))).toEqual(["pit-this-lap", "pit-pit-pit", "pit-entry"]);
});
