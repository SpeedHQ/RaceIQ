import { afterEach, describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, ManagedRuntime, Ref } from "effect";
import { TestClock } from "effect/testing";
import { sessionMaintenanceSchedule } from "@raceiq/backend-core/session-capture/compressor";
import {
  admitMaintenance,
  disposeRecordingMaintenanceRuntime,
  emptySessionDownsampleStatus,
  getRecordingMaintenanceController,
  releaseMaintenance,
  trackMaintenanceFiber,
} from "@raceiq/backend-core/session-capture/maintenance-runtime";
import { getRecordingStorageActivity, reserveRecordingStorageOperation } from "@raceiq/backend-core/session-capture/storage-activity";
const activeFibers: Array<{ runtime: ManagedRuntime.ManagedRuntime<never, never>; fiber: Fiber.Fiber<unknown, unknown> }> = [];

afterEach(async () => {
  for (const { runtime, fiber } of activeFibers.splice(0)) {
    await runtime.runPromise(Effect.ignore(Fiber.interrupt(fiber)));
    await runtime.runPromise(runtime.disposeEffect);
  }
  await disposeRecordingMaintenanceRuntime();
});

describe("recording maintenance lifecycle", () => {
  test("starts immediately, spaces after completion, never overlaps, and recovers after a failed pass", async () => {
    const runtime = ManagedRuntime.make(TestClock.layer());
    const firstStarted = await runtime.runPromise(Deferred.make<void>());
    const blockedStarted = await runtime.runPromise(Deferred.make<void>());
    const releaseBlocked = await runtime.runPromise(Deferred.make<void>());
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const pass = Effect.suspend(() => {
      calls++;
      if (calls === 1) return Deferred.succeed(firstStarted, undefined);
      if (calls === 2) {
        active++;
        maximumActive = Math.max(maximumActive, active);
        return Deferred.succeed(blockedStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseBlocked)),
          Effect.ensuring(
            Effect.sync(() => {
              active--;
            }),
          ),
        );
      }
      if (calls === 3) return Effect.fail(new Error("recoverable pass failure"));
      return Effect.void;
    });
    const fiber = runtime.runFork(sessionMaintenanceSchedule(pass));
    activeFibers.push({ runtime, fiber });
    await runtime.runPromise(Deferred.await(firstStarted));
    expect(calls).toBe(1);
    await runtime.runPromise(TestClock.adjust("4 minutes"));
    expect(calls).toBe(1);
    await runtime.runPromise(TestClock.adjust("1 minute"));
    await runtime.runPromise(Deferred.await(blockedStarted));
    expect(calls).toBe(2);
    await runtime.runPromise(TestClock.adjust("20 minutes"));
    expect(calls).toBe(2);
    expect(maximumActive).toBe(1);
    await runtime.runPromise(Deferred.succeed(releaseBlocked, undefined));
    await runtime.runPromise(TestClock.adjust("4 minutes"));
    expect(calls).toBe(2);
    await runtime.runPromise(TestClock.adjust("1 minute"));
    expect(calls).toBe(3);
    await runtime.runPromise(TestClock.adjust("5 minutes"));
    expect(calls).toBe(4);
    expect(maximumActive).toBe(1);
  });

  test("admits only one maintenance owner and leaves the existing owner unchanged on rejection", async () => {
    const runtime = getRecordingMaintenanceController();
    expect(await runtime.managed.runPromise(admitMaintenance(runtime, "downsample"))).toBe(true);
    const runningStatus = { ...emptySessionDownsampleStatus(), status: "running" as const };
    await runtime.managed.runPromise(Ref.set(runtime.status, runningStatus));
    expect(await runtime.managed.runPromise(admitMaintenance(runtime, "maintenance"))).toBe(false);
    expect(await runtime.managed.runPromise(Ref.get(runtime.state))).toBe("downsample");
    expect(await runtime.managed.runPromise(Ref.get(runtime.status))).toEqual(runningStatus);
    await runtime.managed.runPromise(releaseMaintenance(runtime));
    expect(await runtime.managed.runPromise(admitMaintenance(runtime, "maintenance"))).toBe(true);
    await runtime.managed.runPromise(releaseMaintenance(runtime));
  });
  test("disposes idempotently and creates a fresh runtime after stop", async () => {
    const first = getRecordingMaintenanceController();
    const stopping = disposeRecordingMaintenanceRuntime();
    expect(disposeRecordingMaintenanceRuntime()).toBe(stopping);
    await stopping;
    const restarted = getRecordingMaintenanceController();
    expect(restarted).not.toBe(first);
  });
  test("shutdown waits for non-cancellable locked work and retains its storage reservation", async () => {
    const runtime = getRecordingMaintenanceController();
    const started = await runtime.managed.runPromise(Deferred.make<void>());
    let finish!: () => void;
    const pendingIO = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const worker = runtime.managed.runFork(
      Effect.acquireUseRelease(
        Effect.sync(() => reserveRecordingStorageOperation("downsample")),
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Effect.uninterruptible(Effect.promise(() => pendingIO));
          }),
        (release) => Effect.sync(release),
      ),
    );
    trackMaintenanceFiber(runtime, worker);
    await runtime.managed.runPromise(Deferred.await(started));
    const stopping = disposeRecordingMaintenanceRuntime();
    await runtime.managed.runPromise(Effect.yieldNow);
    expect(getRecordingStorageActivity().relocating).toBe(true);
    finish();
    await stopping;
    expect(getRecordingStorageActivity().relocating).toBe(false);
  });
});
