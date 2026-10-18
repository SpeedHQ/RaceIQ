import { describe, expect, test } from "bun:test";
import type { ComparisonData } from "@raceiq/shared/racing/comparison/types";
import type { SemanticLapTelemetry } from "../src/hooks/laps";
import { createSpectateController, prepareSpectateLap } from "../src/lib/spectate-replay";
import type { SpectateLap, SpectateSample } from "../src/components/comparison/spectate/types";
import { channelValue } from "../src/components/comparison/spectate/spectate-channels";
import type { SpectateChannel } from "../src/components/comparison/spectate/spectate-channels";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { buildSpectateChannels } from "../src/components/comparison/spectate/spectate-channels";
import type { SpectatePair } from "../src/components/comparison/spectate/types";

initGameAdapters({ f1Experiments: true, iracingAdapter: true });

function lap(duration: number, distanceAt: (time: number) => number): SpectateLap {
  const samples: SpectateSample[] = Array.from({ length: Math.round(duration * 20) + 1 }, (_, index) => {
    const time = index / 20;
    return {
      time,
      distance: distanceAt(time),
      run: 0,
      values: {
        "motion.position-x": distanceAt(time),
        "motion.position-z": 10,
        "motion.yaw": time < 0.05 ? 3.1 : -3.1,
        "inputs.gear": time < 0.05 ? 2 : 3,
        "fuel.ers-deploy-mode": time < 0.05 ? 1 : 3,
        "tires.test": [time, time + 1, time + 2, time + 3],
      },
    };
  });
  return { samples, duration, distance: distanceAt(duration), hasProgress: true, replay: { lapId: 1, envelopes: [], requestedSemanticIds: [] } };
}

test("seek transitions ease symmetrically and retarget from displayed time", () => {
  const originalRequest = globalThis.requestAnimationFrame,
    originalCancel = globalThis.cancelAnimationFrame,
    originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
  let now = 0,
    nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });
  const tick = (timestamp: number) => {
    now = timestamp;
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    callback(timestamp);
  };
  const controller = createSpectateController(
    lap(10, (time) => time),
    lap(10, (time) => time),
    undefined,
    1000,
  );
  try {
    controller.setActive(true);
    controller.seekDistance(10);
    tick(0);
    tick(300);
    const forwardEarly = controller.getSnapshot().time;
    expect(forwardEarly).toBeCloseTo(0.625);
    expect(controller.getFrameSnapshot(450).time).toBeCloseTo(2.109375);
    expect(controller.getFrameSnapshot(450).a?.pose?.x).toBeCloseTo(2.109375);
    expect(controller.getSnapshot().time).toBeCloseTo(0.625);
    tick(600);
    expect(controller.getSnapshot().time).toBeCloseTo(5);
    tick(900);
    const forwardLate = controller.getSnapshot().time;
    expect(forwardLate).toBeCloseTo(9.375);
    expect(forwardEarly).toBeLessThan(2.5);
    expect(forwardLate).toBeGreaterThan(7.5);
    tick(1200);
    expect(controller.getSnapshot().time).toBe(10);
    expect(controller.getSnapshot().seeking).toBe(false);

    controller.play();
    expect(controller.getFrameSnapshot(1250).a?.pose?.x).toBeCloseTo(0.05);
    expect(controller.getSnapshot().time).toBe(0);
    now = 1250;
    controller.pause();
    expect(controller.getSnapshot().time).toBeCloseTo(0.05);
    expect(controller.getFrameSnapshot(1290).time).toBeCloseTo(0.05);
    controller.scrub(10);
    now = 1300;
    controller.seekDistance(0);
    tick(1300);
    tick(1600);
    const backwardEarly = controller.getSnapshot().time;
    expect(backwardEarly).toBeCloseTo(9.375);
    tick(1900);
    expect(controller.getSnapshot().time).toBeCloseTo(5);
    tick(2200);
    const backwardLate = controller.getSnapshot().time;
    expect(backwardLate).toBeCloseTo(0.625);
    expect(backwardEarly).toBeGreaterThan(7.5);
    expect(backwardLate).toBeLessThan(2.5);
    tick(2500);
    expect(controller.getSnapshot().time).toBe(0);
    expect(controller.getSnapshot().seeking).toBe(false);

    controller.seekDistance(10);
    tick(2501);
    tick(2801);
    const beforeRetarget = controller.getSnapshot().time;
    controller.seekDistance(0);
    expect(controller.getSnapshot().time).toBe(beforeRetarget);
    tick(2801.5);
    expect(controller.getSnapshot().time).toBeCloseTo(beforeRetarget);
    controller.pause();
    expect(controller.getSnapshot().seeking).toBe(false);
    expect(frames.size).toBe(0);
  } finally {
    controller.dispose();
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
    if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
    else Reflect.deleteProperty(globalThis, "performance");
  }
});
describe("Spectate native sampling", () => {
  test("F1 held motion packets do not freeze then accelerate cars or locked progress", () => {
    const times = [0, 0.02, 0.04, 0.06, 0.08];
    const positions = [0, 2, 2, 6, 8];
    const recording = (z: number): SemanticLapTelemetry => ({
      lapId: z + 1, requestedSemanticIds: [],
      envelopes: times.map((time, index) => ({
        sequence: index, simulator: "f1-2025",
        observedAt: { domain: "session", milliseconds: time * 1000 },
        receivedAt: { domain: "session", milliseconds: time * 1000 },
        values: Object.entries({
          "timing.current-lap": time, "motion.position-x": positions[index],
          "motion.position-z": z, "motion.yaw": Math.PI / 2,
          "motion.speed": 100, "inputs.brake": index === 2 ? 75 : 0,
        }).map(([semanticId, value]) => ({ semanticId, value, state: "ok", freshness: "fresh" })),
      })),
    });
    const comparison = { traces: {
      distance: [0, 2, 4, 6, 8], elapsedTimeA: times, elapsedTimeB: times,
      positionXA: [0, 2, 4, 6, 8], positionZA: times.map(() => 0),
      positionXB: [0, 2, 4, 6, 8], positionZB: times.map(() => 5),
    } } as unknown as ComparisonData;
    const a = prepareSpectateLap(recording(0), comparison, "a");
    const b = prepareSpectateLap(recording(5), comparison, "b");
    const controller = createSpectateController(a, b);
    try {
      for (const lock of [false, true]) {
        controller.setPositionLock(lock);
        for (const time of [0.025, 0.03, 0.04, 0.05, 0.055]) {
          const reading = controller.sample(time);
          expect(reading.a?.pose?.x).toBeCloseTo(time * 100);
          expect(reading.b?.pose?.x).toBeCloseTo(time * 100);
          expect(reading.a?.distance).toBeCloseTo(time * 100);
        }
      }
      expect(controller.sample(0.04).a?.values["inputs.brake"]).toBe(75);
      expect(a.samples[2]?.values["motion.position-x"]).toBe(2);
    } finally { controller.dispose(); }
    for (const scenario of ["stopped", "missing", "gap"] as const) {
      const replay = recording(0);
      const held = replay.envelopes[2]!;
      if (scenario === "stopped") held.values.find((value) => value.semanticId === "motion.speed")!.value = 0;
      if (scenario === "missing") held.values.find((value) => value.semanticId === "motion.position-x")!.freshness = "stale";
      if (scenario === "gap") {
        for (const frame of replay.envelopes.slice(3)) frame.values.find((value) => value.semanticId === "timing.current-lap")!.value = Number(frame.values[0]!.value) + 1;
      }
      const prepared = prepareSpectateLap(replay, comparison, "a");
      const checked = createSpectateController(prepared, prepared);
      checked.setPositionLock(false);
      try {
        if (scenario === "stopped") expect(checked.sample(0.04).a?.pose?.x).toBe(2);
        else if (scenario === "missing") expect(checked.sample(0.04).a?.pose).toBeNull();
        else expect(checked.sample(0.5).a).toBeNull();
      } finally { checked.dispose(); }
    }
  });
  test("quantized aligned clocks do not amplify B motion or its input traces", () => {
    const distance = Array.from({ length: 11 }, (_, index) => index);
    const comparison = { traces: {
      distance, elapsedTimeA: distance.map((value) => value / 100),
      elapsedTimeB: [0, 0, 0, 0.025, 0.025, 0.05, 0.05, 0.05, 0.075, 0.075, 0.1],
      positionXA: distance, positionZA: distance.map(() => 0),
      positionXB: distance, positionZB: distance.map(() => 5),
    } } as unknown as ComparisonData;
    const recording = (z: number): SemanticLapTelemetry => ({
      lapId: z + 1, requestedSemanticIds: [],
      envelopes: [0, 0.025, 0.05, 0.075, 0.1].map((time, index) => ({
        sequence: 200 + index * 11, simulator: "f1-2025",
        observedAt: { domain: "session", milliseconds: time * 1000 },
        receivedAt: { domain: "session", milliseconds: time * 1000 },
        values: [
          { semanticId: "timing.current-lap", value: time, state: "ok", freshness: "fresh" },
          { semanticId: "motion.position-x", value: time * 100, state: "ok", freshness: "fresh" },
          { semanticId: "motion.position-z", value: z, state: "ok", freshness: "fresh" },
          { semanticId: "motion.yaw", value: 0, state: "ok", freshness: "fresh" },
          { semanticId: "inputs.accel", value: time * 1000, state: "ok", freshness: "fresh" },
        ],
      })),
    });
    const a = prepareSpectateLap(recording(0), comparison, "a");
    const b = prepareSpectateLap(recording(5), comparison, "b");
    const controller = createSpectateController(a, b);
    expect(controller.getSnapshot().positionLock).toBe(true);
    for (const time of [0.01, 0.02, 0.04, 0.06, 0.08, 0.09]) {
      const readings = controller.sample(time);
      expect(readings.b?.time).toBeCloseTo(time);
      expect(readings.b?.distance).toBeCloseTo(readings.a!.distance!);
      expect(readings.b?.pose?.x).toBeCloseTo(readings.a!.pose!.x);
      expect(readings.b?.pose?.z).toBe(5);
      expect(readings.b?.values["inputs.accel"]).toBeCloseTo(time * 1000);
    }
    controller.dispose();
  });
  test("supported wear rates retain native A/B time and suspension bias keeps wheel components", () => {
    const a = lap(1, (time) => time * 100),
      b = lap(2, (time) => time * 50);
    for (const [index, recording] of [a, b].entries())
      recording.samples = recording.samples.map((sample) => ({
        ...sample,
        values: { ...sample.values, "tires.tire-wear": [0, 1, 2, 3].map((wheel) => sample.time * (index + 1) * 0.01 + wheel * 0.01), "suspension.norm-suspension-travel": [0.1, 0.2, 0.3, 0.4] },
      }));
    const pair: SpectatePair = { gameId: "fm-2023", a, b, comparison: { traces: { distance: [0, 100] }, timeDelta: [0, 1] } as unknown as ComparisonData };
    const channels = buildSpectateChannels(pair);
    const wear = channels.find((channel) => channel.id === "derived.tireWearRate")!;
    const compression = channels.find((channel) => channel.id === "derived.suspensionCompressionBias")!;
    expect(wear?.components.map((component) => component.label)).toEqual(["FL", "FR", "RL", "RR"]);
    const controller = createSpectateController(a, b);
    const reading = controller.sample(0.5);
    expect(reading.b?.time).toBeCloseTo(1);
    expect(channelValue(reading.a, wear, "0", "a")).toBeCloseTo(0.01);
    expect(channelValue(reading.b, wear, "0", "b")).toBeCloseTo(0.02);
    expect(channelValue(reading.a, compression, "front")).toBeCloseTo(0.3);
    expect(channelValue(reading.a, compression, "left")).toBeCloseTo(0.4);
    expect(channelValue({ ...reading.a!, values: {} }, wear, "0")).toBeNull();
    controller.dispose();
  });
  test("comparison delta keeps A-minus-B distance semantics even when elapsed clocks match", () => {
    const channel: SpectateChannel = {
      id: "comparison.time-delta",
      label: "Delta",
      unit: "s",
      components: [{ key: "", label: "" }],
      derived: "delta",
      delta: { distance: [0, 50, 100], values: [0, 1, 3] },
    };
    const reading = { time: 10, distance: 75, pose: null, values: {} };
    expect(channelValue(reading, channel, "")).toBe(2);
    expect(channelValue({ ...reading, time: 20 }, channel, "")).toBe(2);
    expect(channelValue({ ...reading, distance: 101 }, channel, "")).toBeNull();
    expect(channelValue(null, channel, "")).toBeNull();
  });
  test("locked B uses its own earliest arrival; changing alignment preserves master seconds", () => {
    const controller = createSpectateController(
      lap(1, (time) => time * 100),
      lap(2, (time) => time * 50),
    );
    controller.scrub(0.5);
    expect(controller.getSnapshot().duration).toBe(2);
    expect(controller.getSnapshot().a?.time).toBeCloseTo(0.5);
    expect(controller.getSnapshot().b?.time).toBeCloseTo(1);
    expect(controller.getSnapshot().b?.distance).toBeCloseTo(50);
    controller.setPositionLock(false);
    expect(controller.getSnapshot().time).toBe(0.5);
    expect(controller.getSnapshot().b?.time).toBeCloseTo(0.5);
    expect(controller.getSnapshot().b?.distance).toBeCloseTo(25);
    controller.scrub(1.5);
    expect(controller.getSnapshot().a?.pose?.x).toBe(100);
    expect(controller.sample(1.5).a).toBeNull();
    controller.dispose();
  });

  test("plateaus map to earliest arrival and retain the valid departure interval", () => {
    const controller = createSpectateController(
      lap(1, (time) => time * 100),
      lap(2, (time) => (time <= 0.5 ? time * 100 : time <= 1.5 ? 50 : 50 + (time - 1.5) * 100)),
    );
    controller.scrub(0.5);
    expect(controller.getSnapshot().b?.time).toBeCloseTo(0.5);
    controller.scrub(0.525);
    expect(controller.getSnapshot().b?.time).toBeCloseTo(1.525);
    controller.dispose();
  });

  test("heading takes shortest path, gears and deployment modes stay discrete, native wheel components stay distinct", () => {
    const controller = createSpectateController(
      lap(1, (time) => time * 100),
      lap(1, (time) => time * 100),
    );
    const reading = controller.sample(0.025).a!;
    expect(Math.abs(reading.pose!.yaw)).toBeCloseTo(Math.PI);
    expect(reading.values["inputs.gear"]).toBe(2);
    expect(reading.values["fuel.ers-deploy-mode"]).toBe(1);
    expect(controller.sample(0.05).a?.values["fuel.ers-deploy-mode"]).toBe(3);
    expect(reading.values["tires.test"]).toEqual([0.025, 1.025, 2.025, 3.025]);
    controller.dispose();
  });

  test("missing runs and stale channels stay gaps, including exact gap boundaries", () => {
    const a = lap(1, (time) => time * 100);
    a.samples = a.samples.filter((sample) => sample.time < 0.2 || sample.time >= 0.5);
    const controller = createSpectateController(
      a,
      lap(1, (time) => time * 100),
    );
    expect(controller.sample(0.3).a).toBeNull();
    expect(controller.sample(0.5).a?.pose?.x).toBe(50);
    expect(controller.sample(-0.1).a).toBeNull();
    expect(controller.sample(1.1).a).toBeNull();
    controller.dispose();
  });

  test("semantic sequences are not original packet offsets; reset never fabricates a second lap", () => {
    const times = [0, 0.05, 0.1, 0.15, 0.02];
    const replay: SemanticLapTelemetry = {
      lapId: 1,
      requestedSemanticIds: [],
      envelopes: times.map((time, index) => ({
        sequence: 1000 + index * 10,
        simulator: "fm-2023",
        observedAt: { domain: "session", milliseconds: index * 50 },
        receivedAt: { domain: "session", milliseconds: index * 50 },
        values: [
          { semanticId: "timing.current-lap", value: time, state: "ok", freshness: "fresh" },
          { semanticId: "motion.position-x", value: index * 10, state: "ok", freshness: "fresh" },
          { semanticId: "motion.position-z", value: 10, state: "ok", freshness: "fresh" },
          { semanticId: "motion.yaw", value: 0, state: "ok", freshness: "fresh" },
          { semanticId: "timing.distance-traveled", value: index * 12, state: "ok", freshness: "fresh" },
          { semanticId: "motion.speed", value: 50, state: "ok", freshness: index === 1 ? "stale" : "fresh" },
          { semanticId: "fuel.ers-deploy-mode", value: index < 2 ? "2" : "3", state: "ok", freshness: index === 1 ? "stale" : "fresh" },
        ],
      })),
    };
    const comparison = { traces: { elapsedTimeA: [0, 0.05, 0.1, 0.15], distance: [0, 10, 20, 30], sourceIndicesA: [200, 400, 600, 800] } } as unknown as ComparisonData;
    const a = prepareSpectateLap(replay, comparison, "a");
    expect(a.samples.map((sample) => sample.distance)).toEqual([0, 10, 20, 30]);
    expect(a.duration).toBeCloseTo(0.15);
    const controller = createSpectateController(a, a);
    expect(controller.sample(0.025).a?.values["motion.speed"]).toBeNull();
    expect(controller.sample(0.05).a?.pose?.x).toBe(10);
    expect(controller.sample(0.025).a?.values["fuel.ers-deploy-mode"]).toBe("2");
    expect(controller.sample(0.05).a?.values["fuel.ers-deploy-mode"]).toBeNull();
    expect(controller.sample(0.1).a?.values["fuel.ers-deploy-mode"]).toBe("3");
    controller.dispose();
  });
});
