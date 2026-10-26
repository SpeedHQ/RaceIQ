import { resolveBalance, resolveWheelStates } from "@raceiq/analysis-core/racing/analysis/metric-values";
import { describe, expect, test } from "bun:test";
import type { ComparisonData } from "@raceiq/shared/racing/comparison/types";
import type { SemanticLapTelemetry } from "@raceiq/lap-replay/contracts";
import { createSpectateController, placeIRacingSpectateLaps, prepareSpectateLap, sampleLap, vehicleSideslipDegrees } from "@raceiq/lap-replay/ui";
import type { SpectateLap, SpectateSample } from "@raceiq/lap-replay/contracts";
import { channelValue } from "@raceiq/lap-replay/ui";
import type { SpectateChannel } from "../../ui/spectate-channels";
import { estimateWheelSlipAngles, resolveWheelSlipGeometry, AMS2_POLO_APPROXIMATE_GEOMETRY, AMS2_POLO_GEOMETRY_DISCLOSURE } from "../../ui/spectate-replay";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { buildSpectateChannels } from "../../ui/spectate-channels"
import type { SpectatePair } from "../../contracts/spectate"
import type { OpponentSemanticLapTelemetry } from "../../contracts/opponents";
import { alignLmuOpponentPositionTraces } from "../../server/opponent-routes";

initGameAdapters({ f1Experiments: true, iracingAdapter: true, ams2Adapter: true });
test("AMS2 dashboard metric descriptors retain canonical balance and traction outputs", () => {
  const balanceMetric = {
    source: "derived" as const,
    confidence: "high" as const,
    binding: { kind: "derived" as const, derivation: "physical-balance-v1" as const, requires: ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y"] },
  };
  const tractionMetric = {
    source: "derived" as const,
    confidence: "exact" as const,
    display: "per-wheel" as const,
    binding: { kind: "derived" as const, derivation: "traction-v1" as const, requires: ["motion.speed", "inputs.steer", "tires.wheel-rotation-speed"] },
  };
  const reading = { values: {
    "motion.speed": 20,
    "motion.acceleration-x": -9.81,
    "motion.angular-velocity-y": 0,
    "inputs.steer": 0.2,
    "tires.wheel-rotation-speed": [60, 60, 60, 60],
  } };
  expect(resolveBalance(reading, balanceMetric)?.state).toBe("understeer");
  expect(resolveBalance({ values: { ...reading.values, "motion.speed": 0 } }, balanceMetric)?.state).toBe("neutral");
  expect(resolveBalance({ values: { ...reading.values, "motion.angular-velocity-y": null } }, balanceMetric)).toBeNull();
  expect(resolveWheelStates(reading, tractionMetric).every(state => state !== null)).toBe(true);
  expect(resolveWheelStates({ values: { ...reading.values, "tires.wheel-rotation-speed": null } }, tractionMetric)).toEqual([null, null, null, null]);
});

test("opponent distance alignment preserves exact samples around missing distances", () => {
  const rows = [0, 10, null, 30, 40].map((distance, index) => {
    const channel = (semanticId: string, value: number | null) => ({
      semanticId, value, state: value === null ? "missing" : "ok", freshness: "fresh",
      provenance: { sourceObservation: { updateSequence: BigInt(index) } },
      mappingStatus: "mapped", confidence: null, confidenceComponents: {}, limitations: [],
    });
    return {
      captureSequence: String(index),
      competitor: {
        vehicleId: "car", incarnation: "1",
        channels: {
          "race.competitor.lap-distance": channel("race.competitor.lap-distance", distance),
          "motion.competitor.position.x": channel("motion.competitor.position.x", index * 10),
          "motion.competitor.position.z": channel("motion.competitor.position.z", index * 100),
        },
      },
    };
  });
  const opponent = {
    vehicleId: "car", incarnation: "1", endSequence: "-1",
    frames: rows.map(({ captureSequence, competitor }) => ({ captureSequence, competitors: [competitor] })),
  };
  const result = alignLmuOpponentPositionTraces(rows as never, opponent as never, { step: 10 });
  const x = result!.traces.find((trace) => trace.semanticId === "motion.position-x")!;
  expect(x.player[1]!.value).toBe(10);
  expect(x.player[2]!.value).toBeNull();
  expect(x.player[3]!.value).toBe(30);
});

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

function recordedLap(duration: number, distanceAt: (time: number) => number): SpectateLap {
  const result = lap(duration, distanceAt);
  result.replay.envelopes = result.samples.map((sample, index) => {
    const frame = {
      sequence: 1000 + index * 10,
      simulator: "fm-2023" as const,
      observedAt: { domain: "session", milliseconds: sample.time * 1000 },
      receivedAt: { domain: "session", milliseconds: sample.time * 1000 },
      values: Object.entries(sample.values).map(([semanticId, value]) => ({ semanticId, value })),
    };
    sample.frame = frame;
    return frame;
  });
  return result;
}
test("AMS2 vehicle sideslip uses ground-plane motion relative to heading and rejects unavailable spans", () => {
  const source = lap(0.1, time => time);
  source.samples = [0, 0.05, 0.1].map((time, index) => ({
    time, distance: time * 10, run: index === 2 ? 1 : 0,
    values: { "motion.position-x": time * 10, "motion.position-z": 0, "motion.yaw": Math.PI / 2 },
  }));
  source.maximumGapSeconds = 0.1;
  source.replay.envelopes = [{ simulator: "ams2" } as never];
  expect(vehicleSideslipDegrees(source, 0.025)).toBeCloseTo(0);
  source.samples[1]!.values = { ...source.samples[1]!.values, "motion.position-z": -0.5 };
  expect(vehicleSideslipDegrees(source, 0.025)).toBeCloseTo(45);
  source.samples[1]!.values = { ...source.samples[1]!.values, "motion.position-z": 0, "motion.position-x": -0.5 };
  expect(Math.abs(vehicleSideslipDegrees(source, 0.025)!)).toBeCloseTo(180);
  source.samples[1]!.values = { ...source.samples[1]!.values, "motion.position-x": 0.01 };
  expect(vehicleSideslipDegrees(source, 0.025)).toBeNull();
  source.samples[1]!.values = { ...source.samples[1]!.values, "motion.position-x": 0.5 };
  source.samples[1]!.values = { ...source.samples[1]!.values, "motion.yaw": null };
  expect(vehicleSideslipDegrees(source, 0.025)).toBeNull();
  expect(vehicleSideslipDegrees(source, 0.075)).toBeNull();
  expect(vehicleSideslipDegrees(source, 0.2)).toBeNull();
});
test("AMS2 Polo geometry approximation is limited to its identity and yields to exact dimensions", () => {
  expect(resolveWheelSlipGeometry("ams2", "325487790", undefined)).toEqual({ model: AMS2_POLO_APPROXIMATE_GEOMETRY, estimated: true });
  expect(AMS2_POLO_APPROXIMATE_GEOMETRY).toEqual({ halfWheelbase: 1.276, halfFrontTrack: 0.75, halfRearTrack: 0.7415 });
  expect(AMS2_POLO_GEOMETRY_DISCLOSURE).toContain("road-going Volkswagen Polo proxy");
  expect(AMS2_POLO_GEOMETRY_DISCLOSURE).toContain("Not verified for AMS2 TSI Cup or game physics");
  const exact = { halfWheelbase: 1.2, halfFrontTrack: 0.7, halfRearTrack: 0.69 };
  expect(resolveWheelSlipGeometry("ams2", "325487790", exact)).toEqual({ model: exact, estimated: false });
  expect(resolveWheelSlipGeometry("ams2", "other", undefined)).toBeUndefined();
  expect(resolveWheelSlipGeometry("fm-2023", "325487790", undefined)).toBeUndefined();
});
test("AMS2 replay estimates per-wheel slip angle from adjacent native wheel paths", () => {
  const geometry = { halfWheelbase: 1.3, halfFrontTrack: 0.8, halfRearTrack: 0.75 };
  const makeLap = (samples: SpectateSample[]) => ({
    ...lap(0.1, time => time * 10),
    samples,
    maximumGapSeconds: 0.1,
    replay: { lapId: 1, requestedSemanticIds: [], envelopes: [{ simulator: "ams2" } as never] },
  });
  const straight = [0, 0.05, 0.1].map((time, index): SpectateSample => ({
    time, distance: time * 10, run: 0,
    values: { "motion.position-x": 0, "motion.position-z": time * 10, "motion.yaw": 0, "motion.speed": 10, "inputs.steer": 0 },
  }));
  expect(estimateWheelSlipAngles(makeLap(straight), 0.05, geometry)).toEqual([0, 0, 0, 0]);
  expect(estimateWheelSlipAngles(makeLap(straight), 0.025, geometry)).toEqual([0, 0, 0, 0]);

  const yawRate = 0.2;
  const turning = [0, 0.05, 0.1].map((time): SpectateSample => ({
    time, distance: time * 10, run: 0,
    values: {
      "motion.position-x": (10 / yawRate) * (1 - Math.cos(yawRate * time)),
      "motion.position-z": (10 / yawRate) * Math.sin(yawRate * time),
      "motion.yaw": yawRate * time, "motion.speed": 10, "inputs.steer": 0,
    },
  }));
  const turningAngles = estimateWheelSlipAngles(makeLap(turning), 0.05, geometry);
  expect(turningAngles[0]).toBeCloseTo(turningAngles[1]!);
  expect(turningAngles[2]).toBeCloseTo(turningAngles[3]!);
  expect(turningAngles[0]).not.toBeCloseTo(turningAngles[2]!);

  const steered = straight.map(sample => ({ ...sample, values: { ...sample.values, "inputs.steer": 40 } }));
  const steeringAdjusted = estimateWheelSlipAngles(makeLap(steered), 0.05, geometry);
  expect(steeringAdjusted[0]).toBeLessThan(0);
  expect(steeringAdjusted[1]).toBeLessThan(0);
  expect(steeringAdjusted[2]).toBeCloseTo(0);
  expect(steeringAdjusted[3]).toBeCloseTo(0);

  const missing = straight.map(sample => ({ ...sample, values: { ...sample.values, "motion.position-x": null } }));
  expect(estimateWheelSlipAngles(makeLap(missing), 0.05, geometry)).toEqual([null, null, null, null]);
  const missingSteering = straight.map(sample => ({ ...sample, values: { ...sample.values, "inputs.steer": null } }));
  expect(estimateWheelSlipAngles(makeLap(missingSteering), 0.05, geometry)).toEqual([null, null, null, null]);
  const gap = straight.map((sample, index) => ({ ...sample, time: index === 2 ? 0.5 : sample.time }));
  expect(estimateWheelSlipAngles(makeLap(gap), 0.5, geometry)).toEqual([null, null, null, null]);
  const boundary = straight.map((sample, index) => ({ ...sample, run: index === 2 ? 1 : 0 }));
  expect(estimateWheelSlipAngles(makeLap(boundary), 0.1, geometry)).toEqual([null, null, null, null]);
  const slow = straight.map(sample => ({ ...sample, values: { ...sample.values, "motion.speed": 0.5 } }));
  expect(estimateWheelSlipAngles(makeLap(slow), 0.05, geometry)).toEqual([null, null, null, null]);
  expect(estimateWheelSlipAngles(makeLap(straight), Number.NaN, geometry)).toEqual([null, null, null, null]);
  expect(estimateWheelSlipAngles(makeLap(straight), 0.05, { ...geometry, halfWheelbase: 0 })).toEqual([null, null, null, null]);
});
test("replay holds native aid activation until its next sample and rejects stale activity", () => {
  const replay = recordedLap(0.15, time => time * 20).replay;
  replay.envelopes.forEach((frame, index) => {
    frame.values.push(
      { semanticId: "electronics.tc-active", value: index === 0 },
      { semanticId: "electronics.abs-active", value: index === 1, freshness: index === 2 ? "stale" : "fresh" },
    );
  });
  const controller = createSpectateController(prepareSpectateLap(replay), null);
  try {
    expect(controller.sample(0.025).a?.values["electronics.tc-active"]).toBe(true);
    expect(controller.sample(0.025).a?.values["electronics.abs-active"]).toBe(false);
    expect(controller.sample(0.05).a?.values["electronics.tc-active"]).toBe(false);
    expect(controller.sample(0.075).a?.values["electronics.abs-active"]).toBe(true);
    expect(controller.sample(0.1).a?.values["electronics.abs-active"]).toBeNull();
    expect(controller.sample(0.125).a?.values["electronics.abs-active"]).toBeNull();
    expect(controller.sample(0.2).a?.values["electronics.tc-active"]).toBeUndefined();
  } finally { controller.dispose(); }
});
test("single replay uses native progress and frame seeks without a comparison lap", () => {
  const replay = recordedLap(1, (time) => time * 20).replay;
  replay.envelopes.forEach((frame, index) => {
    frame.values.push(
      { semanticId: "timing.current-lap", value: 12 + index / 20 },
      { semanticId: "timing.distance-traveled", value: 500 + index },
      { semanticId: "inputs.throttle", value: index === 0 ? 0 : 0.5 },
    );
  });
  const prepared = prepareSpectateLap(replay);
  expect(prepared.hasProgress).toBe(true);
  expect(prepared.samples[0]!.distance).toBe(0);
  expect(prepared.samples[0]!.values["inputs.throttle"]).toBe(0);
  const controller = createSpectateController(prepared, null);
  try {
    expect(controller.getSnapshot().canLock).toBe(false);
    controller.setPositionLock(true);
    expect(controller.getSnapshot().positionLock).toBe(false);
    controller.seekFrame("a", 10);
    expect(controller.getSnapshot().time).toBeCloseTo(0.5);
    expect(controller.getSnapshot().a?.distance).toBe(10);
    expect(controller.getSnapshot().b).toBeNull();
    controller.seekFrame("b", 10);
    expect(controller.getSnapshot().time).toBeCloseTo(0.5);
    expect(controller.sample(0.5).b).toBeNull();
  } finally { controller.dispose(); }
});

test("opponent replay keeps native partial-lap distance and never aligns uncovered progress", () => {
  const player = recordedLap(1, (time) => 500 + time * 20).replay;
  const opponentFrames = recordedLap(1, (time) => 510 + time * 20).replay.envelopes;
  for (const [frames, start] of [[player.envelopes, 500], [opponentFrames, 510]] as const) {
    frames.forEach((frame, index) => {
      frame.simulator = "lmu";
      frame.values = frame.values.filter((value) => value.semanticId.startsWith("motion."));
      frame.values.push(
        { semanticId: "timing.current-lap", value: 42 + index / 20 },
        { semanticId: "timing.distance-traveled", value: start + index },
      );
    });
  }
  const opponent: OpponentSemanticLapTelemetry = {
    opponentLapId: "opaque-native-lap",
    sourceRevision: "capture-revision",
    requestedSemanticIds: ["motion.position-x", "motion.position-z", "motion.yaw", "timing.current-lap", "timing.distance-traveled"],
    envelopes: opponentFrames,
  };
  const a = prepareSpectateLap(player, undefined, "a", { preserveLapDistance: true });
  const b = prepareSpectateLap(opponent, undefined, "b", { preserveLapDistance: true });
  const controller = createSpectateController(a, b);
  try {
    expect(controller.getSnapshot().positionLock).toBe(true);
    expect(controller.sample(0).b).toBeNull();
    expect(controller.sample(0.75).a?.distance).toBe(515);
    expect(controller.sample(0.75).b?.distance).toBe(515);
    expect(controller.sample(0.75).b?.pose?.x).toBe(515);
    expect(controller.sample(0.75).b?.values["inputs.gear"]).toBeUndefined();
  } finally { controller.dispose(); }
});
test("opponent render pose omits native height while source values remain intact", () => {
  const playerReplay = recordedLap(0.1, (time) => time * 20).replay;
  const opponentFrames = recordedLap(0.1, (time) => time * 20).replay.envelopes;
  for (const [index, frame] of opponentFrames.entries()) {
    frame.simulator = "lmu";
    frame.sequence = index + 1;
    frame.values = [
      { semanticId: "motion.position-x", value: index },
      { semanticId: "motion.position-y", value: 2 + index * 3 },
      { semanticId: "motion.position-z", value: index * 2 },
      { semanticId: "motion.yaw", value: 0.5 },
    ];
  }
  const opponent: OpponentSemanticLapTelemetry = {
    opponentLapId: "native-height",
    sourceRevision: "source-revision",
    requestedSemanticIds: ["motion.position-x", "motion.position-y", "motion.position-z", "motion.yaw"],
    envelopes: opponentFrames,
  };
  const playerFrames = playerReplay.envelopes;
  playerFrames.forEach((frame, index) => {
    frame.values = [
      { semanticId: "motion.position-x", value: index },
      { semanticId: "motion.position-y", value: 2 + index * 3 },
      { semanticId: "motion.position-z", value: index * 2 },
      { semanticId: "motion.yaw", value: 0.5 },
    ];
  });
  const player = prepareSpectateLap(playerReplay);
  const preparedOpponent = prepareSpectateLap(opponent);
  const controller = createSpectateController(player, preparedOpponent);
  try {
    expect(controller.sample(0).b?.pose?.y).toBe(0);
    expect(controller.sample(0).b?.values["motion.position-y"]).toBe(2);
    expect(controller.sample(0.025).b?.pose?.y).toBe(0);
    expect(controller.sample(0.025).b?.values["motion.position-y"]).toBeCloseTo(3.5);
    expect(opponent.envelopes.map((frame) => frame.values.find((value) => value.semanticId === "motion.position-y")?.value))
      .toEqual([2, 5, 8]);
    expect(controller.sample(0).a?.pose?.y).toBe(2);
    expect(controller.sample(0.025).a?.pose?.y).toBeCloseTo(3.5);
  } finally { controller.dispose(); }
});
test("opponent partial interval uses observed time, exact source frames, and preserves gaps", () => {
  const envelopes = recordedLap(5.4, (time) => time * 20).replay.envelopes.slice(0, 28);
  envelopes.forEach((frame, index) => {
    frame.simulator = "lmu";
    frame.sequence = index + 1;
    frame.observedAt = { domain: "session", milliseconds: 100_000 + index * 200 };
    frame.values = [
      { semanticId: "timing.current-lap", value: 3152 + index * 0.2 },
      { semanticId: "motion.position-x", value: index },
      { semanticId: "motion.position-y", value: 1 },
      { semanticId: "motion.position-z", value: index * 2 },
      { semanticId: "motion.yaw", value: 0.5 },
      { semanticId: "motion.speed", value: 40 + index },
    ];
  });
  const opponent: OpponentSemanticLapTelemetry = {
    opponentLapId: "partial-source-interval",
    sourceRevision: "source-revision",
    requestedSemanticIds: ["motion.position-x", "motion.position-y", "motion.position-z", "motion.yaw", "motion.speed"],
    envelopes,
  };
  const prepared = prepareSpectateLap(opponent);
  expect(prepared.duration).toBeCloseTo(5.4);
  expect(prepared.samples[0]!.time).toBe(0);
  expect(prepared.samples[0]!.values["timing.current-lap"]).toBe(3152);
  const controller = createSpectateController(prepared, null);
  try {
    expect(controller.getSnapshot().a?.pose).toEqual({ x: 0, y: 0, z: 0, yaw: 0.5 });
    expect(controller.getSnapshot().a?.values["motion.speed"]).toBe(40);
    expect(controller.getSnapshot().a?.values["inputs.throttle"]).toBeUndefined();
    expect(controller.sample(0.1).a?.pose?.x).toBeCloseTo(0.5);
    expect(controller.sample(0.1).a?.values["motion.speed"]).toBeCloseTo(40.5);
    expect(controller.sample(0.2).a?.pose?.x).toBeCloseTo(1);
    controller.seekFrame("a", 7);
    expect(controller.getSnapshot().time).toBeCloseTo(1.4);
    expect(controller.getSnapshot().a?.pose).toEqual({ x: 7, y: 0, z: 14, yaw: 0.5 });
    expect(controller.getSnapshot().a?.values["motion.speed"]).toBe(47);
    controller.scrub(2.2);
    expect(controller.getSnapshot().a?.pose).toEqual({ x: 11, y: 0, z: 22, yaw: 0.5 });
  } finally { controller.dispose(); }
  const gappedFrames = envelopes.map((frame, index) => ({
    ...frame,
    sequence: index < 2 ? index + 1 : index + 3,
    observedAt: { domain: "session" as const, milliseconds: 100_000 + (index < 2 ? index * 200 : 600 + (index - 2) * 200) },
    values: frame.values.map((value) => value.semanticId === "timing.current-lap" && index >= 2
      ? { ...value, value: 3152 + 0.6 + (index - 2) * 0.2 }
      : value),
  }));
  const gapped = prepareSpectateLap({ ...opponent, envelopes: gappedFrames });
  const sequenceHole = envelopes.slice(0, 3).map((frame, index) => ({
    ...frame,
    sequence: index === 2 ? 4 : index + 1,
    observedAt: { domain: "session" as const, milliseconds: 100_000 + index * 200 },
  }));
  const sequenceGap = prepareSpectateLap({ ...opponent, envelopes: sequenceHole });
  expect(sequenceGap.samples[1]!.time).toBeCloseTo(0.2);
  expect(sequenceGap.samples[2]!.time).toBeCloseTo(0.4);
  expect(sequenceGap.samples[1]!.run).not.toBe(sequenceGap.samples[2]!.run);
  expect(gapped.samples[1]!.run).not.toBe(gapped.samples[2]!.run);
  const player = prepareSpectateLap({ lapId: 1, requestedSemanticIds: [], envelopes: gappedFrames });
  expect(player.samples[1]!.run).not.toBe(player.samples[2]!.run);
});

test("opponent segment seeks interpolate native scoring cadence but never cross missing observations", () => {
  const replay: OpponentSemanticLapTelemetry = {
    opponentLapId: "native-scoring-distance",
    sourceRevision: "source-revision",
    requestedSemanticIds: ["timing.distance-traveled"],
    envelopes: [0, 1, 2, 4].map((index) => ({
      sequence: index + 1,
      simulator: "lmu",
      observedAt: { domain: "session", milliseconds: 100_000 + index * 200 },
      receivedAt: { domain: "session", milliseconds: 100_000 + index * 200 },
      values: [{ semanticId: "timing.distance-traveled", value: 2000 + index * 10 }],
    })),
  };
  const controller = createSpectateController(prepareSpectateLap(replay), null);
  try {
    controller.seekDistance(5, true);
    expect(controller.getSnapshot().time).toBeCloseTo(0.1);
    controller.seekDistance(30, true);
    expect(controller.getSnapshot().time).toBeCloseTo(0.1);
    controller.seekDistance(40, true);
    expect(controller.getSnapshot().time).toBeCloseTo(0.8);
  } finally { controller.dispose(); }
});
test("seekGeneration changes only for explicit time discontinuities", () => {
  const controller = createSpectateController(recordedLap(1, time => time * 20), null);
  try {
    const initial = controller.getSnapshot().seekGeneration;
    const generation = controller.getSnapshot().generation;
    controller.setSpeed(2);
    controller.setPositionLock(true);
    expect(controller.getSnapshot().generation).toBeGreaterThan(generation);
    expect(controller.getSnapshot().seekGeneration).toBe(initial);
    controller.seekFrame("a", 10);
    expect(controller.getSnapshot().seekGeneration).toBe(initial + 1);
    controller.scrub(0.25);
    expect(controller.getSnapshot().seekGeneration).toBe(initial + 2);
    controller.seekDistance(20);
    expect(controller.getSnapshot().seekGeneration).toBe(initial + 3);
    controller.seekDistance(21);
    controller.seekFrame("a", -1);
    expect(controller.getSnapshot().seekGeneration).toBe(initial + 3);
  } finally { controller.dispose(); }
});

test("single replay preserves gaps and supports seeking without native distance", () => {
  const replay = recordedLap(1, (time) => time * 20).replay;
  replay.envelopes = replay.envelopes.filter((_, index) => index < 4 || index > 12);
  const prepared = prepareSpectateLap(replay);
  expect(prepared.hasProgress).toBe(false);
  const controller = createSpectateController(prepared, null);
  try {
    expect(controller.sample(0.4, false).a).toBeNull();
    controller.seekFrame("a", 5);
    expect(controller.getSnapshot().a?.pose?.x).toBeCloseTo(14);
    expect(controller.getSnapshot().a?.distance).toBeNull();
  } finally { controller.dispose(); }
});


test("native insight indices seek either lap without confusing aligned or sequence indices", () => {
  const a = recordedLap(1, (time) => time * 100);
  const b = recordedLap(2, (time) => time * 50);
  const controller = createSpectateController(a, b);
  try {
    controller.seekFrame("b", 20);
    expect(controller.getSnapshot().positionLock).toBe(true);
    expect(controller.getSnapshot().time).toBeCloseTo(0.5);
    expect(controller.getSnapshot().b?.time).toBeCloseTo(1);
    controller.seekFrame("a", 5);
    expect(controller.getSnapshot().a?.time).toBeCloseTo(0.25);
    controller.setPositionLock(false);
    controller.seekFrame("b", 20);
    expect(controller.getSnapshot().time).toBeCloseTo(1);
    expect(controller.getSnapshot().b?.pose?.x).toBeCloseTo(50);
  } finally { controller.dispose(); }
});

test("B insight events on a plateau or outside A coverage fall back to native time", () => {
  const a = recordedLap(1, (time) => time * 100);
  for (const b of [
    recordedLap(2, (time) => time <= 0.5 ? time * 100 : time <= 1.5 ? 50 : 50 + (time - 1.5) * 100),
    recordedLap(2, (time) => time * 200),
  ]) {
    const controller = createSpectateController(a, b);
    try {
      controller.seekFrame("b", 20);
      expect(controller.getSnapshot().positionLock).toBe(false);
      expect(controller.getSnapshot().b?.time).toBeCloseTo(1);
    } finally { controller.dispose(); }
  }
});

test("insight seek handles coalesced ticks, excluded tails, and invalid indices", () => {
  const a = recordedLap(1, (time) => time * 100);
  a.samples[5]!.time = a.samples[4]!.time;
  a.samples = a.samples.filter((_, index) => index !== 4 && index !== 20);
  const controller = createSpectateController(a, a);
  try {
    controller.seekFrame("a", 4);
    expect(controller.getSnapshot().time).toBeCloseTo(0.2);
    controller.seekFrame("a", 20);
    expect(controller.getSnapshot().time).toBeCloseTo(0.95);
    controller.seekFrame("a", -1);
    controller.seekFrame("a", 100);
    expect(controller.getSnapshot().time).toBeCloseTo(0.95);
  } finally { controller.dispose(); }
});

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
  test("omits raw, derived, wear, and delta charts when source samples have no usable values", () => {
    const a = lap(1, (time) => time * 100),
      b = lap(1, (time) => time * 100);
    for (const recording of [a, b]) recording.samples = recording.samples.map((sample) => ({ ...sample, values: {} }));
    const pair: SpectatePair = {
      gameId: "fm-2023",
      a,
      b,
      comparison: { traces: { distance: [] }, timeDelta: [] } as unknown as ComparisonData,
    };
    expect(buildSpectateChannels(pair)).toEqual([]);
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

describe("iRacing Spectate scene geometry", () => {
  const projection = {
    points: [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 100, z: 100 }, { x: 100, z: 0 }, { x: 0, z: 0 }],
    source: "official-svg" as const, units: "m" as const, start: "start-finish" as const, direction: "forward" as const,
  };
  const comparison = { traces: { distance: [0, 10, 20], elapsedTimeA: [0, 0.05, 0.1], elapsedTimeB: [0, 0.05, 0.1] } } as unknown as ComparisonData;
  const recording = (rows: Record<string, unknown>[], stale?: string): SemanticLapTelemetry => ({
    lapId: 1, requestedSemanticIds: [],
    envelopes: rows.map((row, index) => ({
      sequence: index, simulator: "iracing",
      observedAt: { domain: "session", milliseconds: index * 50 },
      receivedAt: { domain: "session", milliseconds: index * 50 },
      values: Object.entries({ "timing.current-lap": index * 0.05, ...row }).map(([semanticId, value]) => ({
        semanticId, value, state: "ok", freshness: index === 1 && semanticId === stale ? "stale" : "fresh",
      })),
    })),
  });
  test("projects valid progress and interpolates scene pose without creating native positions", () => {
    const replay = recording([0, 0.125, 0.25].map((fraction) => ({ "timing.lap-fraction": fraction, "motion.yaw": -2 })));
    const native = prepareSpectateLap(replay, comparison, "a");
    const [a, b] = placeIRacingSpectateLaps([native, native], projection);
    expect(sampleLap(a, 0.025, false)?.pose).toEqual({ x: 0, y: 0, z: 25, yaw: 0 });
    expect(sampleLap(b, 0.05, false)?.pose).toMatchObject({ x: 0, y: 0, z: 50, yaw: 0 });
    expect(a.samples[1].values["motion.position-x"]).toBeUndefined();
    expect(a.samples[1].values["motion.yaw"]).toBe(-2);
    expect(native.samples[1].scenePose).toBeUndefined();
    const [missing] = placeIRacingSpectateLaps([native, native], null);
    expect(sampleLap(missing, 0.05, false)?.pose).toBeNull();
    const stale = prepareSpectateLap(recording([0, 0.125, 0.25].map((fraction) => ({ "timing.lap-fraction": fraction })), "timing.lap-fraction"), comparison, "a");
    const [gapped] = placeIRacingSpectateLaps([stale, stale], projection);
    expect(sampleLap(gapped, 0.025, false)?.pose).toBeNull();
    expect(sampleLap(gapped, 0.05, false)?.pose).toBeNull();
    expect(sampleLap(gapped, 0.1, false)?.pose?.z).toBe(100);
  });
  test("measured laps share one origin and missing GPS never snaps onto the reference", () => {
    const row = (latitude: number) => ({ "motion.latitude": latitude, "motion.longitude": -2, "motion.yaw-north": 0.4, "timing.lap-fraction": 0.5 });
    const a = prepareSpectateLap(recording([row(53), row(53.0001), row(53.0002)]), comparison, "a");
    const b = prepareSpectateLap(recording([row(53.0001), { "timing.lap-fraction": 0.5 }, row(53.0003)]), comparison, "b");
    const [placedA, placedB] = placeIRacingSpectateLaps([a, b], projection);
    expect(sampleLap(placedA, 0, false)?.pose).toMatchObject({ x: 0, y: 0, z: 0, yaw: -0.4 });
    expect(sampleLap(placedB, 0, false)?.pose?.z).toBeCloseTo(11.132, 2);
    expect(sampleLap(placedB, 0.05, false)?.pose).toBeNull();
    expect(sampleLap(placedB, 0.025, false)?.pose).toBeNull();
    expect(sampleLap(placedB, 0.1, false)?.pose?.z).toBeCloseTo(33.396, 2);
  });
  test("places a live-only comparison lap in the measured lap's reference frame", () => {
    const radians = Math.PI / 180;
    const measuredRows = projection.points.map((point) => ({
      "motion.latitude": 53 + point.z / (radians * 6_378_137),
      "motion.longitude": -2 + point.x / (radians * 6_378_137 * Math.cos(53 * radians)),
      "motion.yaw-north": 0,
    }));
    const measured = prepareSpectateLap(recording(measuredRows), comparison, "a");
    const live = prepareSpectateLap(recording([0, 0.125, 0.25].map((fraction) => ({ "timing.lap-fraction": fraction }))), comparison, "b");
    const [a, b] = placeIRacingSpectateLaps([measured, live], projection);
    expect(a.samples[1].scenePose).toMatchObject({ source: "measured", x: 0, z: expect.closeTo(100, 3) });
    expect(sampleLap(b, 0.05, false)?.pose).toMatchObject({ source: "lap-fraction", x: expect.closeTo(0, 3), z: expect.closeTo(50, 3) });
    expect(b.samples[1].values["motion.position-x"]).toBeUndefined();
    expect(measured.samples[1].scenePose).toBeUndefined();
  });
  test("matches replay map handedness and keeps projected cars facing forward through a turn", () => {
    const replay = recording([0.25, 0.375, 0.5].map((fraction) => ({ "timing.lap-fraction": fraction })));
    const native = prepareSpectateLap(replay, comparison, "a");
    const [placed] = placeIRacingSpectateLaps([native, native], projection);
    const start = sampleLap(placed, 0, false)!.pose!;
    const middle = sampleLap(placed, 0.05, false)!.pose!;
    const end = sampleLap(placed, 0.1, false)!.pose!;
    // Replay draws maxX - x: increasing source X must move left on both maps.
    expect(middle.x).toBe(-50);
    expect(middle.z).toBe(100);
    expect(end.x).toBe(-100);
    expect(Math.sin(middle.yaw)).toBeCloseTo(-1);
    const dx = end.x - start.x, dz = end.z - start.z;
    expect((Math.sin(middle.yaw) * dx + Math.cos(middle.yaw) * dz) / Math.hypot(dx, dz)).toBeCloseTo(1);
    expect(native.samples[1].scenePose).toBeUndefined();
    expect(placed.samples[1].values["motion.position-x"]).toBeUndefined();
  });
});

function reducedRateReplay(simulator: "ams2" | "fm-2023" = "ams2"): SemanticLapTelemetry {
  const replay = recordedLap(1.2, time => time * 20).replay;
  let milliseconds = 0;
  replay.envelopes = replay.envelopes.map((frame, index) => {
    if (index) milliseconds += [106, 110, 107, 109][index % 4]!;
    return {
      ...frame, simulator,
      observedAt: { domain: "session", milliseconds },
      values: [...frame.values, { semanticId: "motion.speed", value: 50 + index }, { semanticId: "timing.distance-traveled", value: index * 10 }],
    };
  });
  return replay;
}

test("reduced-rate AMS2 replays interpolate normal recorded jitter in single and locked comparison playback", () => {
  const replay = reducedRateReplay();
  const a = prepareSpectateLap(replay);
  const controller = createSpectateController(a, prepareSpectateLap(replay));
  try {
    expect(controller.getSnapshot().canLock).toBe(true);
    for (let index = 1; index < a.samples.length; index++) {
      const time = (a.samples[index - 1]!.time + a.samples[index]!.time) / 2;
      const reading = controller.sample(time);
      expect(reading.a?.pose).not.toBeNull();
      expect(reading.a?.values["motion.speed"]).toBeCloseTo(49.5 + index);
      expect(reading.b?.pose).not.toBeNull();
    }
  } finally { controller.dispose(); }
});

test("reduced-rate AMS2 replays keep a missing recorded tick blank", () => {
  const replay = reducedRateReplay();
  const before = replay.envelopes[9]!.observedAt.milliseconds / 1000;
  const after = replay.envelopes[11]!.observedAt.milliseconds / 1000;
  replay.envelopes.splice(10, 1);
  const controller = createSpectateController(prepareSpectateLap(replay), null);
  try {
    expect(controller.sample((before + after) / 2).a).toBeNull();
    expect(controller.sample(before).a?.pose).not.toBeNull();
    expect(controller.sample(after).a?.pose).not.toBeNull();
  } finally { controller.dispose(); }
});

test("reduced-rate AMS2 cadence does not loosen gap handling for other simulators", () => {
  const a = prepareSpectateLap(reducedRateReplay("fm-2023"));
  const controller = createSpectateController(a, null);
  try { expect(controller.sample((a.samples[0]!.time + a.samples[1]!.time) / 2).a).toBeNull(); }
  finally { controller.dispose(); }
});
