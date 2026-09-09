import { describe, expect, it } from "bun:test";
import type {
  LiveTelemetryFrameMessageV1,
  LiveTelemetrySchemaMessageV1,
} from "../../shared/telemetry/live/contracts";
import type { CanonicalTelemetryScalar } from "../../shared/telemetry/replay/contracts";
import type { LiveTelemetryView } from "../../client/src/lib/live-telemetry-view";
import { buildLiveTelemetryView } from "../../client/src/lib/live-telemetry-view";
import { viewToGearingSample } from "../../client/src/hooks/useGearingIngest";
const baseView = (): LiveTelemetryView => ({
  simulator: "fm-2023",
  streamId: "s",
  sessionId: null,
  sequence: 1,
  observedAtMs: 0,
  identity: { carOrdinal: 7, trackOrdinal: 3 },
  motion: { speedMps: 10, distanceM: 100, acceleration: { x: 0, z: 1 } },
  inputs: { throttle: 255, brake: 0, steer: 0, gear: 3 },
  engine: { rpm: 5000, idleRpm: 900, maxRpm: 8200, powerW: 200_000, torqueNm: 300 },
  fuel: {},
  timing: { lapNumber: 2 },
  tires: {},
  weather: {},
  aero: {},
  ers: {},
  damage: {},
  race: {},
  session: {},
  competitors: [],
  statusBySemanticId: {},
});

describe("viewToGearingSample", () => {
  it("adapts a fully resolved view into a canonical gearing sample", () => {
    const sample = viewToGearingSample(baseView(), true);
    expect(sample).not.toBeNull();
    expect(sample?.gameId).toBe("fm-2023");
    expect(sample?.CarOrdinal).toBe(7);
    expect(sample?.TrackOrdinal).toBe(3);
    expect(sample?.sessionUID).toBe("s");
    expect(sample?.Accel).toBe(255);
    expect(sample?.Brake).toBe(0);
    expect(sample?.Gear).toBe(3);
    expect(sample?.raceActive).toBe(true);
    expect(sample?.rpm).toBe(5000);
    expect(sample?.EngineMaxRpm).toBe(8200);
    expect(sample?.EngineIdleRpm).toBe(900);
    expect(sample?.AccelerationZ).toBe(1);
    expect(sample?.LapNumber).toBe(2);
    expect(sample?.DistanceTraveled).toBe(100);
  });

  it("keeps units canonical — no user-unit conversion applied", () => {
    // Presentation converts to the user's unit; the sample itself stays
    // canonical: rpm, watts, Nm, m/s. 10 m/s must not become 36 km/h and
    // 200 kW must not become horsepower.
    const sample = viewToGearingSample(baseView(), true);
    expect(sample?.speedMps).toBe(10);
    expect(sample?.powerW).toBe(200_000);
    expect(sample?.torqueNm).toBe(300);
    expect(sample?.rpm).toBe(5000);
  });

  it("maps raceActive=false onto raceActive=false instead of rejecting", () => {
    const sample = viewToGearingSample(baseView(), false);
    expect(sample).not.toBeNull();
    expect(sample?.raceActive).toBe(false);
  });

  it("rejects when a required semantic is unavailable instead of fabricating zeros", () => {
    const missing: { name: string; mutate: (v: LiveTelemetryView) => void }[] = [
      { name: "gear", mutate: (v) => { v.inputs.gear = undefined; } },
      { name: "rpm", mutate: (v) => { v.engine.rpm = undefined; } },
      { name: "speed", mutate: (v) => { v.motion.speedMps = undefined; } },
      { name: "power", mutate: (v) => { v.engine.powerW = undefined; } },
      { name: "torque", mutate: (v) => { v.engine.torqueNm = undefined; } },
      { name: "lap", mutate: (v) => { v.timing.lapNumber = undefined; } },
      { name: "distance", mutate: (v) => { v.motion.distanceM = undefined; } },
    ];
    for (const { name, mutate } of missing) {
      const view = baseView();
      mutate(view);
      expect(viewToGearingSample(view, true), `${name} missing must reject`).toBeNull();
    }
  });

  it("keeps zero fallbacks for non-required fields", () => {
    const view = baseView();
    view.inputs.throttle = undefined;
    view.inputs.brake = undefined;
    view.engine.maxRpm = undefined;
    view.engine.idleRpm = undefined;
    view.motion.acceleration = undefined;
    view.identity.carOrdinal = undefined;
    const sample = viewToGearingSample(view, true);
    expect(sample).not.toBeNull();
    expect(sample?.Accel).toBe(0);
    expect(sample?.Brake).toBe(0);
    expect(sample?.EngineMaxRpm).toBe(0);
    expect(sample?.EngineIdleRpm).toBe(0);
    expect(sample?.AccelerationZ).toBe(0);
    expect(sample?.CarOrdinal).toBe(-1);
  });
});

// The wire path live telemetry takes: resolver projection (schema + frame)
// -> buildLiveTelemetryView -> viewToGearingSample. Frames carrying stale or
// failed resolutions leave the semantics undefined in the view, which the
// adapter must reject instead of converting into zeros.
describe("resolver projection to gearing sample", () => {
  const ids = [
    "motion.speed",
    "timing.distance-traveled",
    "inputs.accel",
    "inputs.brake",
    "inputs.gear",
    "engine.current-engine-rpm",
    "engine.engine-idle-rpm",
    "engine.engine-max-rpm",
    "engine.power",
    "engine.torque",
    "timing.lap-number",
    "race.is-race-on",
  ];
  const schema: LiveTelemetrySchemaMessageV1 = {
    type: "telemetry-schema", protocolVersion: 1, schemaId: "g", simulator: "fm-2023",
    catalogVersion: "c", catalogHash: "h", catalogSchemaVersion: "1",
    parserVersion: "p", resolverVersion: "r", derivationVersion: "d",
    definitions: ids.map((semanticId) => ({ semanticId, unit: null, mappingStatus: "direct", schemaVersion: "1", limitations: [] })),
  };
  // Value at index i answers definition i.
  const values: readonly CanonicalTelemetryScalar[] = [10, 100, 255, 0, 3, 5000, 900, 8200, 200_000, 300, 2, true];
  type FrameStates = NonNullable<LiveTelemetryFrameMessageV1["states"]>;
  type FrameFreshness = NonNullable<LiveTelemetryFrameMessageV1["freshness"]>;
  const frame = (extra?: { states?: FrameStates; freshness?: FrameFreshness }): LiveTelemetryFrameMessageV1 => ({
    type: "telemetry-frame", protocolVersion: 1, schemaId: "g", streamId: "x", sessionId: null,
    sequence: 1, observedAt: { domain: "session", milliseconds: 2 }, receivedAtMs: 3,
    values, states: extra?.states, freshness: extra?.freshness, context: {},
  });

  it("projects resolver values through the view into a canonical sample", () => {
    const view = buildLiveTelemetryView(schema, frame());
    expect(view).toBeDefined();
    const sample = viewToGearingSample(view!, true);
    expect(sample).not.toBeNull();
    expect(sample?.Gear).toBe(3);
    expect(sample?.rpm).toBe(5000);
    expect(sample?.speedMps).toBe(10);
    expect(sample?.powerW).toBe(200_000);
    expect(sample?.torqueNm).toBe(300);
    expect(sample?.raceActive).toBe(true);
  });

  it("rejects the sample when a required semantic is stale", () => {
    // Stale gear (index 4) -> inputs.gear undefined in the view -> reject.
    const view = buildLiveTelemetryView(schema, frame({ freshness: { 4: "stale" } }));
    expect(view?.inputs.gear).toBeUndefined();
    expect(viewToGearingSample(view!, true)).toBeNull();
  });

  it("rejects the sample when a required semantic failed to resolve", () => {
    // Missing power (index 8) -> engine.powerW undefined -> reject.
    const view = buildLiveTelemetryView(schema, frame({ states: { 8: "missing" } }));
    expect(view?.engine.powerW).toBeUndefined();
    expect(viewToGearingSample(view!, true)).toBeNull();
  });
});
