import { Effect, Fiber, Layer, ManagedRuntime, Ref, Schema } from "effect";
import type { SessionDownsampleStatus } from "@raceiq/shared/racing/sessions/downsample";

export type RecordingMaintenanceState = "idle" | "maintenance" | "downsample" | "stopping";

export class RecordingMaintenanceBusyError extends Schema.TaggedError<RecordingMaintenanceBusyError>()("RecordingMaintenanceBusyError", {
  code: Schema.Literals(["IMPORT_ACTIVE", "MOVE_ACTIVE"]),
  message: Schema.String,
}) {}

export class RecordingMaintenanceValidationError extends Schema.TaggedError<RecordingMaintenanceValidationError>()("RecordingMaintenanceValidationError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class RecordingMaintenanceIOError extends Schema.TaggedError<RecordingMaintenanceIOError>()("RecordingMaintenanceIOError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const emptySessionDownsampleStatus = (): SessionDownsampleStatus => ({
  status: "idle",
  request: null,
  done: 0,
  total: 0,
  convertedFiles: 0,
  freedBytes: 0,
  skipped: [],
  failed: [],
  error: null,
});

export interface RecordingMaintenanceController {
  readonly managed: ManagedRuntime.ManagedRuntime<never, never>;
  readonly state: Ref.Ref<RecordingMaintenanceState>;
  readonly status: Ref.Ref<SessionDownsampleStatus>;
  readonly fibers: Set<Fiber.Fiber<unknown, unknown>>;
}

let controller: RecordingMaintenanceController | null = null;
let disposal: Promise<void> | null = null;

function createController(): RecordingMaintenanceController {
  const managed = ManagedRuntime.make(Layer.empty);
  return {
    managed,
    state: managed.runSync(Ref.make<RecordingMaintenanceState>("idle")),
    status: managed.runSync(Ref.make(emptySessionDownsampleStatus())),
    fibers: new Set(),
  };
}

export function getRecordingMaintenanceRuntime(): ManagedRuntime.ManagedRuntime<never, never> {
  if (disposal) throw new RecordingMaintenanceBusyError({ code: "MOVE_ACTIVE", message: "Recording maintenance is stopping" });
  controller ??= createController();
  return controller.managed;
}

export function getRecordingMaintenanceController(): RecordingMaintenanceController {
  getRecordingMaintenanceRuntime();
  return controller!;
}

export function trackMaintenanceFiber<A, E>(runtime: RecordingMaintenanceController, fiber: Fiber.Fiber<A, E>): Fiber.Fiber<A, E> {
  const tracked = fiber as Fiber.Fiber<unknown, unknown>;
  runtime.fibers.add(tracked);
  fiber.addObserver(() => runtime.fibers.delete(tracked));
  return fiber;
}

export function disposeRecordingMaintenanceRuntime(): Promise<void> {
  if (disposal) return disposal;
  const runtime = controller;
  if (!runtime) return Promise.resolve();
  disposal = (async () => {
    try {
      await runtime.managed.runPromise(Ref.set(runtime.state, "stopping"));
      const fibers = [...runtime.fibers];
      if (fibers.length > 0) {
        await runtime.managed.runPromise(Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber), { concurrency: "unbounded", discard: true }));
      }
      const remaining = [...runtime.fibers];
      if (remaining.length > 0) {
        await runtime.managed.runPromise(Effect.forEach(remaining, (fiber) => Fiber.await(fiber), { concurrency: "unbounded", discard: true }));
      }
      await runtime.managed.runPromise(runtime.managed.disposeEffect);
      if (controller === runtime) controller = null;
    } finally {
      disposal = null;
    }
  })();
  return disposal;
}

export function admitMaintenance(runtime: RecordingMaintenanceController, kind: Exclude<RecordingMaintenanceState, "stopping">): Effect.Effect<boolean> {
  return Ref.modify(runtime.state, (current) => {
    if (current !== "idle") return [false, current] as const;
    return [true, kind] as const;
  });
}

export function releaseMaintenance(runtime: RecordingMaintenanceController): Effect.Effect<void> {
  return Ref.update(runtime.state, (current) => (current === "stopping" ? "stopping" : "idle"));
}
