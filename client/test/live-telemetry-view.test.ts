import { describe, expect, it } from "bun:test";
import type { LivePitData } from "../../shared/racing/live/types";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../shared/telemetry/live/contracts";
import { buildLiveTelemetryView, indexTelemetrySchema, readIndexedValue } from "../src/lib/live-telemetry-view";
const schema = {
  type: "telemetry-schema",
  protocolVersion: 1,
  schemaId: "s",
  simulator: "acc",
  catalogVersion: "c",
  catalogHash: "h",
  catalogSchemaVersion: "1",
  parserVersion: "p",
  resolverVersion: "r",
  derivationVersion: "d",
  definitions: ["motion.speed", "tires.tire-pressure", "timing.lap-fraction", "tires.wheel-on-rumble-strip", "tires.tire-compound-name", "motion.acceleration-x", "motion.acceleration-z"].map(
    (semanticId) => ({
      semanticId,
      unit: null,
      mappingStatus: "direct",
      schemaVersion: "1",
      limitations: [],
    }),
  ),
} as LiveTelemetrySchemaMessageV1;
const frame = (values: unknown[], schemaId = "s", states?: Record<number, "missing" | "stale" | "invalid" | "not-applicable" | "error">, context: LiveTelemetryFrameMessageV1["context"] = {}) =>
  ({
    type: "telemetry-frame",
    protocolVersion: 1,
    schemaId,
    streamId: "x",
    sessionId: null,
    sequence: 1,
    observedAt: { domain: "session", milliseconds: 2 },
    receivedAtMs: 3,
    values,
    states,
    context,
  }) as LiveTelemetryFrameMessageV1;
describe("live telemetry view", () => {
  it("indexes semantic values and rejects schema mismatch", () => {
    const i = indexTelemetrySchema(schema);
    expect(readIndexedValue(i, frame([4, [1, 2, 3, 4], 0.5]), "motion.speed")).toBe(4);
    expect(buildLiveTelemetryView(schema, frame([4, 5, 6], "other"))).toBeUndefined();
  });
  it("returns undefined for non-ok values and preserves sparse state", () => {
    const f = frame([4, 5, 0.5], "s", { 1: "stale" });
    const v = buildLiveTelemetryView(schema, f)!;
    expect(v.motion.speedMps).toBe(4);
    expect(v.tires.pressurePsi).toBeUndefined();
    expect(v.stateBySemanticId["tires.tire-pressure"]).toBe("stale");
  });
  it("builds scalar view", () => {
    const v = buildLiveTelemetryView(schema, frame([12, [1, 2, 3, 4], 0.25]))!;
    expect(v.motion.speedMps).toBe(12);
    expect(v.timing.lapFraction).toBe(0.25);
  });
  it("preserves structured boolean wheel values", () => {
    const v = buildLiveTelemetryView(schema, frame([12, [1, 2, 3, 4], 0.25, [true, false, true, false]]))!;
    expect(v.tires.onRumbleStrip).toEqual({ fl: true, fr: false, rl: true, rr: false });
  });
  it("preserves canonical tire compound names", () => {
    const v = buildLiveTelemetryView(schema, frame([12, [1, 2, 3, 4], 0.25, [false, false, false, false], "dry"]))!;
    expect(v.tires.compound).toBe("dry");
  });
  it("rejects malformed fixed wheel cardinality", () => {
    const v = buildLiveTelemetryView(schema, frame([12, [1, 2, 3, 4, 5], 0.25]))!;
    expect(v.tires.pressurePsi).toBeUndefined();
  });
  it("does not zero-pad partial motion vectors", () => {
    const v = buildLiveTelemetryView(schema, frame([12, [1, 2, 3, 4], 0.25, [false, false, false, false], "dry", 1]))!;
    expect(v.motion.acceleration).toBeUndefined();
  });
  it("propagates frame context without changing semantic values", () => {
    const sectors = {
      sectorCount: 3,
      currentSector: 1,
      currentSectorTime: 12,
      currentTimes: [12, 0, 0],
      lastTimes: [10, 11, 12],
      bestTimes: [9, 10, 11],
      lastLapTime: 33,
      bestLapTime: 32,
      estimatedLap: 34,
      deltaToBest: 1,
      deltaToLast: 0,
    };
    const pit: LivePitData = {
      fuelPerLap: 2,
      fuelLapsRemaining: 4,
      currentLapFuelUsed: 1,
      tireLapsToBad: null,
      tireLapsToCritical: null,
      tireEstimates: { toCliff: [null, null, null, null], toDead: [null, null, null, null], wearPerLap: [0, 0, 0, 0] },
      tireWearPerLap: 0,
      pitInLaps: null,
      limitedBy: null,
      trackLength: 5,
      estimateSource: null,
      cliffPct: 60,
      deadPct: 20,
      tireLapsRemaining: null,
    };
    const liveIssues: TuneIssue[] = [{ kind: "understeer", severity: "warn", detail: "test" }];
    const view = buildLiveTelemetryView(schema, frame([12, [1, 2, 3, 4], 0.25], "s", undefined, { sectors, pit, liveIssues }))!;
    expect(view.context).toEqual({ sectors, pit, liveIssues });
  });
});
