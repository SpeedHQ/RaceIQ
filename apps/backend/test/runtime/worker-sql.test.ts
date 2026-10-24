import { describe, expect } from "bun:test";
import { createClient, type Client } from "@libsql/client/sqlite3";
import { createWorkerSqlClient, createWorkerSqlHost, type WorkerSqlOperation, type WorkerSqlRequest, type WorkerSqlResponse, type WorkerSqlSender } from "@raceiq/backend-core/db/worker-sql";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { nativeDatabaseTest } from "../support/native-database-test";

const test = nativeDatabaseTest(import.meta.path);

async function withDatabase(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(process.env.RACEIQ_NATIVE_DB_ROOT!, "worker-sql-"));
  await run(join(directory, "database.sqlite"));
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
