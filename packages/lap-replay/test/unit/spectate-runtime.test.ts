import { expect, test } from "bun:test";
import { SpectateSceneRuntime, wheelHistoryDiscontinuity, wheelLabelsNeedRefresh } from "../../ui/SpectateSceneRuntime";
import type { SpectateSnapshot } from "../../contracts/spectate";

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
