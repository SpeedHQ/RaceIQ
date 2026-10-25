import { expect, test } from "bun:test";
import { SpectateSceneRuntime, estimatedRaceLineSegments, translateEstimatedRaceLineToScene, wheelHistoryDiscontinuity, wheelLabelsNeedRefresh } from "../../ui/SpectateSceneRuntime";
import type { SpectateSample, SpectateSnapshot } from "../../contracts/spectate";
import { Group, PerspectiveCamera, Scene, Vector3 } from "three";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import type { SpectateReading } from "../../contracts/spectate";
import { createSuspensionSpringResource, disposeSuspensionSpringResource } from "@raceiq/scene-3d/wireframe/SuspensionSpring";

test("replay suspension moves each body with its own lap range and keeps native normalization", () => {
  initGameAdapters();
  const a = new Group(), b = new Group();
  const sample = (raw: number[]) => ({ values: { "suspension.suspension-travel-m": raw } });
  const runtime = Object.assign(Object.create(SpectateSceneRuntime.prototype), {
    pair: { gameId: "ams2", a: { samples: [sample([.10, .10, .10, .10]), sample([.20, .20, .20, .20])] },
      b: { samples: [sample([.30, .30, .30, .30]), sample([.50, .50, .50, .50])] } },
    slots: [a, b].map(root => ({ body: { root }, wheels: [], springs: [], config: { gameId: "ams2", carModel: {} } })),
    groups: [new Group(), new Group()],
    tireInfo: false,
  }) as SpectateSceneRuntime;
  const internals = runtime as unknown as {
    updateWheels(side: number, reading: SpectateReading, elapsed: number, speed: number, playing: boolean, now: number, generation: number): void;
  };
  const update = (side: number, values: Record<string, unknown>) =>
    internals.updateWheels(side, { values, time: 0, distance: 0, pose: null }, 0, 1, false, 0, 0);
  update(0, sample([.10, .10, .10, .10]).values);
  expect(a.position.y).toBeCloseTo(.04);
  update(0, sample([.20, .20, .20, .20]).values);
  expect(a.position.y).toBeCloseTo(-.04);
  update(1, sample([.40, .40, .40, .40]).values);
  expect(b.position.y).toBeCloseTo(0);
  update(0, { ...sample([.20, .20, .20, .20]).values, "suspension.norm-suspension-travel": [.1, .3, .5, .7] });
  expect(a.position.y).toBeCloseTo(.008);
  expect(a.rotation.x).toBeCloseTo(.02);
  expect(a.rotation.z).toBeCloseTo(-.024);
  update(0, sample([.1, NaN, .1, .1]).values);
  expect(a.position.y).toBeCloseTo(0);
  expect(a.rotation.x).toBeCloseTo(0);
  expect(a.rotation.z).toBeCloseTo(0);
});

test("replay springs follow world-space wheel anchors and animate with chassis travel", () => {
  initGameAdapters();
  const scene = new Scene(), group = new Group(), body = new Group();
  group.position.set(10, 2, 20);
  group.rotation.y = Math.PI / 2;
  scene.add(group);
  const camera = new PerspectiveCamera(50, 1, .1, 100);
  camera.position.set(14, 6, 24);
  camera.lookAt(10, 2, 20);
  const springs = Array.from({ length: 4 }, () => createSuspensionSpringResource(scene));
  const raw = (value: number) => ({ "suspension.suspension-travel-m": [value, value, value, value] });
  const runtime = Object.assign(Object.create(SpectateSceneRuntime.prototype), {
    pair: { gameId: "ams2", a: { samples: [{ values: raw(.1) }, { values: raw(.2) }] }, b: null },
    slots: [{ body: { root: body }, wheels: [], springs, config: {
      gameId: "ams2", carModel: { halfWheelbase: 1, halfFrontTrack: .75, halfRearTrack: .75 },
    } }],
    groups: [group], camera, canvas: { clientHeight: 800 },
    springBodyScratch: new Vector3(), springWheelScratch: new Vector3(), tireInfo: false,
  }) as SpectateSceneRuntime;
  const internals = runtime as unknown as {
    updateWheels(side: number, reading: SpectateReading, elapsed: number, speed: number, playing: boolean, now: number, generation: number): void;
  };
  const update = (values: Record<string, unknown>) =>
    internals.updateWheels(0, { values, time: 0, distance: 0, pose: { x: 10, y: 2, z: 20, yaw: 0 } }, 0, 1, false, 0, 0);
  try {
    update(raw(.1));
    expect(springs.every(spring => spring.spring.group.visible && spring.rod.group.visible)).toBe(true);
    const rod = springs[0]!.rod.workRuns[0]!;
    expect(rod[0]!.x).toBeCloseTo(9.6);
    expect(rod[0]!.z).toBeCloseTo(19);
    expect(rod[0]!.y).toBeCloseTo(2.32);
    expect(rod[1]!.y).toBeCloseTo(1.95);
    expect(body.position.y).toBeCloseTo(.04);
    update(raw(.2));
    expect(springs[0]!.rod.workRuns[0]![0]!.y).toBeCloseTo(2.24);
    expect(body.position.y).toBeCloseTo(-.04);
    update({});
    expect(springs.every(spring => !spring.spring.group.visible && !spring.rod.group.visible)).toBe(true);
    expect(body.position.y).toBeCloseTo(0);
    group.visible = false;
    update(raw(.1));
    expect(springs.every(spring => !spring.spring.group.visible && !spring.rod.group.visible)).toBe(true);
  } finally {
    for (const spring of springs) disposeSuspensionSpringResource(spring);
  }
});


test("estimated race-line connectors bridge true gaps up to one second and reject invalid samples", () => {
  const sample = (time: number, x: unknown, z: unknown, run = 0): SpectateSample => ({
    time, run, distance: null, values: { "motion.position-x": x, "motion.position-z": z },
  } as SpectateSample);
  const samples = [
    sample(0, 0, 0),
    sample(1, 1, 1),
    sample(2.0001, 2, 2),
    sample(3, Number.NaN, 3),
    sample(4, 4, Number.POSITIVE_INFINITY),
    sample(4.5, 5, 5),
    sample(4.4, 6, 6),
    sample(5, undefined, 5),
    sample(5.5, undefined, 6),
    sample(6, 6, 6),
  ];
  expect(estimatedRaceLineSegments(samples)).toEqual([0, 0, 0, 1, 0, 1]);
  expect(estimatedRaceLineSegments([sample(0, 0, 0), sample(0.1, 1, 1)])).toEqual([]);
  expect(estimatedRaceLineSegments([sample(0, 0, 0), sample(0.101, 1, 1)])).toEqual([]);
  expect(estimatedRaceLineSegments([sample(0, 0, 0), sample(0.1011, 1, 1)])).toEqual([0, 0, 0, 1, 0, 1]);
  expect(estimatedRaceLineSegments([sample(0, 0, 0), sample(1, 1, 1)])).toEqual([0, 0, 0, 1, 0, 1]);
  expect(estimatedRaceLineSegments([sample(0, 0, 0), sample(1.0001, 1, 1)])).toEqual([]);
  expect(estimatedRaceLineSegments([sample(0, 0, 0), sample(0.2, 1, 1)], true)).toEqual([0, 0, 0, 1, 0, 1]);
  expect(estimatedRaceLineSegments([sample(0, 0, 0), sample(0.4, 1, 1, 1)], true)).toEqual([0, 0, 0, 1, 0, 1]);
  expect(estimatedRaceLineSegments([sample(0, 0, 0), sample(1.0001, 1, 1)], true)).toEqual([]);
});

test("estimated race-line coordinates remain unchanged while translated relative to scene origin", () => {
  const sample = (time: number, x: number, z: number): SpectateSample => ({
    time, run: 0, distance: null, values: { "motion.position-x": x, "motion.position-z": z },
  } as SpectateSample);
  const source = [sample(0, 120, -30), sample(1, 125, -24)];
  const estimated = estimatedRaceLineSegments(source);
  const origin = { x: 100, y: 7, z: -40 };
  translateEstimatedRaceLineToScene(estimated, origin, -origin.y);
  expect(estimated).toEqual([20, -7, 10, 25, -7, 16]);
  expect(source.map(({ values }) => [values["motion.position-x"], values["motion.position-z"]])).toEqual([[120, -30], [125, -24]]);
});
test("wheel history ignores publications but resets for true seek discontinuities", () => {
  expect(wheelHistoryDiscontinuity(2, 2.05, 4, 4)).toBe(false);
  expect(wheelHistoryDiscontinuity(2, 2.05, 4, 5)).toBe(true);
  expect(wheelHistoryDiscontinuity(2, 1.95, 4, 4)).toBe(true);
  expect(wheelHistoryDiscontinuity(2, 3.1, 4, 4)).toBe(true);
});

test("ordinary playback label updates stay capped at 100ms; pause and invalidation refresh immediately", () => {
  expect(wheelLabelsNeedRefresh(true, 99, 0, 4, 4)).toBe(false);
  expect(wheelLabelsNeedRefresh(true, 100, 0, 4, 4)).toBe(true);
  expect(wheelLabelsNeedRefresh(true, 25, 0, 5, 4)).toBe(true);
  expect(wheelLabelsNeedRefresh(false, 25, 0, 4, 4)).toBe(true);
});

test("frame requests queue before initialization and settle only after matching rendered time", async () => {
  const seeks: number[] = [];
  const snapshot = { a: { time: 0 } };
  const runtime = Object.assign(Object.create(SpectateSceneRuntime.prototype), {
    disposed: false,
    initialized: false,
    pendingFrames: [],
    pair: { a: { replay: { envelopes: [{}, {}] } } },
    controller: {
      getSnapshot: () => snapshot,
      seekFrame: (_side: string, index: number) => { seeks.push(index); snapshot.a = { time: index }; },
    },
    wake: () => {},
  }) as SpectateSceneRuntime;
  const internals = runtime as unknown as {
    initialized: boolean;
    startNextFrameRequest(): void;
    settleRenderedFrame(snapshot: Pick<SpectateSnapshot, "a">): void;
  };
  const first = runtime.requestFrame(0);
  const second = runtime.requestFrame(1);
  expect(seeks).toEqual([]);
  internals.initialized = true;
  internals.startNextFrameRequest();
  expect(seeks).toEqual([0]);
  const settle = (frame: number) => internals.settleRenderedFrame({
    a: { time: frame, distance: null, pose: null, values: {} },
  });
  settle(1);
  let firstSettled = false;
  void first.then(() => { firstSettled = true; });
  await Promise.resolve();
  expect(firstSettled).toBe(false);
  settle(0);
  await first;
  expect(seeks).toEqual([0, 1]);
  settle(1);
  await second;
});

test("invalid frame indices reject instead of seeking another frame", async () => {
  const runtime = Object.assign(Object.create(SpectateSceneRuntime.prototype), {
    disposed: false, initialized: false, pendingFrames: [], pair: { a: { replay: { envelopes: [{}] } } },
    controller: { getSnapshot: () => ({ a: null }), seekFrame: () => { throw new Error("unexpected seek"); } },
    wake: () => {},
  }) as SpectateSceneRuntime;
  await expect(runtime.requestFrame(-1)).rejects.toThrow("Replay frame unavailable");
  await expect(runtime.requestFrame(1)).rejects.toThrow("Replay frame unavailable");
});

test("rejecting pending frame queue settles every promise", async () => {
  const runtime = Object.assign(Object.create(SpectateSceneRuntime.prototype), {
    disposed: false, initialized: false, pendingFrames: [], pair: { a: { replay: { envelopes: [{}, {}] } } },
    controller: { getSnapshot: () => ({ a: null }), seekFrame: () => {} }, wake: () => {},
  }) as SpectateSceneRuntime;
  const first = runtime.requestFrame(0);
  const second = runtime.requestFrame(1);
  const internals = runtime as unknown as { rejectPendingFrames(error: Error): void };
  internals.rejectPendingFrames(new Error("Scene runtime disposed"));
  await expect(first).rejects.toThrow("Scene runtime disposed");
  await expect(second).rejects.toThrow("Scene runtime disposed");
});

test("frame requests pause moving snapshots for exact render then restore playback", async () => {
  const snapshot = { a: { time: 0 }, playing: true };
  let playCalls = 0;
  const runtime = Object.assign(Object.create(SpectateSceneRuntime.prototype), {
    disposed: false, initialized: true, pendingFrames: [], resumePlaybackAfterFrames: false,
    pair: { a: { replay: { envelopes: [{}] } } },
    controller: {
      getSnapshot: () => snapshot,
      pause: () => { snapshot.playing = false; },
      play: () => { snapshot.playing = true; playCalls++; },
      seekFrame: () => { snapshot.a = { time: 1 }; },
    },
    wake: () => {},
  }) as SpectateSceneRuntime;
  const requested = runtime.requestFrame(0);
  expect(snapshot.playing).toBe(false);
  const internals = runtime as unknown as { settleRenderedFrame(snapshot: Pick<SpectateSnapshot, "a">): void };
  internals.settleRenderedFrame({ a: { time: 1, distance: null, pose: null, values: {} } });
  await requested;
  expect(playCalls).toBe(1);
  expect(snapshot.playing).toBe(true);
});

test("initialization failure rejects cold queued frame requests", async () => {
  const runtime = Object.assign(Object.create(SpectateSceneRuntime.prototype), {
    disposed: false,
    initialized: false,
    initGeneration: 0,
    pendingFrames: [],
    resumePlaybackAfterFrames: false,
    pair: { a: { replay: { envelopes: [{}] } } },
    renderer: { init: () => Promise.reject(new Error("renderer unavailable")) },
    controller: { getSnapshot: () => ({ a: null }), seekFrame: () => {}, play: () => {} },
    wake: () => {},
    error: () => {},
  }) as SpectateSceneRuntime;
  const requested = runtime.requestFrame(0);
  const internals = runtime as unknown as { initialize(): Promise<void> };
  await internals.initialize();
  await expect(requested).rejects.toThrow("Scene initialization failed");
  await expect(runtime.requestFrame(0)).rejects.toThrow("Scene initialization failed");
});
