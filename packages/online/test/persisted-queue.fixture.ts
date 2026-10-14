import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Schedule, Schema } from "effect";
import * as PersistedQueue from "effect/persistence/PersistedQueue";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { beginOutboxAttempt, enqueueOutboxJob, getOutboxJob, listDeliverableOutboxJobs, persistOutboxPayload, settleOutboxDelivery } from "../src/outbox-storage";
import { startOnlineUploadCoordinator, type OnlineUploadCoordinatorService } from "../src/coordinator";
import { notifyOnlineSync } from "../src/sync-events";

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error("DATA_DIR is required for isolated queue fixture");
mkdirSync(dataDir, { recursive: true });

const intent = {
  accountId: "persisted-queue-child-account",
  accountEpoch: "persisted-queue-child-epoch",
  gameId: "acc",
  trackId: "persisted-queue-child-track",
  carId: "car-a",
  lapId: 1,
  lapTimeMs: 90_000,
};
const queueOptions = {
  lockExpiration: "100 millis",
  queuePollInterval: "10 millis",
  reconciliationInterval: "1 minute",
  retrySchedule: Schedule.spaced("1 millis"),
} as const;

function signal() {
  return Promise.withResolvers<void>();
}

function service(
  getAccount: () => typeof intent | null,
  uploadOutboxJob: OnlineUploadCoordinatorService["uploadOutboxJob"],
  options: Pick<OnlineUploadCoordinatorService, "afterDelivery" | "onReconciled"> = {},
): OnlineUploadCoordinatorService {
  return {
    async getUploadContext() {
      const account = getAccount();
      return account ? { accountId: account.accountId, accountEpoch: account.accountEpoch, revision: 1, setupUploads: false } : null;
    },
    isUploadContextCurrent(context) {
      const account = getAccount();
      return account?.accountId === context.accountId && account.accountEpoch === context.accountEpoch;
    },
    uploadOutboxJob,
    async dispatchUnderPrivacyBarrier(_job, send) {
      return { authorized: true, outcome: await send() };
    },
    ...options,
  };
}

async function waitFor<A>(promise: Promise<A>): Promise<A> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error("Coordinator fixture timed out")), 15_000);
  try { return await Promise.race([promise, timeout.promise]); }
  finally { clearTimeout(timer); }
}
async function payloadJob(account: typeof intent) {
  await enqueueOutboxJob(account);
  const [job] = await listDeliverableOutboxJobs(account.accountId);
  if (!job?.uploadKey) throw new Error("Payload fixture missing deliverable row");
  const payload = await persistOutboxPayload(job, {
    fingerprint: `fixture-${job.uploadKey}`,
    recordingPath: join(dataDir!, "online-upload-payloads", `${job.uploadKey}.bin`),
    setupPath: null,
  });
  if (!payload) throw new Error("Payload fixture could not persist payload");
  return payload;
}

async function testAmbiguousReconciliation(): Promise<void> {
  const ambiguousIntent = { ...intent, accountId: "persisted-queue-ambiguous-account", trackId: "ambiguous-track" };
  const job = await payloadJob(ambiguousIntent);
  let attempts = 0;
  let acceptedKey: string | undefined;
  const accepted = signal();
  const dispatch = async (candidate: Parameters<OnlineUploadCoordinatorService["uploadOutboxJob"]>[0]) => {
    attempts++;
    if (!candidate.uploadKey) throw new Error("Ambiguous dispatch lost uploadKey");
    if (acceptedKey && candidate.uploadKey !== acceptedKey) throw new Error("Ambiguous reconciliation rotated uploadKey");
    acceptedKey ??= candidate.uploadKey;
    if (attempts <= 7) return { kind: "ambiguous" as const, code: "transport_lost" };
    if (attempts === 8) return { kind: "definitely_not_sent" as const, code: "reservation_uncertain", retryable: false, retryAfterMs: 1 };
    accepted.resolve();
    return { kind: "request_accepted" as const, remoteJobId: "ambiguous-accepted" };
  };
  const coordinator = startOnlineUploadCoordinator(service(() => ambiguousIntent, dispatch), queueOptions);
  await waitFor(accepted.promise);
  await coordinator.stop();
  const stored = await getOutboxJob(job.rowId, ambiguousIntent.accountId);
  if (attempts !== 9 || stored?.status !== "transmitted" || stored.uploadKey !== acceptedKey) {
    throw new Error("Ambiguous delivery did not reconcile to durable acceptance");
  }
  let postRestartDispatches = 0;
  const restartAccepted = signal();
  const restarted = startOnlineUploadCoordinator(service(() => ambiguousIntent, async (candidate) => {
    postRestartDispatches++;
    if (candidate.uploadKey === acceptedKey) throw new Error("Known acceptance was redelivered after restart");
    restartAccepted.resolve();
    return { kind: "request_accepted", remoteJobId: "faster-lap-accepted" };
  }), queueOptions);
  const fasterIntent = { ...ambiguousIntent, trackId: "faster-lap", lapId: 2 };
  const faster = await payloadJob(fasterIntent);
  if (faster.trackId !== fasterIntent.trackId) throw new Error("Faster lap was not admitted");
  notifyOnlineSync();
  await waitFor(restartAccepted.promise);
  await restarted.stop();
  if (postRestartDispatches !== 1) throw new Error("Restart replayed accepted row or failed to dispatch faster lap");
  const acceptedAgain = await getOutboxJob(job.rowId, ambiguousIntent.accountId);
  if (acceptedAgain?.status !== "transmitted" || acceptedAgain.remoteJobId !== "ambiguous-accepted") {
    throw new Error("Restart changed durable acceptance");
  }
  process.stdout.write("ambiguous-reconciliation-verified\n");
}

async function seedFailedOldNamespace(accountId: string, rowId: number, uploadKey: string): Promise<void> {
  const name = `raceiq-online-upload-${accountId}`;
  const store = PersistedQueue.layerStoreSql({ pollInterval: "10 millis" });
  const program = Effect.gen(function*() {
    const queue = yield* PersistedQueue.make({
      name,
      schema: Schema.Struct({ rowId: Schema.Number, uploadKey: Schema.String }),
      maxAttempts: 1,
      retrySchedule: Schedule.spaced("1 millis"),
    });
    yield* queue.offer({ rowId, uploadKey }, { id: uploadKey });
    yield* queue.take(() => Effect.fail(new Error("legacy package entry exhausted")));
  }).pipe(
    Effect.provide(Layer.merge(Layer.provideMerge(PersistedQueue.layer, store), Layer.provide(PersistedQueue.layerCleanup(), store))),
    Effect.provide(SqliteClient.layer({ filename: join(dataDir!, "raceiq-online-queue.db") })),
  );
  await Effect.runPromise(program).catch(() => undefined);
}

async function recoverFailedOldNamespace(): Promise<void> {
  const legacyIntent = { ...intent, accountId: "persisted-queue-legacy-account", trackId: "legacy-track" };
  const row = await payloadJob(legacyIntent);
  const attempted = await beginOutboxAttempt({
    rowId: row.rowId, accountId: row.accountId, accountEpoch: row.accountEpoch, uploadKey: row.uploadKey!,
    attempts: row.attempts + 1,
  });
  if (!attempted || !(await settleOutboxDelivery({
    job: attempted, status: "ambiguous", errorCode: "legacy-ambiguous",
  }))) throw new Error("Could not seed ambiguous legacy ledger row");
  await seedFailedOldNamespace(legacyIntent.accountId, row.rowId, row.uploadKey!);
  const accepted = signal();
  const coordinator = startOnlineUploadCoordinator(service(() => legacyIntent, async (job) => {
    if (job.rowId !== row.rowId || job.uploadKey !== row.uploadKey) throw new Error("Recovery changed ledger identity");
    accepted.resolve();
    return { kind: "request_accepted", remoteJobId: "legacy-recovered" };
  }), queueOptions);
  await waitFor(accepted.promise);
  await coordinator.stop();
  const stored = await getOutboxJob(row.rowId, legacyIntent.accountId);
  if (stored?.status !== "transmitted" || stored.remoteJobId !== "legacy-recovered") {
    throw new Error("Failed legacy queue reference did not recover from ledger");
  }
  process.stdout.write("legacy-namespace-recovery-verified\n");
}




async function crashPrepare(): Promise<void> {
  await enqueueOutboxJob(intent);
  const acceptedBeforeAck = signal();
  const coordinator = startOnlineUploadCoordinator(service(() => intent, async () => ({
    kind: "request_accepted", remoteJobId: "accepted-before-process-crash",
  }), {
    afterDelivery: async () => {
      process.stdout.write("accepted-before-queue-ack\n");
      await acceptedBeforeAck.promise;
    },
  }), queueOptions);
  await waitFor(acceptedBeforeAck.promise);
  await coordinator.stop();
}

async function recoverAfterCrash(): Promise<void> {
  const redelivered = signal();
  const coordinator = startOnlineUploadCoordinator(service(() => intent, async () => {
    throw new Error("accepted ledger marker must prevent another HTTP send");
  }, { afterDelivery: () => redelivered.resolve() }), queueOptions);
  await waitFor(redelivered.promise);
  await coordinator.stop();
  const rows = await listDeliverableOutboxJobs(intent.accountId);
  const stored = await getOutboxJob(1, intent.accountId);
  if (rows.length !== 0 || stored?.status !== "transmitted" || stored.remoteJobId !== "accepted-before-process-crash") {
    throw new Error("Crash recovery did not preserve and acknowledge durable acceptance");
  }
  process.stdout.write("crash-redelivery-verified\n");
}

async function testDefiniteFailureBudget(): Promise<void> {
  const rejectedIntent = { ...intent, accountId: "persisted-queue-rejected-account", trackId: "rejected-track" };
  const row = await payloadJob(rejectedIntent);
  let sends = 0;
  const coordinator = startOnlineUploadCoordinator(service(() => rejectedIntent, async () => {
    sends++;
    return { kind: "definitely_not_sent", code: "service_unavailable", retryable: true };
  }), queueOptions);
  const deadline = Date.now() + 5_000;
  let stored = await getOutboxJob(row.rowId, rejectedIntent.accountId);
  while (stored?.status !== "rejected" && Date.now() < deadline) {
    const { promise: pause, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, 10);
    await pause;
    clearTimeout(timer);
    stored = await getOutboxJob(row.rowId, rejectedIntent.accountId);
  }
  await coordinator.stop();
  const deliverable = await listDeliverableOutboxJobs(rejectedIntent.accountId);
  if (stored?.status !== "rejected" || sends !== 5 || deliverable.length !== 0) {
    throw new Error(`Definite failure budget mismatch: status=${stored?.status}, sends=${sends}, deliverable=${deliverable.length}`);
  }
  process.stdout.write("definite-failure-budget-verified\n");
}

async function testRetryAccountAndStop(): Promise<void> {
  const retryIntent = { ...intent, accountId: "persisted-queue-retry-account", trackId: "retry-track" };
  await enqueueOutboxJob(retryIntent);
  let attempts = 0;
  const retried = signal();
  let retryNotBeforeAt = 0;
  const retryCoordinator = startOnlineUploadCoordinator(service(() => retryIntent, async () => {
    attempts++;
    if (attempts === 1) {
      retryNotBeforeAt = Date.now() + 200;
      return { kind: "definitely_not_sent", code: "service_unavailable", retryable: true, retryAfterMs: 200 };
    }
    if (Date.now() < retryNotBeforeAt) throw new Error("Transport started before durable Retry-After deadline");
    retried.resolve();
    return { kind: "request_accepted", remoteJobId: "retry-accepted" };
  }), queueOptions);
  await waitFor(retried.promise);
  await retryCoordinator.stop();
  if (attempts !== 2 || (await listDeliverableOutboxJobs(retryIntent.accountId)).length !== 0) {
    throw new Error("Retry did not honor ledger retry deadline and eventually accept");
  }

  const owner = { ...intent, accountId: "persisted-queue-owner-account", trackId: "owner-track" };
  await enqueueOutboxJob(owner);
  const other = { ...intent, accountId: "persisted-queue-other-account", trackId: "other-track" };
  let current: typeof owner | typeof other = other;
  const reconciled = signal();
  const sent = signal();
  let sends = 0;
  const accountCoordinator = startOnlineUploadCoordinator(service(() => current, async () => {
    sends++;
    sent.resolve();
    return { kind: "request_accepted", remoteJobId: "owner-accepted" };
  }, { onReconciled: () => reconciled.resolve() }), queueOptions);
  await waitFor(reconciled.promise);
  if (sends !== 0 || (await listDeliverableOutboxJobs(owner.accountId)).length !== 1) {
    throw new Error("Coordinator crossed account-owned queue boundary");
  }
  current = owner;
  notifyOnlineSync();
  await waitFor(sent.promise);
  await accountCoordinator.stop();

  const stopIntent = { ...intent, accountId: "persisted-queue-stop-account", trackId: "stop-track" };
  await enqueueOutboxJob(stopIntent);
  const started = signal();
  const release = signal();
  const stopCoordinator = startOnlineUploadCoordinator(service(() => stopIntent, async () => {
    started.resolve();
    await release.promise;
    return { kind: "request_accepted", remoteJobId: "stop-accepted" };
  }), queueOptions);
  await waitFor(started.promise);
  let stopped = false;
  const stop = stopCoordinator.stop().then(() => { stopped = true; });
  if (stopped) throw new Error("Stop returned before active transport finished");
  release.resolve();
  await waitFor(stop);
  const stopRows = await listDeliverableOutboxJobs(stopIntent.accountId);
  if (stopRows.length !== 0) throw new Error("Stop returned before acceptance receipt was durable");
  process.stdout.write("retry-account-shutdown-verified\n");
}

try {
  const mode = process.argv[2];
  if (mode === "crash-prepare") await crashPrepare();
  else if (mode === "crash-recover") await recoverAfterCrash();
  else if (mode === "integration-suite") {
    await testAmbiguousReconciliation();
    await recoverFailedOldNamespace();
    await testDefiniteFailureBudget();
    await testRetryAccountAndStop();
  } else throw new Error(`Unknown fixture mode: ${mode}`);
} finally {
  if (process.argv[2] !== "crash-prepare") rmSync(dataDir, { recursive: true, force: true });
}
