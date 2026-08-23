import { describe, expect, it } from "bun:test";
import { WATTS_PER_HORSEPOWER } from "../../shared/games/telemetry";
import type { LiveTelemetryView } from "../src/lib/live-telemetry-view";
import { viewToGearingSample } from "../src/hooks/useGearingIngest";

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
  race: { isRaceOn: true },
  competitors: [],
  stateBySemanticId: {},
});

const speedUserUnit = (ms: number) => ms * 3.6;

describe("viewToGearingSample", () => {
  it("adapts a fully resolved view into a gearing sample", () => {
    const sample = viewToGearingSample(baseView(), speedUserUnit);
    expect(sample).not.toBeNull();
    expect(sample?.gameId).toBe("fm-2023");
    expect(sample?.CarOrdinal).toBe(7);
    expect(sample?.TrackOrdinal).toBe(3);
    expect(sample?.sessionUID).toBe("s");
    expect(sample?.Accel).toBe(255);
    expect(sample?.Brake).toBe(0);
    expect(sample?.Gear).toBe(3);
    expect(sample?.IsRaceOn).toBe(1);
    expect(sample?.CurrentEngineRpm).toBe(5000);
    expect(sample?.EngineMaxRpm).toBe(8200);
    expect(sample?.EngineIdleRpm).toBe(900);
    expect(sample?.DisplaySpeed).toBe(36);
    expect(sample?.AccelerationZ).toBe(1);
    expect(sample?.DisplayPower).toBe(200_000 / WATTS_PER_HORSEPOWER);
    expect(sample?.DisplayTorque).toBe(300);
    expect(sample?.LapNumber).toBe(2);
    expect(sample?.DistanceTraveled).toBe(100);
  });

  it("maps isRaceOn=false to 0 instead of rejecting", () => {
    const view = baseView();
    view.race = { isRaceOn: false };
    const sample = viewToGearingSample(view, speedUserUnit);
    expect(sample?.IsRaceOn).toBe(0);
  });

  it("rejects when a required semantic is unavailable instead of fabricating zeros", () => {
    const missing: { name: string; mutate: (v: LiveTelemetryView) => void }[] = [
      { name: "gear", mutate: (v) => { v.inputs.gear = undefined; } },
      { name: "rpm", mutate: (v) => { v.engine.rpm = undefined; } },
      { name: "speed", mutate: (v) => { v.motion.speedMps = undefined; } },
      { name: "power", mutate: (v) => { v.engine.powerW = undefined; } },
      { name: "torque", mutate: (v) => { v.engine.torqueNm = undefined; } },
      { name: "race state", mutate: (v) => { v.race.isRaceOn = undefined; } },
      { name: "lap", mutate: (v) => { v.timing.lapNumber = undefined; } },
      { name: "distance", mutate: (v) => { v.motion.distanceM = undefined; } },
    ];
    for (const { name, mutate } of missing) {
      const view = baseView();
      mutate(view);
      expect(viewToGearingSample(view, speedUserUnit), `${name} missing must reject`).toBeNull();
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
    const sample = viewToGearingSample(view, speedUserUnit);
    expect(sample).not.toBeNull();
    expect(sample?.Accel).toBe(0);
    expect(sample?.Brake).toBe(0);
    expect(sample?.EngineMaxRpm).toBe(0);
    expect(sample?.EngineIdleRpm).toBe(0);
    expect(sample?.AccelerationZ).toBe(0);
    expect(sample?.CarOrdinal).toBe(-1);
  });
});
