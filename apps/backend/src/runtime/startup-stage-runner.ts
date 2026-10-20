import { Cause, Effect, Exit, Layer, ManagedRuntime, Ref, Schema } from "effect";

export class StartupStageError extends Schema.TaggedError<StartupStageError>()("StartupStageError", {
  stage: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}

export type StartupStageResult =
  | { type: "complete"; finish: Effect.Effect<void, StartupStageError> }
  | { type: "blocked"; reason: string };

export interface StartupStage<Id extends string = string> {
  readonly id: Id;
  readonly name: string;
  execute(signal: AbortSignal): Effect.Effect<StartupStageResult, StartupStageError>;
}

export interface StartupStageSpec<Id extends string, Result> {
  readonly id: Id;
  readonly name: string;
  run(): Promise<Result>;
  isComplete(result: Result): boolean;
  blockedReason(result: Result): string;
  onComplete?(result: Result, signal: AbortSignal): Promise<void> | void;
}

function stageError(stage: string, cause: unknown): StartupStageError {
  return new StartupStageError({ stage, reason: cause instanceof Error ? cause.message : String(cause), cause });
}

/** Captures each raw result type before erasing it into the ordered stage queue. */
export function defineStartupStage<const Id extends string, Result>(spec: StartupStageSpec<Id, Result>): StartupStage<Id> {
  return {
    id: spec.id,
    name: spec.name,
    execute: (signal) => Effect.gen(function* () {
      // Repair Promise I/O cannot be cancelled underneath its storage/SQL locks.
      const result = yield* Effect.uninterruptible(Effect.tryPromise({
        try: () => spec.run(),
        catch: (cause) => stageError(spec.id, cause),
      }));
      if (!spec.isComplete(result)) return { type: "blocked" as const, reason: spec.blockedReason(result) };
      return {
        type: "complete" as const,
        finish: Effect.uninterruptible(Effect.tryPromise({
          try: async () => { await spec.onComplete?.(result, signal); },
          catch: (cause) => stageError(spec.id, cause),
        })),
      };
    }),
  };
}

export type StartupLifecycleState<Id extends string = string> =
  | { state: "pending" }
  | { state: "running"; stage: Id }
  | { state: "waiting"; stage: Id; reason: string }
  | { state: "complete"; stage?: Id }
  | { state: "failed"; stage: Id; reason: string }
  | { state: "interrupted"; stage: Id }
  | { state: "stopping" }
  | { state: "stopped" };

export function createStartupStageRunner<const Id extends string>(
  stages: readonly StartupStage<Id>[],
  onFailure: (stage: StartupStage<Id>, reason: string, kind: "blocked" | "failed") => void,
  beforeStage?: (stage: StartupStage<Id>) => Promise<void>,
) {
  const runtime = ManagedRuntime.make(Layer.empty);
  const state = runtime.runSync(Ref.make<StartupLifecycleState<Id>>({ state: "pending" }));
  const setState = (next: StartupLifecycleState<Id>) => Ref.update(state, () => next);
  const admitted = runtime.runSync(Ref.make(false));
  const controller = new AbortController();
  let resultPromise: Promise<boolean> | null = null;
  let stopPromise: Promise<void> | null = null;
  let disposed = false;

  const run = (): Promise<boolean> => {
    if (controller.signal.aborted) return Promise.resolve(false);
    if (resultPromise) return resultPromise;
    resultPromise = runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      if (!(yield* Ref.modify(admitted, (current) => [!current, true] as const))) return false;
      for (const stage of stages) {
        if (controller.signal.aborted) return false;
        yield* setState(({ state: "running", stage: stage.id }));
        const outcome = yield* Effect.exit(Effect.gen(function* () {
          if (beforeStage) yield* Effect.uninterruptible(Effect.tryPromise({
            try: () => beforeStage(stage),
            catch: (cause) => stageError(stage.id, cause),
          }));
          if (controller.signal.aborted) return null;
          const result = yield* stage.execute(controller.signal);
          if (controller.signal.aborted) return null;
          if (result.type === "complete") yield* result.finish;
          return result;
        }));
        if (controller.signal.aborted) {
          yield* setState(({ state: "interrupted", stage: stage.id }));
          return false;
        }
        if (Exit.isFailure(outcome)) {
          const error = Cause.squash(outcome.cause);
          const reason = error instanceof StartupStageError ? error.reason : error instanceof Error ? error.message : String(error);
          yield* setState(({ state: "failed", stage: stage.id, reason }));
          yield* Effect.sync(() => onFailure(stage, reason, "failed"));
          return false;
        }
        const result = outcome.value;
        if (result === null) return false;
        if (result.type === "blocked") {
          yield* setState(({ state: "waiting", stage: stage.id, reason: result.reason }));
          yield* Effect.sync(() => onFailure(stage, result.reason, "blocked"));
          return false;
        }
        yield* setState(({ state: "complete", stage: stage.id }));
      }
      yield* setState(({ state: "complete" }));
      return true;
    })));
    return resultPromise;
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    controller.abort();
    stopPromise = (async () => {
      try {
        await runtime.runPromise(setState(({ state: "stopping" })));
        await resultPromise?.catch(() => false);
        await runtime.runPromise(setState(({ state: "stopped" })));
      } finally {
        await runtime.dispose();
        disposed = true;
      }
    })();
    return stopPromise;
  };

  return {
    run,
    stop,
    getState: (): Promise<StartupLifecycleState<Id>> => disposed ? Promise.resolve({ state: "stopped" }) : runtime.runPromise(Ref.get(state)),
  };
}
