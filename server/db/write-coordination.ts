import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { Client, Transaction } from "@libsql/client/sqlite3";
import { randomUUID } from "node:crypto";
import { createWorkerSqlClient, createWorkerSqlHost, type WorkerSqlOperation, type WorkerSqlRequest, type WorkerSqlResponse, type WorkerSqlSender } from "./worker-sql";

export type WriteLeaseRequest = { type: "write-lease-acquire"; requestId: number } | { type: "write-lease-cancel"; requestId: number } | { type: "write-lease-release"; leaseId: string } | { type: "write-lease-stop" } | WorkerSqlRequest;
export type WriteLeaseResponse = { type: "write-lease-granted"; requestId: number; leaseId: string } | { type: "write-lease-rejected"; requestId: number; reason: string } | { type: "write-lease-released"; leaseId: string } | { type: "write-lease-drained" } | { type: "write-lease-channel-closed"; reason: string } | WorkerSqlResponse;
export type WriteLeaseTransport = { request(message: WriteLeaseRequest): void; subscribe(listener: (message: WriteLeaseResponse) => void): () => void };
export interface DatabaseWriteLeaseAuthority {
  receive(message: WriteLeaseRequest): void;
  stop(): Promise<void>;
  workerExited(): Promise<void>;
}
type Lease = { release(): void | Promise<void>; sql?: WorkerSqlSender };
const leaseContext = new AsyncLocalStorage<Lease>();
let localAcquire: ((operation?: string) => Promise<Lease>) | null = null;
let workerTransport: WriteLeaseTransport | null = null;
let stopLocalAuthority: (() => Promise<void>) | null = null;
let sequence = 0;
let sqlSequence = 0;
const writeRuntime = ManagedRuntime.make(Layer.empty);
let writeTestHooks: { waiting(operation: string): void } | null = null;

/** Injected by the backend test dependency port, never by production requests. */
export function installDatabaseWriteTestHooks(hooks: { waiting(operation: string): void }): () => void {
  const previous = writeTestHooks;
  writeTestHooks = hooks;
  return () => { if (writeTestHooks === hooks) writeTestHooks = previous; };
}

/** Installs shared local/worker admission authority; returned stop drains current lease and rejects queued local writes. */
export function installDatabaseWriteAuthority(): () => Promise<void> {
  if (stopLocalAuthority) return stopLocalAuthority;
  let stopping = false;
  let active = false;
  const waiters: Array<{ resolve(lease: Lease): void; reject(error: Error): void }> = [];
  let resolveDrained: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;
  const makeLease = (): Lease => {
    let released = false;
    return { release() {
      if (released) return;
      released = true;
      const next = stopping ? undefined : waiters.shift();
      if (next) next.resolve(makeLease());
      else {
        active = false;
        resolveDrained?.();
      }
    } };
  };
  localAcquire = (operation = "write") => {
    if (stopping) return Promise.reject(new Error("Database writes are stopping"));
    if (active) {
      writeTestHooks?.waiting(operation);
      return new Promise<Lease>((resolve, reject) => waiters.push({ resolve, reject }));
    }
    active = true;
    return Promise.resolve(makeLease());
  };
  stopLocalAuthority = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("Database writes are stopping"));
    stopPromise = (active ? new Promise<void>((resolve) => { resolveDrained = resolve; }) : Promise.resolve()).then(() => {
      localAcquire = null;
      stopLocalAuthority = null;
    });
    return stopPromise;
  };
  return stopLocalAuthority;
}

/** Stops local write admission after all application ingress and worker writes drain. */
export async function stopDatabaseWriteAuthority(): Promise<void> {
  await stopLocalAuthority?.();
}

/** Creates parent message handler. Leases share the exact local authority used by HTTP writes. */
export function createDatabaseWriteLeaseAuthority(send: (message: WriteLeaseResponse) => void, client?: Client): DatabaseWriteLeaseAuthority {
  let stopping = false;
  let draining = false;
  const requests = new Map<number, { canceled: boolean; leaseId?: string }>();
  const leases = new Map<string, Lease>();
  const leaseRequests = new Map<string, number>();
  const releases = new Map<string, Promise<void>>();
  const sqlHost = client ? createWorkerSqlHost(client) : null;
  const queue: number[] = [];
  // One FIFO port per worker lifetime; reject stale requests without retaining
  // a completion ledger. SQL and lease IDs have separate monotonic sequences.
  let lastRequestId = 0;
  let granting = false;
  let exitCleanup: Promise<void> | null = null;
  const idleWaiters: Array<() => void> = [];
  const drainAck = () => {
    if (!draining || granting || leases.size || queue.length) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
    send({ type: "write-lease-drained" });
  };
  const grant = async () => {
    if (granting || stopping) return;
    granting = true;
    try {
      while (!stopping && queue.length) {
        const requestId = queue.shift()!;
        const request = requests.get(requestId);
        if (!request || request.canceled) { requests.delete(requestId); continue; }
        let lease: Lease;
        try {
          if (!localAcquire) throw new Error("Database write authority unavailable");
          lease = await localAcquire("worker");
        } catch (error) {
          requests.delete(requestId);
          send({ type: "write-lease-rejected", requestId, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        if (request.canceled || stopping) { requests.delete(requestId); lease.release(); continue; }
        const leaseId = randomUUID();
        request.leaseId = leaseId;
        leaseRequests.set(leaseId, requestId);
        leases.set(leaseId, lease);
        sqlHost?.openLease(leaseId);
        send({ type: "write-lease-granted", requestId, leaseId });
      }
    } finally {
      granting = false;
      drainAck();
    }
  };
  const release = (leaseId: string): Promise<void> => {
    const pending = releases.get(leaseId);
    if (pending) return pending;
    const lease = leases.get(leaseId);
    if (!lease) return Promise.resolve();
    const settled = (async () => {
      // SQL handles live here, not in the worker. Even forced worker exit must
      // settle submitted I/O and close/rollback native transactions first.
      await sqlHost?.closeLease(leaseId);
      leases.delete(leaseId);
      const requestId = leaseRequests.get(leaseId);
      leaseRequests.delete(leaseId);
      if (requestId !== undefined) requests.delete(requestId);
      lease.release();
      void grant();
      drainAck();
    })();
    releases.set(leaseId, settled);
    void settled.then(() => releases.delete(leaseId), () => releases.delete(leaseId));
    return settled;
  };
  const releaseInBackground = (leaseId: string) => {
    void release(leaseId).then(() => send({ type: "write-lease-released", leaseId })).catch((error) => console.error("[DatabaseWrite] Worker SQL release failed:", error));
  };
  const stopAdmission = () => {
    stopping = true;
    draining = true;
    for (const [requestId, request] of requests) {
      if (request.leaseId) continue;
      request.canceled = true;
      requests.delete(requestId);
      send({ type: "write-lease-rejected", requestId, reason: "Database writes are stopping" });
    }
    queue.length = 0;
  };
  const replySql = (response: WorkerSqlResponse) => {
    try { send(response); }
    catch (error) { console.error("[DatabaseWrite] Worker SQL response channel failed:", error); }
  };
  const receive = (message: WriteLeaseRequest) => {
    if (message.type === "write-lease-sql") {
      if (!sqlHost || !leases.has(message.leaseId) || releases.has(message.leaseId)) {
        replySql({ type: "write-lease-sql-error", operationId: message.operationId, error: { name: "Error", message: "Worker SQL requires an active write lease" } });
      } else {
        void sqlHost.receive(message).then(replySql, (error: unknown) => replySql({
          type: "write-lease-sql-error", operationId: message.operationId,
          error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) },
        }));
      }
    } else if (message.type === "write-lease-acquire") {
      if (!Number.isSafeInteger(message.requestId) || message.requestId <= lastRequestId) return;
      lastRequestId = message.requestId;
      if (stopping) send({ type: "write-lease-rejected", requestId: message.requestId, reason: "Database writes are stopping" });
      else { requests.set(message.requestId, { canceled: false }); queue.push(message.requestId); void grant(); }
    } else if (message.type === "write-lease-cancel") {
      lastRequestId = Math.max(lastRequestId, message.requestId);
      const request = requests.get(message.requestId);
      if (request) {
        request.canceled = true;
        if (request.leaseId) releaseInBackground(request.leaseId);
      }
      void grant();
    } else if (message.type === "write-lease-release") {
      releaseInBackground(message.leaseId);
    } else {
      stopAdmission();
      drainAck();
    }
  };
  return {
    receive,
    async stop() {
      stopAdmission();
      if (granting || leases.size) await new Promise<void>((resolve) => idleWaiters.push(resolve));
      drainAck();
    },
    workerExited() {
      if (exitCleanup) return exitCleanup;
      stopAdmission();
      exitCleanup = (async () => {
        await Promise.all([...leases.keys()].map(release));
        await sqlHost?.close();
        requests.clear();
        drainAck();
      })();
      return exitCleanup;
    },
  };
}

export function configureDatabaseWriteWorkerTransport(transport: WriteLeaseTransport): () => void {
  workerTransport = transport;
  return () => { if (workerTransport === transport) workerTransport = null; };
}

function releaseWorkerLease(transport: WriteLeaseTransport, leaseId: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;
  let unsubscribe = () => {};
  unsubscribe = transport.subscribe((message) => {
    if (settled) return;
    if (message.type === "write-lease-channel-closed") {
      settled = true;
      unsubscribe();
      reject(new Error(message.reason));
    } else if (message.type === "write-lease-released" && message.leaseId === leaseId) {
      settled = true;
      unsubscribe();
      resolve();
    }
  });
  try { transport.request({ type: "write-lease-release", leaseId }); }
  catch (error) { settled = true; unsubscribe(); reject(error); }
  return promise;
}

function requestWorkerSql(transport: WriteLeaseTransport, leaseId: string, operation: WorkerSqlOperation): Promise<WorkerSqlResponse> {
  const operationId = ++sqlSequence;
  const { promise, resolve, reject } = Promise.withResolvers<WorkerSqlResponse>();
  let settled = false;
  let unsubscribe = () => {};
  unsubscribe = transport.subscribe((message) => {
    if (settled) return;
    if (message.type === "write-lease-channel-closed") {
      settled = true;
      unsubscribe();
      reject(new Error(message.reason));
    } else if ((message.type === "write-lease-sql-result" || message.type === "write-lease-sql-error") && message.operationId === operationId) {
      settled = true;
      unsubscribe();
      resolve(message);
    }
  });
  try { transport.request({ type: "write-lease-sql", leaseId, operationId, operation }); }
  catch (error) { settled = true; unsubscribe(); reject(error); }
  return promise;
}

/** Only admitted worker write units can obtain a parent-owned SQL executor. */
export function createDatabaseWorkerClient(): Client {
  return createWorkerSqlClient(() => {
    const sender = leaseContext.getStore()?.sql;
    if (!sender) throw new Error("Worker SQL requires an active remote database write lease");
    return sender;
  });
}

async function acquireLease(signal?: AbortSignal, operation?: string): Promise<Lease> {
  if (signal?.aborted) throw signal.reason ?? new Error("Database write admission interrupted");
  if (localAcquire) {
    const pending = localAcquire(operation);
    if (!signal) return pending;
    return new Promise<Lease>((resolve, reject) => {
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        reject(signal.reason ?? new Error("Database write admission interrupted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      pending.then((lease) => {
        signal.removeEventListener("abort", abort);
        if (settled || signal.aborted) {
          lease.release();
          if (!settled) reject(signal.reason ?? new Error("Database write admission interrupted"));
        } else {
          settled = true;
          resolve(lease);
        }
      }, (error) => {
        signal.removeEventListener("abort", abort);
        if (!settled) { settled = true; reject(error); }
      });
      if (signal.aborted) abort();
    });
  }
  const transport = workerTransport;
  if (!transport) throw new Error("Database write authority unavailable");
  const requestId = ++sequence;
  let unsubscribe = () => {};
  let settled = false;
  const result = new Promise<Lease>((resolve, reject) => {
    const abort = () => {
      if (settled) return;
      settled = true;
      try { transport.request({ type: "write-lease-cancel", requestId }); }
      catch (error) { console.error("[DatabaseWrite] Could not cancel closed worker lease channel:", error); }
      unsubscribe();
      reject(signal?.reason ?? new Error("Database write admission interrupted"));
    };
    unsubscribe = transport.subscribe((message) => {
      if (message.type === "write-lease-channel-closed") {
        if (workerTransport === transport) workerTransport = null;
        if (!settled) {
          settled = true;
          signal?.removeEventListener("abort", abort);
          unsubscribe();
          reject(new Error(message.reason));
        }
        return;
      }
      if ((message.type !== "write-lease-granted" && message.type !== "write-lease-rejected") || message.requestId !== requestId) return;
      if (settled) {
        if (message.type === "write-lease-granted") transport.request({ type: "write-lease-release", leaseId: message.leaseId });
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (message.type === "write-lease-rejected") reject(new Error(message.reason));
      else {
        let released: Promise<void> | undefined;
        resolve({
          release: () => released ??= releaseWorkerLease(transport, message.leaseId),
          sql: (operation) => requestWorkerSql(transport, message.leaseId, operation),
        });
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else {
      try { transport.request({ type: "write-lease-acquire", requestId }); }
      catch (error) {
        settled = true;
        signal?.removeEventListener("abort", abort);
        unsubscribe();
        reject(error);
      }
    }
  });
  return result;
}

/** Acquires the permit as a scoped resource; Promise I/O settles before finalization releases it. */
export function withDatabaseWrite<T>(operation: () => Promise<T>, signal?: AbortSignal, operationName?: string): Promise<T> {
  if (leaseContext.getStore()) return operation().then();
  const leaseEffect = Effect.scoped(Effect.gen(function* () {
    const lease = yield* Effect.acquireRelease(
      Effect.promise(() => acquireLease(signal, operationName)),
      (acquired) => Effect.promise(async () => { await acquired.release(); }),
    );
    return yield* Effect.uninterruptible(Effect.promise(() => leaseContext.run(lease, () => {
      signal?.throwIfAborted();
      return operation().then();
    })));
  }));
  return writeRuntime.runPromise(leaseEffect);
}

export function withDatabaseTransaction<T>(
  client: Client,
  operation: (transaction: Transaction) => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const signal = options.signal;
  const inheritedLease = leaseContext.getStore();
  let failed = false;
  const transactionEffect = Effect.scoped(Effect.gen(function* () {
    const lease = inheritedLease ?? (yield* Effect.acquireRelease(
      Effect.promise(() => acquireLease(signal)),
      (acquired) => Effect.promise(async () => { await acquired.release(); }),
    ));
    const transaction = yield* Effect.acquireRelease(
      Effect.promise(() => leaseContext.run(lease, () => client.transaction("write"))),
      (tx) => Effect.promise(async () => {
        try { await tx.close(); }
        catch (cleanupError) {
          if (failed) {
            console.error("[DatabaseWrite] Transaction close failed after primary failure:", cleanupError);
            return;
          }
          throw cleanupError;
        }
      }),
    );
    return yield* Effect.uninterruptible(Effect.promise(() => leaseContext.run(lease, async () => {
      try {
        if (signal?.aborted) throw signal.reason ?? new Error("Database write interrupted before transaction");
        const result = await operation(transaction);
        if (signal?.aborted) throw signal.reason ?? new Error("Database write interrupted before commit");
        await transaction.commit();
        return result;
      } catch (error) {
        failed = true;
        try { await transaction.rollback(); }
        catch (cleanupError) { console.error("[DatabaseWrite] Transaction rollback failed after primary failure:", cleanupError); }
        throw error;
      }
    })));
  }));
  return writeRuntime.runPromise(transactionEffect);
}
