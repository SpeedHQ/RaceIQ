import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Queue, Ref } from "effect";
import { StartupStageError } from "./startup-stage-runner";

export type StartupReadinessState =
  | { state: "pending"; stage: "organization" }
  | { state: "inspecting"; stage: "organization" }
  | { state: "waiting"; stage: "organization"; reason: string }
  | { state: "started" }
  | { state: "stopping" }
  | { state: "stopped" };

export interface StartupReadinessDependencies {
  inspect(): Promise<boolean>;
  subscribe(wake: () => void): () => void;
  launch(): void;
  onBlocked(reason: string, cause?: unknown): void;
}

/** One scoped subscription and one coalescing queue own consented readiness. */
export function createStartupReadiness(dependencies: StartupReadinessDependencies) {
  const runtime = ManagedRuntime.make(Layer.empty);
  const state = runtime.runSync(Ref.make<StartupReadinessState>({ state: "pending", stage: "organization" }));
  const wakeups = runtime.runSync(Queue.sliding<void>(1));
  const stopped = new AbortController();
  let stopPromise: Promise<void> | null = null;
  let disposed = false;
  const setState = (next: StartupReadinessState) => Ref.update(state, () => next);
  const fiber = runtime.runFork(Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => dependencies.subscribe(() => {
        if (!stopped.signal.aborted) Queue.offerUnsafe(wakeups, undefined);
      })),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => Queue.shutdownUnsafe(wakeups)));
    // Subscription precedes the initial inspection. Events during inspection
    // stay queued, even when the inspected migration generation became stale.
    yield* Queue.offer(wakeups, undefined);
    while (!stopped.signal.aborted) {
      yield* Queue.take(wakeups);
      if (stopped.signal.aborted) return;
      yield* setState({ state: "inspecting", stage: "organization" });
      const inspected = yield* Effect.exit(Effect.uninterruptible(Effect.tryPromise({
        try: () => dependencies.inspect(),
        catch: (cause) => new StartupStageError({ stage: "organization", reason: cause instanceof Error ? cause.message : String(cause), cause }),
      })));
      if (stopped.signal.aborted) return;
      if (Exit.isSuccess(inspected) && inspected.value) {
        const admitted = yield* Ref.modify(state, (current) => current.state === "stopping" || current.state === "stopped" || current.state === "started"
          ? [false, current] as const
          : [true, { state: "started" } as const] as const);
        if (admitted && !stopped.signal.aborted) yield* Effect.sync(() => dependencies.launch());
        return;
      }
      const cause = Exit.isFailure(inspected) ? Cause.squash(inspected.cause) : undefined;
      const reason = cause === undefined ? "recording layout organization pending" : cause instanceof StartupStageError ? cause.reason : cause instanceof Error ? cause.message : String(cause);
      yield* setState({ state: "waiting", stage: "organization", reason });
      yield* Effect.sync(() => dependencies.onBlocked(reason, cause));
    }
  })));

  return {
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopped.abort();
      stopPromise = (async () => {
        try {
          await runtime.runPromise(setState({ state: "stopping" }));
          await runtime.runPromise(Fiber.interrupt(fiber));
          await runtime.runPromise(setState({ state: "stopped" }));
        } finally {
          await runtime.dispose();
          disposed = true;
        }
      })();
      return stopPromise;
    },
    getState: (): Promise<StartupReadinessState> => disposed ? Promise.resolve({ state: "stopped" }) : runtime.runPromise(Ref.get(state)),
  };
}
