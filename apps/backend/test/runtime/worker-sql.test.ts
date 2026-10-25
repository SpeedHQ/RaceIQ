import { describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client/sqlite3";
import { createWorkerSqlClient, createWorkerSqlHost, type WorkerSqlOperation, type WorkerSqlRequest, type WorkerSqlResponse, type WorkerSqlSender } from "@raceiq/backend-core/db/worker-sql";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessageChannel, Worker } from "node:worker_threads";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { createDatabaseWorkerClient, createDatabaseWriteLeaseAuthority, installDatabaseWriteAuthority, installDatabaseWriteTestHooks, withDatabaseWrite, type DatabaseWriteLeaseAuthority, type WriteLeaseRequest, type WriteLeaseResponse } from "@raceiq/backend-core/db/write-coordination";
function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

type WorkerTestMessage = { type: "test-held" | "test-done" } | { type: "test-error"; message: string };
const testTimeout = 15_000;

function waitForWorkerMessage(worker: Worker, type: "test-held" | "test-done", exit: Promise<number>) {
  const { promise, resolve, reject } = Promise.withResolvers<WorkerTestMessage>();
  let settled = false;
  const cleanup = () => {
    clearTimeout(timer);
    worker.off("message", onMessage);
    worker.off("error", onError);
  };
  const finish = (error?: unknown, message?: WorkerTestMessage) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) reject(error);
    else resolve(message!);
  };
  const timer = setTimeout(() => finish(new Error(`Timed out waiting for worker ${type}`)), testTimeout);
  const onError = (error: Error) => finish(error);
  const onMessage = (message: WorkerTestMessage) => {
    if (message.type === "test-error") finish(new Error(message.message));
    else if (message.type === type) finish(undefined, message);
  };
  worker.on("message", onMessage);
  worker.once("error", onError);
  void exit.then((code) => finish(new Error(`Worker exited before ${type} (${code})`)), finish);
  return promise;
}

function waitForExit(worker: Worker) {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const timer = setTimeout(() => {
    worker.off("exit", onExit);
    worker.off("error", onError);
    reject(new Error("Timed out waiting for worker exit"));
  }, testTimeout);
  const onExit = (code: number) => { clearTimeout(timer); worker.off("error", onError); resolve(code); };
  const onError = (error: Error) => { clearTimeout(timer); worker.off("exit", onExit); reject(error); };
  worker.once("exit", onExit);
  worker.once("error", onError);
  return promise;
}

async function waitForSignal<T>(signal: Promise<T>, label: string, exit: Promise<number>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), testTimeout); }),
      exit.then((code) => { throw new Error(`Worker exited before ${label} (${code})`); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function withDatabase(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-worker-sql-"));
  try { await run(join(directory, "database.sqlite")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function channelFor(client: Client, leaseId: string) {
  const host = createWorkerSqlHost(client);
  host.openLease(leaseId);
  const channel = new MessageChannel();
  let operationId = 0;
  channel.port1.on("message", (data: WorkerSqlRequest) => { void host.receive(data).then((response) => channel.port1.postMessage(response)); });
  const sender: WorkerSqlSender = (operation: WorkerSqlOperation) => {
    const id = ++operationId;
    const { promise, resolve } = Promise.withResolvers<WorkerSqlResponse>();
    const receive = (data: WorkerSqlResponse) => {
      if (data.operationId !== id) return;
      channel.port2.off("message", receive);
      resolve(data);
    };
    channel.port2.on("message", receive);
    channel.port2.postMessage({ type: "write-lease-sql", leaseId, operationId: id, operation });
    return promise;
  };
  return { host, channel, sender };
}



test("lazy Drizzle run stays inside remote write lease and releases it for next writer", async () => withDatabase(async (path) => {
  const native = createClient({ url: `file:${path}` });
  await native.execute("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)");
  let worker: Worker | undefined;
  let workerExit: Promise<number> | undefined;
  let exited = false;
  const stopWriteAuthority = installDatabaseWriteAuthority();
  const waiting = deferred<void>();
  const removeHooks = installDatabaseWriteTestHooks({
    waiting(operation) { if (operation === "worker-sql-test-competing-writer") waiting.resolve(); },
  });
  let authority: DatabaseWriteLeaseAuthority | undefined;
  let competingWrite: Promise<unknown> | undefined;
  try {
    worker = new Worker(new URL("../fixtures/worker-sql-lease-worker.ts", import.meta.url));
    const activeWorker = worker;
    workerExit = waitForExit(activeWorker);
    void workerExit.catch(() => {});
    activeWorker.once("exit", () => { exited = true; });
    authority = createDatabaseWriteLeaseAuthority((message: WriteLeaseResponse) => activeWorker.postMessage(message), native);
    activeWorker.on("message", (message: WorkerTestMessage | WriteLeaseRequest) => {
      if (message.type.startsWith("write-lease-")) authority!.receive(message as WriteLeaseRequest);
    });
    await waitForWorkerMessage(activeWorker, "test-held", workerExit);

    const unauthorized = createDatabaseWorkerClient();
    await expect(unauthorized.execute("INSERT INTO entries VALUES (90, 'unauthorized')"))
      .rejects.toThrow("Worker SQL requires an active remote database write lease");

    competingWrite = withDatabaseWrite(
      () => native.execute("INSERT INTO entries VALUES (4, 'competing writer')"),
      undefined,
      "worker-sql-test-competing-writer",
    );
    void competingWrite.catch(() => {});
    await waitForSignal(waiting.promise, "competing writer admission", workerExit);
    expect((await native.execute("SELECT id FROM entries WHERE id = 4")).rows).toHaveLength(0);
    activeWorker.postMessage({ type: "test-release" });
    await competingWrite;
    await waitForWorkerMessage(activeWorker, "test-done", workerExit);
    expect(await workerExit).toBe(0);
    expect((await native.execute("SELECT id, value FROM entries ORDER BY id")).rows.map(({ id, value }) => [Number(id), value]))
      .toEqual([
        [1, "committed"],
        [2, "worker execute"],
        [3, "nested lazy Drizzle"],
        [4, "competing writer"],
        [5, "after rejected SQL"],
      ]);
  } finally {
    removeHooks();
    if (worker && !exited) {
      await worker.terminate();
      await workerExit?.catch(() => {});
    }
    await authority?.workerExited();
    await competingWrite?.catch(() => {});
    await stopWriteAuthority();
    await native.close();
  }
}));

describe("worker SQL native transport", () => {
  test("preserves rows, metadata, blobs, bigint IDs and JSON over MessageChannel", async () => withDatabase(async (path) => {
    const native = createClient({ url: `file:${path}`, intMode: "bigint" });
    const parent = createClient({ url: `file:${path}`, intMode: "bigint" });
    const { host, channel, sender } = channelFor(parent, "lease-results");
    try {
      await native.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, label TEXT, payload BLOB, amount INTEGER)");
      const worker = createWorkerSqlClient(() => sender);
      const inserted = await worker.execute({ sql: "INSERT INTO sample(label, payload, amount) VALUES (?, ?, ?)", args: ["row", new Uint8Array([0, 255, 7]), 9007199254740993n] });
      expect(inserted.rowsAffected).toBe(1);
      expect(inserted.lastInsertRowid).toBe(1n);
      const result = await worker.execute("SELECT id, label, payload, amount FROM sample");
      expect(result.columns).toEqual(["id", "label", "payload", "amount"]);
      expect(result.columnTypes).toHaveLength(4);
      expect(result.rows[0][0]).toBe(1n);
      expect(result.rows[0].id).toBe(1n);
      expect(result.rows[0].label).toBe("row");
      expect(Array.from(new Uint8Array(result.rows[0].payload as ArrayBuffer))).toEqual([0, 255, 7]);
      expect(result.rows[0].amount).toBe(9007199254740993n);
      expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(JSON.stringify(await native.execute("SELECT id, label, payload, amount FROM sample"))));
      const reservedNames = 'SELECT 42 AS length, 7 AS "0", 9 AS "__proto__", 1 AS label, 2 AS label';
      const expectedRow = (await native.execute(reservedNames)).rows[0];
      const transportedRow = (await worker.execute(reservedNames)).rows[0];
      expect(transportedRow.length).toBe(expectedRow.length);
      expect(Array.from(transportedRow)).toEqual(Array.from(expectedRow));
      expect({ ...transportedRow }).toEqual({ ...expectedRow });
      await worker.close();
    } finally { channel.port1.close(); channel.port2.close(); await host.close(); await parent.close(); await native.close(); }
  }));

  test("commits and rolls back actual native transaction writes; SQL failure leaves channel usable", async () => withDatabase(async (path) => {
    const native = createClient({ url: `file:${path}` });
    const parent = createClient({ url: `file:${path}` });
    const { host, channel, sender } = channelFor(parent, "lease-tx");
    try {
      await native.execute("CREATE TABLE writes (value TEXT UNIQUE)");
      const worker = createWorkerSqlClient(() => sender);
      const committed = await worker.transaction("write");
      await committed.execute("INSERT INTO writes VALUES ('committed')");
      await committed.commit();
      expect((await native.execute("SELECT value FROM writes")).rows.map((row) => row.value)).toEqual(["committed"]);
      const rolledBack = await worker.transaction("write");
      await rolledBack.execute("INSERT INTO writes VALUES ('rolled-back')");
      await rolledBack.rollback();
      expect((await native.execute("SELECT value FROM writes ORDER BY value")).rows.map((row) => row.value)).toEqual(["committed"]);
      const failed = await worker.transaction("write");
      const failure = await failed.execute("INSERT INTO writes VALUES ('committed')").then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ code: "SQLITE_CONSTRAINT", extendedCode: "SQLITE_CONSTRAINT_UNIQUE" });
      await failed.rollback();
      await worker.execute("INSERT INTO writes VALUES ('after-error')");
      expect((await native.execute("SELECT value FROM writes ORDER BY value")).rows.map((row) => row.value)).toEqual(["after-error", "committed"]);
      await worker.close();
    } finally { channel.port1.close(); channel.port2.close(); await host.close(); await parent.close(); await native.close(); }
  }));

  test("rejects foreign or closed lease and transaction IDs without mutating data", async () => withDatabase(async (path) => {
    const native = createClient({ url: `file:${path}` });
    const parent = createClient({ url: `file:${path}` });
    const host = createWorkerSqlHost(parent);
    host.openLease("owner");
    host.openLease("other");
    try {
      await native.execute("CREATE TABLE writes (value TEXT)");
      const begun = await host.receive({ type: "write-lease-sql", leaseId: "owner", operationId: 1, operation: { type: "begin", mode: "write" } });
      expect(begun.type).toBe("write-lease-sql-result");
      if (begun.type !== "write-lease-sql-result") throw new Error("begin failed");
      if (typeof begun.value !== "number") throw new Error("begin did not return a numeric transaction ID");
      const transactionId = begun.value;
      const foreign = await host.receive({ type: "write-lease-sql", leaseId: "other", operationId: 1, operation: { type: "execute", statement: { sql: "INSERT INTO writes VALUES ('foreign')" , args: [] }, transactionId } });
      expect(foreign.type).toBe("write-lease-sql-error");
      await host.closeLease("owner");
      const closed = await host.receive({ type: "write-lease-sql", leaseId: "owner", operationId: 2, operation: { type: "execute", statement: { sql: "INSERT INTO writes VALUES ('closed')", args: [] } } });
      expect(closed.type).toBe("write-lease-sql-error");
      expect((await native.execute("SELECT count(*) AS n FROM writes")).rows[0].n).toBe(0);
    } finally { await host.close(); await parent.close(); await native.close(); }
  }));

  test("duplicate operation IDs do not execute twice; lease close rolls back before next native writer", async () => withDatabase(async (path) => {
    const native = createClient({ url: `file:${path}` });
    const parent = createClient({ url: `file:${path}` });
    const host = createWorkerSqlHost(parent);
    host.openLease("lease");
    try {
      await native.execute("CREATE TABLE writes (value TEXT)");
      const begin = await host.receive({ type: "write-lease-sql", leaseId: "lease", operationId: 1, operation: { type: "begin", mode: "write" } });
      if (begin.type !== "write-lease-sql-result") throw new Error("begin failed");
      if (typeof begin.value !== "number") throw new Error("begin did not return a numeric transaction ID");
      const transactionId = begin.value;
      const request: WorkerSqlRequest = { type: "write-lease-sql", leaseId: "lease", operationId: 2, operation: { type: "execute", statement: { sql: "INSERT INTO writes VALUES ('once')", args: [] }, transactionId } };
      const first = await host.receive(request);
      await host.receive(request);
      expect(first.type).toBe("write-lease-sql-result");
      const inside = await host.receive({ type: "write-lease-sql", leaseId: "lease", operationId: 3, operation: { type: "execute", statement: "SELECT COUNT(*) FROM writes", transactionId } });
      expect(inside.type).toBe("write-lease-sql-result");
      if (inside.type === "write-lease-sql-result") expect(inside.value).toMatchObject({ rows: [[1]] });
      await host.closeLease("lease");
      await native.execute("INSERT INTO writes VALUES ('next-writer')");
      expect((await native.execute("SELECT value FROM writes ORDER BY value")).rows.map((row) => row.value)).toEqual(["next-writer"]);
      await host.close();
      await parent.execute("INSERT INTO writes VALUES ('parent-alive')");
      expect((await native.execute("SELECT value FROM writes ORDER BY value")).rows.map((row) => row.value)).toEqual(["next-writer", "parent-alive"]);
    } finally { await host.close(); await parent.close(); await native.close(); }
  }));
});
