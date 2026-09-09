import { beforeEach, describe, expect, test } from "bun:test";
import type { GearingSample } from "../client/src/lib/gearing-telemetry";
import {
  getGearingTelemetryState,
  ingestGearingTelemetry,
  isLaunchHold,
  isPullBack,
  resetGearingTelemetry,
  setAutoRecording,
  setGearingRecording,
  trackGearingMaxSpeed,
} from "../client/src/lib/gearing-telemetry";
import { initGameAdapters } from "../shared/games/init";

initGameAdapters();

/** Minimal valid fm-2023 sample (passes isSampleValid). */
function makePacket(overrides: Partial<GearingSample> = {}): GearingSample {
  return {
    gameId: "fm-2023",
    raceActive: true,
    CarOrdinal: 1,
    TrackOrdinal: 1,
    sessionUID: "test-session",
    Gear: 2,
    rpm: 4000,
    speedMps: 80,
    powerW: 300,
    torqueNm: 400,
    AccelerationZ: 0.2,
    Accel: 255,
    Brake: 0,
    EngineMaxRpm: 8000,
    EngineIdleRpm: 1000,
    LapNumber: 1,
    DistanceTraveled: 0,
    ...overrides,
  };
}

describe("gearing telemetry recording gate", () => {
  beforeEach(() => {
    resetGearingTelemetry();
    setGearingRecording(true);
  });

  test("ingests samples while recording", () => {
    ingestGearingTelemetry(makePacket());
    const state = getGearingTelemetryState();
    expect(state.buckets[2]).toBeDefined();
    expect(state.accelZHistory).toHaveLength(1);
  });

  test("ignores samples while paused", () => {
    setGearingRecording(false);
    ingestGearingTelemetry(makePacket());
    const state = getGearingTelemetryState();
    expect(state.buckets[2]).toBeUndefined();
    expect(state.accelZHistory).toHaveLength(0);
  });

  test("resumes after pause and keeps prior data", () => {
    ingestGearingTelemetry(makePacket());
    setGearingRecording(false);
    ingestGearingTelemetry(makePacket({ rpm: 5000 }));
    setGearingRecording(true);
    ingestGearingTelemetry(makePacket({ rpm: 6000 }));
    const buckets = getGearingTelemetryState().buckets[2];
    expect(Object.keys(buckets).length).toBe(2); // 4000 and 6000 rpm buckets
    expect(buckets[40]).toBeDefined();
    expect(buckets[60]).toBeDefined();
  });

  test("tracks the highest speed seen while recording", () => {
    ingestGearingTelemetry(makePacket({ speedMps: 80 }));
    ingestGearingTelemetry(makePacket({ speedMps: 120 }));
    ingestGearingTelemetry(makePacket({ speedMps: 95 }));
    expect(getGearingTelemetryState().maxSpeed).toBe(120);
  });

  test("does not update max speed while paused", () => {
    ingestGearingTelemetry(makePacket({ speedMps: 80 }));
    setGearingRecording(false);
    ingestGearingTelemetry(makePacket({ speedMps: 200 }));
    expect(getGearingTelemetryState().maxSpeed).toBe(80);
  });

  test("session change while paused does not wipe frozen data", () => {
    ingestGearingTelemetry(makePacket({ speedMps: 80 }));
    setGearingRecording(false);
    // Different car/session arrives while paused — must be ignored entirely.
    ingestGearingTelemetry(makePacket({ CarOrdinal: 999, speedMps: 200 }));
    const state = getGearingTelemetryState();
    expect(state.maxSpeed).toBe(80);
    expect(state.sessionKey).toBe("1:1:test-session");
    expect(state.buckets[2]).toBeDefined();
  });

  test("reset clears data but leaves the recording flag untouched", () => {
    ingestGearingTelemetry(makePacket());
    resetGearingTelemetry();
    const state = getGearingTelemetryState();
    expect(Object.keys(state.buckets)).toHaveLength(0);
    expect(state.maxSpeed).toBe(0);
    expect(state.recording).toBe(true);
  });

  test("state exposes the recording flag", () => {
    setGearingRecording(false);
    expect(getGearingTelemetryState().recording).toBe(false);
  });

  test("beeps on both start and stop transitions", () => {
    let playCount = 0;
    const originalAudio = globalThis.Audio;
    globalThis.Audio = class {
      currentTime = 0;
      play() {
        playCount++;
        return Promise.resolve();
      }
    } as unknown as typeof Audio;
    try {
      setGearingRecording(false); // stop → beep
      setGearingRecording(true); // start → beep
      setGearingRecording(true); // no transition → silent
      expect(playCount).toBe(2);
    } finally {
      globalThis.Audio = originalAudio;
    }
  });
});

describe("always-on session max speed", () => {
  beforeEach(() => {
    resetGearingTelemetry();
  });

  test("keeps climbing even while the dyno recording is paused", () => {
    ingestGearingTelemetry(makePacket({ speedMps: 80 }));
    setGearingRecording(false);
    trackGearingMaxSpeed(makePacket({ speedMps: 200 }));
    trackGearingMaxSpeed(makePacket({ speedMps: 150 }));
    expect(getGearingTelemetryState().maxSpeed).toBe(200);
  });

  test("resets when the car/track/session changes", () => {
    trackGearingMaxSpeed(makePacket({ speedMps: 200 }));
    trackGearingMaxSpeed(makePacket({ CarOrdinal: 999, speedMps: 90 }));
    expect(getGearingTelemetryState().maxSpeed).toBe(90);
  });

  test("ignores invalid samples", () => {
    trackGearingMaxSpeed(makePacket({ speedMps: 120, Gear: 0, rpm: 0 }));
    expect(getGearingTelemetryState().maxSpeed).toBe(0);
  });
});

describe("pull-back auto-stop detector", () => {
  beforeEach(() => {
    resetGearingTelemetry();
  });

  test("fires exactly once when the driver lifts after a sustained WOT pull", () => {
    for (let i = 0; i < 16; i++) isPullBack(makePacket({ rpm: 3000 + i * 300 }));
    expect(isPullBack(makePacket({ Accel: 0 }))).toBe(true); // lift ends the pull
    expect(isPullBack(makePacket({ Accel: 0 }))).toBe(false); // one-shot
  });

  test("ignores short throttle blips", () => {
    for (let i = 0; i < 5; i++) isPullBack(makePacket({ rpm: 6000 }));
    expect(isPullBack(makePacket({ Accel: 0 }))).toBe(false);
  });

  test("ignores lifts before the pull climbs above 60% of the RPM span", () => {
    for (let i = 0; i < 16; i++) isPullBack(makePacket({ rpm: 3000 }));
    // 3000 < idle(1000) + 0.6 × (8000-1000) = 5200
    expect(isPullBack(makePacket({ Accel: 0 }))).toBe(false);
  });

  test("does not fire while still at full throttle", () => {
    for (let i = 0; i < 16; i++) isPullBack(makePacket({ rpm: 6000 }));
    expect(isPullBack(makePacket({ rpm: 7000 }))).toBe(false);
  });
});

describe("launch hold auto-start detector", () => {
  beforeEach(() => {
    resetGearingTelemetry();
  });

  test("fires once after ~2 s stopped with the brake held", () => {
    for (let i = 0; i < 19; i++) expect(isLaunchHold(makePacket({ speedMps: 0, Brake: 255 }))).toBe(false);
    expect(isLaunchHold(makePacket({ speedMps: 0, Brake: 255 }))).toBe(true); // 20th sample
    expect(isLaunchHold(makePacket({ speedMps: 0, Brake: 255 }))).toBe(false); // one-shot
  });

  test("movement resets the hold", () => {
    for (let i = 0; i < 15; i++) isLaunchHold(makePacket({ speedMps: 0, Brake: 255 }));
    isLaunchHold(makePacket({ speedMps: 10, Brake: 255 })); // rolling
    // Without the reset the 5th sample would complete the 20-sample streak.
    for (let i = 0; i < 4; i++) expect(isLaunchHold(makePacket({ speedMps: 0, Brake: 255 }))).toBe(false);
  });

  test("releasing the brake resets the hold", () => {
    for (let i = 0; i < 15; i++) isLaunchHold(makePacket({ speedMps: 0, Brake: 255 }));
    isLaunchHold(makePacket({ speedMps: 0, Brake: 0 })); // brake released
    for (let i = 0; i < 4; i++) expect(isLaunchHold(makePacket({ speedMps: 0, Brake: 255 }))).toBe(false);
  });
});

describe("auto recording switch", () => {
  test("flag toggles and survives a data reset", () => {
    expect(getGearingTelemetryState().autoRecording).toBe(true);
    setAutoRecording(false);
    expect(getGearingTelemetryState().autoRecording).toBe(false);
    resetGearingTelemetry();
    expect(getGearingTelemetryState().autoRecording).toBe(false);
    setAutoRecording(true);
  });
});
