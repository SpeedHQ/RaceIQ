import type { OutboxJob } from "./outbox-storage";
import type { OnlineUploadContext } from "./service";
import { Cause, Effect, Fiber, Layer, Queue, Schedule, Schema } from "effect";
import type { Duration } from "effect";
import * as PersistedQueue from "effect/persistence/PersistedQueue";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveOnlineDataDir } from "./runtime";
import { getOutboxJob, listDeliverableOutboxJobs } from "./outbox-storage";
import { MAX_UPLOAD_ATTEMPTS, processOutboxDelivery } from "./outbox";
import type { DispatchUnderPrivacyBarrier, UploadOutcome } from "./outbox";
import { cleanupRetiredOnlinePayloads } from "./upload-dispatch";
import { notifyOnlineSync, subscribeOnlineSync } from "./sync-events";

const RECONCILE_INTERVAL = "60 seconds";
const PACKAGE_RECONCILIATION_ATTEMPTS = 2_147_483_647;
const queueSchema = Schema.Struct({ rowId: Schema.Number, uploadKey: Schema.String });

export type OnlineUploadCoordinatorService = {
  getUploadContext: () => Promise<OnlineUploadContext | null>;
  isUploadContextCurrent: (context: OnlineUploadContext) => boolean;
  uploadOutboxJob: (job: OutboxJob, mayStart?: () => boolean) => Promise<UploadOutcome>;
  dispatchUnderPrivacyBarrier: DispatchUnderPrivacyBarrier;
  onReconciled?: (accountId: string) => void;
  afterDelivery?: () => void | Promise<void>;
  scan?: (context:OnlineUploadContext)=>Promise<void>;
};

export type OnlineUploadCoordinatorTestOptions = {
  readonly lockExpiration?: Duration.Input;
  readonly reconciliationInterval?: Duration.Input;
  readonly queuePollInterval?: Duration.Input;
  readonly retrySchedule?: Schedule.Schedule<unknown, number>;
};
export interface OnlineUploadCoordinator {readonly ready:Promise<void>;readonly completion:Promise<void>;stop():Promise<void>}

export function startOnlineUploadCoordinator(
  service: OnlineUploadCoordinatorService,
  testOptions: OnlineUploadCoordinatorTestOptions = {},
): OnlineUploadCoordinator {
  const dataDir = resolveOnlineDataDir();
  mkdirSync(dataDir, { recursive: true });
  const wakeups = Effect.runSync(Queue.sliding<void>(1));
  const queueStore = PersistedQueue.layerStoreSql({
    pollInterval: testOptions.queuePollInterval ?? "1 second",
    ...(testOptions.lockExpiration === undefined ? {} : { lockExpiration: testOptions.lockExpiration }),
  });
  let stopping = false;
  const started=Promise.withResolvers<void>();
  const unsubscribe = subscribeOnlineSync(() => { void Effect.runPromise(Queue.offer(wakeups, undefined)); });
  const program = Effect.gen(function*() {
    yield* Effect.sync(()=>started.resolve());
    while (!stopping) {
      yield* Effect.tryPromise({ try: cleanupRetiredOnlinePayloads, catch: (error) => error }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          console.error("[OnlineUpload] Payload cleanup unavailable");
          return Effect.void;
        }),
      );
      const activeService = service;
      const context = yield* Effect.tryPromise({ try: () => service.getUploadContext(), catch: (error) => error }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          console.error("[OnlineUpload] Credentials unavailable");
          return Effect.succeed(null);
        }),
      );
      if (!context) {
        yield* Effect.race(Queue.take(wakeups), Effect.sleep(testOptions.reconciliationInterval ?? RECONCILE_INTERVAL));
        continue;
      }
      yield* Effect.scoped(Effect.gen(function*() {
        const queue = yield* PersistedQueue.make({
          // v2 lets ledger reconciliation re-offer references dead-lettered by the old five-attempt namespace.
          name: `raceiq-online-upload-v2-${context.accountId}`,
          schema: queueSchema,
          // Package retries reconcile uncertain transport outcomes; business retries stay bounded in the outbox.
          maxAttempts: PACKAGE_RECONCILIATION_ATTEMPTS,
          ...(testOptions.retrySchedule === undefined ? {} : { retrySchedule: testOptions.retrySchedule }),
        });
        const delivery = Effect.forever()(queue.take((reference, metadata) => Effect.gen(function*() {
          if (stopping) return yield* Effect.interrupt;
          let row = yield* Effect.tryPromise({
            try: () => getOutboxJob(reference.rowId, context.accountId),
            catch: (error) => error,
          });
          while (row && row.retryNotBeforeAt > Date.now()) {
            yield* Effect.sleep(`${row.retryNotBeforeAt - Date.now()} millis`);
            if (stopping) return yield* Effect.interrupt;
            row = yield* Effect.tryPromise({
              try: () => getOutboxJob(reference.rowId, context.accountId),
              catch: (error) => error,
            });
          }
          const activeService = service;
          const activeContext = yield* Effect.tryPromise({ try: () => activeService.getUploadContext(), catch: (error) => error });
          if (!activeContext || activeContext.accountId !== context.accountId || !activeService.isUploadContextCurrent(activeContext)) {
            return yield* Effect.interrupt;
          }
          const result = yield* Effect.uninterruptible(Effect.tryPromise({
            try: () => processOutboxDelivery({
              reference,
              accountId: activeContext.accountId,
              accountEpoch: activeContext.accountEpoch,
              attempts: metadata.attempts,
              maxAttempts: MAX_UPLOAD_ATTEMPTS,
              dispatch: (job) => activeService.uploadOutboxJob(job, () => !stopping && activeService.isUploadContextCurrent(activeContext)),
              dispatchUnderPrivacyBarrier: activeService.dispatchUnderPrivacyBarrier,
              shouldContinue: () => !stopping && activeService.isUploadContextCurrent(activeContext),
            }),
            catch: (error) => error,
          }));
          if (service.afterDelivery) {
            yield* Effect.tryPromise({ try: async () => { await service.afterDelivery?.(); }, catch: (error) => error });
          }
          if (result.kind === "retry") {
            if (result.retryNotBeforeAt !== undefined) {
              yield* Effect.sleep(`${Math.max(0, result.retryNotBeforeAt - Date.now())} millis`);
            }
            return yield* Effect.fail(new Error("outbox_retry"));
          }
        })).pipe(Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          console.error("[OnlineUpload] Delivery unavailable");
          return Effect.void;
        })));
        const deliveryFiber = yield* Effect.forkScoped()(delivery);
        const reconcile = Effect.gen(function*() {
          if(service.scan) yield* Effect.tryPromise({try:()=>service.scan!(context),catch:()=>new Error("online_scan")});
          const jobs = yield* Effect.tryPromise({ try: () => listDeliverableOutboxJobs(context.accountId), catch: (error) => error });
          for (const job of jobs) {
            if (job.uploadKey) {
              yield* queue.offer(
                { rowId: job.rowId, uploadKey: job.uploadKey },
                {
                  id: job.uploadKey,
                  ...(job.retryNotBeforeAt > Date.now() ? { delay: `${job.retryNotBeforeAt - Date.now()} millis` } : {}),
                },
              );
            }
          }
        }).pipe(Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          console.error("[OnlineUpload] Reconciliation unavailable");
          return Effect.void;
        }));
        yield* reconcile;
        service.onReconciled?.(context.accountId);
        if (!stopping) yield* Effect.race(Queue.take(wakeups), Effect.sleep(testOptions.reconciliationInterval ?? RECONCILE_INTERVAL));
        yield* Fiber.interrupt(deliveryFiber);
      }));
    }
  }).pipe(
    Effect.provide(Layer.merge(
      Layer.provideMerge(PersistedQueue.layer, queueStore),
      Layer.provide(PersistedQueue.layerCleanup(), queueStore),
    )),
    Effect.provide(SqliteClient.layer({ filename: join(dataDir, "raceiq-online-queue.db") })),
  );
  const fiber = Effect.runFork(Effect.scoped(program));
  const completion=Effect.runPromise(Fiber.await(fiber)).then(()=>{
    if(!stopping){const failure=new Error("Online delivery runtime unavailable");started.reject(failure);throw failure;}
  });
  notifyOnlineSync();
  return {
    ready:started.promise,
    completion,
    async stop() {
      stopping = true;
      unsubscribe();
      await Effect.runPromise(Queue.offer(wakeups, undefined));
      await Effect.runPromise(Fiber.await(fiber));
    },
  };
}
