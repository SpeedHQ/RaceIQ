import { describe, expect, test } from "bun:test";
import { KNOWN_GAME_IDS, type GameId } from "../../shared/games/ids";
import { advanceLiveTrackPosition, type LiveTrackSample, liveTrackSampleFromView, pointForLiveTrackSample } from "../src/components/live-track/live-track-sample";
import type { LiveTelemetryView } from "../src/lib/live-telemetry-view";

function view(simulator: GameId): LiveTelemetryView {
  return {
    simulator,
    streamId: `stream-${simulator}`,
    sessionId: 1,
    sequence: 2,
    observedAtMs: 1_000,
    identity: { trackOrdinal: 42 },
    motion: {
      speedMps: 20,
      distanceM: 500,
      position: { x: 10, z: 20 },
      attitude: { roll: 0, pitch: 0, yaw: 0.5 },
    },
    inputs: {},
    engine: {},
    fuel: {},
    timing: { lapNumber: 3, lapFraction: 0.25 },
    tires: {},
    weather: {},
    aero: {},
    ers: {},
    damage: {},
    competitors: [],
    stateBySemanticId: {},
  };
}

function sample(simulator: GameId, overrides: Partial<LiveTrackSample> = {}): LiveTrackSample {
  return { simulator, observedAtMs: 1_000, ...overrides };
}

describe("canonical live track samples", () => {
  test("preserves simulator identity and explicit canonical units", () => {
    for (const simulator of KNOWN_GAME_IDS) {
      expect(liveTrackSampleFromView(view(simulator))).toEqual({
        simulator,
        observedAtMs: 1_000,
        trackOrdinal: 42,
        lapNumber: 3,
        distanceM: 500,
        lapFraction: 0.25,
        positionM: { x: 10, z: 20 },
        yawRad: 0.5,
        speedMps: 20,
      });
    }
  });

  test("places every simulator from canonical lap fraction", () => {
    const outline = [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
    ];
    for (const simulator of KNOWN_GAME_IDS) {
      expect(pointForLiveTrackSample(sample(simulator, { lapFraction: 0.25 }), outline, { useWorldPosition: false })).toEqual({ x: 25, z: 0 });
    }
  });

  test("keeps unavailable position distinct from legitimate origin", () => {
    const outline = [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
    ];
    expect(pointForLiveTrackSample(sample("acc"), outline, { useWorldPosition: true })).toBeNull();
    expect(pointForLiveTrackSample(sample("acc", { positionM: { x: 0, z: 0 } }), outline, { useWorldPosition: true })).toEqual({ x: 0, z: 0 });
  });

  test("dead-reckons from canonical speed and yaw without simulator branches", () => {
    for (const simulator of KNOWN_GAME_IDS) {
      const previous = sample(simulator, { observedAtMs: 1_000, yawRad: 0, speedMps: 10 });
      const current = sample(simulator, { observedAtMs: 1_100, yawRad: 0, speedMps: 10 });
      expect(advanceLiveTrackPosition(previous, current, { x: 0, z: 0 })).toEqual({ x: 0, z: 1 });
    }
  });
});
