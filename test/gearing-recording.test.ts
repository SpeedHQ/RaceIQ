import { beforeEach, describe, expect, test } from "bun:test";
import type { GearingSample } from "../client/src/lib/gearing-telemetry";
import {
  advancePowerBandRun,
  getGearingTelemetryState,
  ingestGearingTelemetry,
  resetGearingTelemetry,
  startPowerBandRun,
  trackGearingMaxSpeed,
  trackEffectiveGearing,
} from "../client/src/lib/gearing-telemetry";
import { initGameAdapters } from "../shared/games/init";

initGameAdapters();

function makePacket(overrides: Partial<GearingSample> = {}): GearingSample {
  return {
    gameId: "fm-2023",
    raceActive: true,
    CarOrdinal: 1,
    TrackOrdinal: 1,
    sessionUID: "test-session",
    Gear: 2,
    rpm: 4_000,
    speedMps: 80,
    powerW: 300,
    torqueNm: 400,
    AccelerationZ: 0.2,
    Accel: 255,
    Brake: 0,
    EngineMaxRpm: 8_000,
    EngineIdleRpm: 1_000,
    LapNumber: 1,
    DistanceTraveled: 0,
    ...overrides,
  };
}

function processPacket(packet: GearingSample) {
  const action = advancePowerBandRun(packet);
  if (action === "record") ingestGearingTelemetry(packet);
  return action;
}

describe("manual-start power-band runs", () => {
  beforeEach(() => {
    resetGearingTelemetry();
  });

  test("arms until full throttle instead of recording partial-throttle data", () => {
    startPowerBandRun();
    expect(processPacket(makePacket({ Accel: 180 }))).toBe("ignore");
    const state = getGearingTelemetryState();
    expect(state.powerBandRunPhase).toBe("armed");
    expect(Object.keys(state.buckets)).toHaveLength(0);
  });

  test("records full throttle then auto-completes on lift", () => {
    startPowerBandRun();
    expect(processPacket(makePacket({ rpm: 4_000 }))).toBe("record");
    expect(processPacket(makePacket({ rpm: 5_000 }))).toBe("record");
    expect(processPacket(makePacket({ rpm: 5_100, Accel: 0 }))).toBe("complete");

    const state = getGearingTelemetryState();
    expect(state.powerBandRunPhase).toBe("idle");
    expect(state.powerBandRuns).toHaveLength(1);
    expect(state.powerBandRuns[0]?.buckets[2]?.[40]).toBeDefined();
    expect(state.powerBandRuns[0]?.buckets[2]?.[50]).toBeDefined();
    expect(state.powerBandRuns[0]?.buckets[2]?.[51]).toBeUndefined();
  });

  test("auto-completes when driver brakes without lifting", () => {
    startPowerBandRun();
    processPacket(makePacket());
    expect(processPacket(makePacket({ Brake: 255 }))).toBe("complete");
    expect(getGearingTelemetryState().powerBandRunPhase).toBe("idle");
    expect(getGearingTelemetryState().powerBandRuns).toHaveLength(1);
  });

  test("new run starts clean while retaining completed history", () => {
    startPowerBandRun();
    processPacket(makePacket({ rpm: 4_000 }));
    processPacket(makePacket({ Accel: 0 }));

    startPowerBandRun();
    let state = getGearingTelemetryState();
    expect(state.powerBandRuns).toHaveLength(1);
    expect(Object.keys(state.buckets)).toHaveLength(0);
    processPacket(makePacket({ rpm: 6_000 }));
    processPacket(makePacket({ Accel: 0 }));

    state = getGearingTelemetryState();
    expect(state.powerBandRuns.map((run) => run.id)).toEqual([2, 1]);
    expect(state.powerBandRuns[0]?.buckets[2]?.[60]).toBeDefined();
    expect(state.powerBandRuns[1]?.buckets[2]?.[40]).toBeDefined();
  });

  test("keeps five most recent completed runs", () => {
    for (let run = 0; run < 6; run++) {
      startPowerBandRun();
      processPacket(makePacket({ rpm: 4_000 + run * 100 }));
      processPacket(makePacket({ Accel: 0 }));
    }
    expect(getGearingTelemetryState().powerBandRuns.map((run) => run.id)).toEqual([6, 5, 4, 3, 2]);
  });

  test("reset clears current data, history, and active run", () => {
    startPowerBandRun();
    processPacket(makePacket());
    processPacket(makePacket({ Accel: 0 }));
    resetGearingTelemetry();
    const state = getGearingTelemetryState();
    expect(state.powerBandRunPhase).toBe("idle");
    expect(state.powerBandRuns).toHaveLength(0);
    expect(Object.keys(state.buckets)).toHaveLength(0);
  });

  test("beeps when run is armed and automatically completed", () => {
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
      startPowerBandRun();
      processPacket(makePacket());
      processPacket(makePacket({ Accel: 0 }));
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

  test("tracks speed without an active power-band run", () => {
    trackGearingMaxSpeed(makePacket({ speedMps: 200 }));
    trackGearingMaxSpeed(makePacket({ speedMps: 150 }));
    expect(getGearingTelemetryState().maxSpeed).toBe(200);
  });

  test("resets when car, track, or session changes", () => {
    trackGearingMaxSpeed(makePacket({ speedMps: 200 }));
    trackGearingMaxSpeed(makePacket({ CarOrdinal: 999, speedMps: 90 }));
    expect(getGearingTelemetryState().maxSpeed).toBe(90);
  });

  test("ignores invalid samples", () => {
    trackGearingMaxSpeed(makePacket({ speedMps: 120, Gear: 0, rpm: 0 }));
    expect(getGearingTelemetryState().maxSpeed).toBe(0);
  });
});

describe("always-on effective gearing", () => {
  beforeEach(() => {
    resetGearingTelemetry();
  });

  test("learns without an active power-band run and resets at a session boundary", () => {
    trackEffectiveGearing(makePacket({ rpm: 4_000, speedMps: 40 }));
    expect(getGearingTelemetryState().effectiveGears[2].rpmPerMps).toBe(100);

    trackEffectiveGearing(makePacket({ CarOrdinal: 999, rpm: 4_000, speedMps: 20 }));
    const state = getGearingTelemetryState();
    expect(state.effectiveGears[2].rpmPerMps).toBe(200);
    expect(state.effectiveGears[2].sampleCount).toBe(1);
  });
});
