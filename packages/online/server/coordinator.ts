import { Cause, Effect, Fiber, Queue } from "effect";
import type { Duration } from "effect";
import { notifyOnlineSync, subscribeOnlineSync } from "./sync-events";
import type { OnlineUploadContext } from "./upload-dispatch";

const RECONCILE_INTERVAL = "60 seconds";

export type OnlineUploadCoordinatorService = {
  getUploadContext: () => Promise<OnlineUploadContext | null>;
  isUploadContextCurrent: (context: OnlineUploadContext) => boolean;
  onReconciled?: (accountId: string) => void;
  scan: (context: OnlineUploadContext) => Promise<void>;
};

export type OnlineUploadCoordinatorTestOptions = {
  readonly reconciliationInterval?: Duration.Input;
};
export interface OnlineUploadCoordinator { readonly ready: Promise<void>; readonly completion: Promise<void>; stop(): Promise<void> }

export function startOnlineUploadCoordinator(
  service: OnlineUploadCoordinatorService,
  testOptions: OnlineUploadCoordinatorTestOptions = {},
): OnlineUploadCoordinator {
  const wakeups = Effect.runSync(Queue.sliding<void>(1));
  let stopping = false;
  const started = Promise.withResolvers<void>();
  const unsubscribe = subscribeOnlineSync(() => { void Effect.runPromise(Queue.offer(wakeups, undefined)); });
  const program = Effect.gen(function*() {
    started.resolve();
    while (!stopping) {
      const context = yield* Effect.tryPromise({ try: () => service.getUploadContext(), catch: (error) => error }).pipe(
        Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.sync(() => { console.error("[OnlineUpload] Credentials unavailable"); return null; })),
      );
      if (context && !stopping && service.isUploadContextCurrent(context)) {
        yield* Effect.tryPromise({ try: () => service.scan(context), catch: (error) => error }).pipe(
          Effect.tap(() => Effect.sync(() => service.onReconciled?.(context.accountId))),
          Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.sync(() => { console.error("[OnlineUpload] Upload pass unavailable"); })),
        );
      }
      if (!stopping) yield* Effect.race(Queue.take(wakeups), Effect.sleep(testOptions.reconciliationInterval ?? RECONCILE_INTERVAL));
    }
  });
  const fiber = Effect.runFork(program);
  const completion = Effect.runPromise(Fiber.await(fiber)).then(() => {
    if (!stopping) { const failure = new Error("Online upload runtime unavailable"); started.reject(failure); throw failure; }
  });
  notifyOnlineSync();
  return {
    ready: started.promise,
    completion,
    async stop() {
      stopping = true;
      unsubscribe();
      await Effect.runPromise(Queue.offer(wakeups, undefined));
      await Effect.runPromise(Fiber.await(fiber));
    },
  };
}
