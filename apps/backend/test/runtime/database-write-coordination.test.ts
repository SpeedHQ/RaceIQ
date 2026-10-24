import { afterEach, describe, expect } from "bun:test";
import { createClient, type Client, type Transaction } from "@libsql/client/sqlite3";
import type { TransactionMode } from "@libsql/client";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import {
  configureDatabaseWriteWorkerTransport,
  createDatabaseWriteLeaseAuthority,
  installDatabaseWriteAuthority,
  withDatabaseTransaction,
  withDatabaseWrite,
  type WriteLeaseRequest,
  type WriteLeaseResponse,
} from "@raceiq/backend-core/db/write-coordination";
import { nativeDatabaseTest } from "../support/native-database-test";

const test = nativeDatabaseTest(import.meta.path);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Grant = Extract<WriteLeaseResponse, { type: "write-lease-granted" }>;

let stopAuthority: (() => Promise<void>) | undefined;
let disconnect: (() => void) | undefined;
afterEach(async () => {
  disconnect?.();
  disconnect = undefined;
  await stopAuthority?.();
  stopAuthority = undefined;
});

describe("database write lease bridge", () => {
  test("worker release unlocks a subsequent HTTP writer; duplicate release cannot unlock another owner", async () => {
    stopAuthority = installDatabaseWriteAuthority();
    const first = deferred<Grant>();
    const second = deferred<Grant>();
    const authority = createDatabaseWriteLeaseAuthority((message) => {
      if (message.type === "write-lease-granted") (message.requestId === 1 ? first : second).resolve(message);
    });
    authority.receive({ type: "write-lease-acquire", requestId: 1 });
    const grant = await first.promise;
    authority.receive({ type: "write-lease-release", leaseId: grant.leaseId });
    await withDatabaseWrite(async () => {});
    authority.receive({ type: "write-lease-acquire", requestId: 2 });
    const next = await second.promise;
    let entered = false;
    const write = withDatabaseWrite(async () => { entered = true; });
    authority.receive({ type: "write-lease-release", leaseId: grant.leaseId });
    expect(entered).toBe(false);
    authority.receive({ type: "write-lease-release", leaseId: next.leaseId });
    await write;
    expect(entered).toBe(true);
    // A delayed duplicate acquire must not create an unused lease.
    authority.receive({ type: "write-lease-acquire", requestId: 1 });
    await withDatabaseWrite(async () => {});
    await authority.stop();
  });

  test("cancellation during grant releases an unused lease and admits the next request", async () => {
    stopAuthority = installDatabaseWriteAuthority();
    const entered = deferred<void>();
    const finish = deferred<void>();
    const local = withDatabaseWrite(async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const grants: Grant[] = [];
    const next = deferred<Grant>();
    const authority = createDatabaseWriteLeaseAuthority((message) => {
      if (message.type === "write-lease-granted") { grants.push(message); next.resolve(message); }
    });
    try {
      authority.receive({ type: "write-lease-acquire", requestId: 1 });
      authority.receive({ type: "write-lease-acquire", requestId: 1 });
      authority.receive({ type: "write-lease-cancel", requestId: 1 });
      authority.receive({ type: "write-lease-acquire", requestId: 2 });
      finish.resolve();
      await local;
      const grant = await next.promise;
      expect(grants.map((value) => value.requestId)).toEqual([2]);
      authority.receive({ type: "write-lease-release", leaseId: grant.leaseId });
      await withDatabaseWrite(async () => {});
      await authority.stop();
    } finally { finish.resolve(); await local; authority.workerExited(); }
  });

  test("cancellation after parent grant but before worker use releases ownership", async () => {
    stopAuthority = installDatabaseWriteAuthority();
    const granted = deferred<Grant>();
    const authority = createDatabaseWriteLeaseAuthority((message) => { if (message.type === "write-lease-granted") granted.resolve(message); });
    authority.receive({ type: "write-lease-acquire", requestId: 1 });
    const grant = await granted.promise;
    authority.receive({ type: "write-lease-cancel", requestId: 1 });
    authority.receive({ type: "write-lease-release", leaseId: grant.leaseId });
    await withDatabaseWrite(async () => {});
    await authority.stop();
  });

  test("bridge stop rejects an acquisition already waiting inside the shared authority", async () => {
    stopAuthority = installDatabaseWriteAuthority();
    const entered = deferred<void>();
    const finish = deferred<void>();
    const local = withDatabaseWrite(async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const rejected = deferred<string>();
    const grants: Grant[] = [];
    const authority = createDatabaseWriteLeaseAuthority((message) => {
      if (message.type === "write-lease-rejected") rejected.resolve(message.reason);
      if (message.type === "write-lease-granted") grants.push(message);
    });
    try {
      authority.receive({ type: "write-lease-acquire", requestId: 1 });
      let drained = false;
      const stopped = authority.stop().then(() => { drained = true; });
      expect(await rejected.promise).toContain("stopping");
      expect(drained).toBe(false);
      finish.resolve();
      await Promise.all([local, stopped]);
      expect(grants).toEqual([]);
      await withDatabaseWrite(async () => {});
      expect(drained).toBe(true);
    } finally { finish.resolve(); await local; authority.workerExited(); }
  });

  test("stopping local admission rejects queued worker request without stranding the drain", async () => {
    stopAuthority = installDatabaseWriteAuthority();
    const entered = deferred<void>();
    const finish = deferred<void>();
    const local = withDatabaseWrite(async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const rejected = deferred<string>();
    const authority = createDatabaseWriteLeaseAuthority((message) => { if (message.type === "write-lease-rejected") rejected.resolve(message.reason); });
    try {
      // receive synchronously enters localAcquire before returning.
      authority.receive({ type: "write-lease-acquire", requestId: 1 });
      const stop = stopAuthority();
      expect(stopAuthority()).toBe(stop);
      expect(await rejected.promise).toContain("stopping");
      let drained = false;
      void stop.then(() => { drained = true; });
      expect(drained).toBe(false);
      finish.resolve();
      await Promise.all([local, stop, authority.stop()]);
      expect(drained).toBe(true);
    } finally { finish.resolve(); await local; authority.workerExited(); }
  });

  for (const phase of ["queued", "granted"] as const) {
    test(`actual worker exit releases ${phase} admission only after its owner is gone`, async () => {
      stopAuthority = installDatabaseWriteAuthority();
      const entered = deferred<void>();
      const finish = deferred<void>();
      const local = phase === "queued" ? withDatabaseWrite(async () => { entered.resolve(); await finish.promise; }) : Promise.resolve();
      if (phase === "queued") await entered.promise;
      const grant = deferred<Grant>();
      const authority = createDatabaseWriteLeaseAuthority((message) => { if (message.type === "write-lease-granted") grant.resolve(message); });
      try {
        authority.receive({ type: "write-lease-acquire", requestId: 1 });
        if (phase === "granted") await grant.promise;
        authority.workerExited();
        finish.resolve();
        await local;
        await authority.stop();
        await withDatabaseWrite(async () => {});
      } finally { finish.resolve(); await local; authority.workerExited(); }
    });
  }

  test("another worker authority cannot release a lease it does not own", async () => {
    stopAuthority = installDatabaseWriteAuthority();
    const granted = deferred<Grant>();
    const owner = createDatabaseWriteLeaseAuthority((message) => { if (message.type === "write-lease-granted") granted.resolve(message); });
    const stranger = createDatabaseWriteLeaseAuthority(() => {});
    owner.receive({ type: "write-lease-acquire", requestId: 1 });
    const lease = await granted.promise;
    let wrote = false;
    const write = withDatabaseWrite(async () => { wrote = true; });
    stranger.receive({ type: "write-lease-release", leaseId: lease.leaseId });
    expect(wrote).toBe(false);
    owner.receive({ type: "write-lease-release", leaseId: lease.leaseId });
    await write;
    expect(wrote).toBe(true);
    await Promise.all([owner.stop(), stranger.stop()]);
  });
});

describe("worker-side admission", () => {
  test("abort racing an immediate grant releases the unused lease before any write", async () => {
    const controller = new AbortController();
    const messages: WriteLeaseRequest[] = [];
    let listener: ((message: WriteLeaseResponse) => void) | undefined;
    let writes = 0;
    disconnect = configureDatabaseWriteWorkerTransport({
      subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
      request(message) {
        messages.push(message);
        if (message.type === "write-lease-acquire") {
          listener?.({ type: "write-lease-granted", requestId: message.requestId, leaseId: "unused-grant" });
          controller.abort(new Error("stopped before lease use"));
        } else if (message.type === "write-lease-release") {
          listener?.({ type: "write-lease-released", leaseId: message.leaseId });
        }
      },
    });
    await expect(withDatabaseWrite(async () => { writes++; }, controller.signal)).rejects.toThrow("stopped before lease use");
    expect(writes).toBe(0);
    expect(messages.filter((message) => message.type === "write-lease-release")).toEqual([{ type: "write-lease-release", leaseId: "unused-grant" }]);
    expect(listener).toBeUndefined();
  });

  test("channel loss rejects pending work and blocks subsequent writes without local fallback", async () => {
    const requested = deferred<void>();
    let listener: ((message: WriteLeaseResponse) => void) | undefined;
    let writes = 0;
    disconnect = configureDatabaseWriteWorkerTransport({
      subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
      request(message) { if (message.type === "write-lease-acquire") requested.resolve(); },
    });
    const waiting = withDatabaseWrite(async () => { writes++; });
    await requested.promise;
    listener?.({ type: "write-lease-channel-closed", reason: "parent channel closed" });
    await expect(waiting).rejects.toThrow("parent channel closed");
    await expect(withDatabaseWrite(async () => { writes++; })).rejects.toThrow("authority unavailable");
    expect(writes).toBe(0);
    expect(listener).toBeUndefined();
  });
});

async function databaseFixture() {
  const directory = await mkdtemp(join(process.env.RACEIQ_NATIVE_DB_ROOT!, "write-resource-"));
  const client = createClient({ url: `file:${join(directory, "test.db")}` });
  await client.executeMultiple("PRAGMA foreign_keys=ON; CREATE TABLE entries(id INTEGER PRIMARY KEY); CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);");
  return {
    client,
    close() { client.close(); },
  };
}

describe("native write transaction settlement", () => {
  test("precommit interruption rolls back before the next writer can persist", async () => {
    stopAuthority = installDatabaseWriteAuthority();
    const fixture = await databaseFixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const active = withDatabaseTransaction(fixture.client, async (tx) => { await tx.execute("INSERT INTO entries VALUES(1)"); entered.resolve(); await release.promise; }, { signal: controller.signal });
    try {
      await entered.promise;
      const next = withDatabaseWrite(() => fixture.client.execute("INSERT INTO entries VALUES(2)"));
      controller.abort(new Error("cancel before commit"));
      release.resolve();
      await expect(active).rejects.toThrow("cancel before commit");
      await next;
      expect((await fixture.client.execute("SELECT id FROM entries ORDER BY id")).rows.map((row) => Number(row.id))).toEqual([2]);
    } finally { release.resolve(); await active.catch(() => {}); await fixture.close(); }
  });

  test("a failed transaction begin releases its permit", async () => {
    stopAuthority = installDatabaseWriteAuthority();
    const fixture = await databaseFixture();
    const closed = createClient({ url: ":memory:" });
    closed.close();
    try {
      await expect(withDatabaseTransaction(closed, async () => 1)).rejects.toThrow();
      await withDatabaseTransaction(fixture.client, (tx) => tx.execute("INSERT INTO entries VALUES(2)"));
      expect((await fixture.client.execute("SELECT id FROM entries")).rows.map((row) => Number(row.id))).toEqual([2]);
    } finally { await fixture.close(); }
  });

  test("deferred constraint failure at commit rolls back all uncommitted rows", async () => {
    stopAuthority = installDatabaseWriteAuthority();
    const fixture = await databaseFixture();
    try {
      await expect(withDatabaseTransaction(fixture.client, async (tx) => {
        await tx.execute("INSERT INTO entries VALUES(1)");
        await tx.execute("INSERT INTO children VALUES(99)");
      })).rejects.toThrow();
      expect((await fixture.client.execute("SELECT id FROM entries")).rows).toEqual([]);
      expect((await fixture.client.execute("SELECT parent_id FROM children")).rows).toEqual([]);
      await withDatabaseTransaction(fixture.client, async (tx) => { await tx.execute("INSERT INTO parents VALUES(99)"); await tx.execute("INSERT INTO children VALUES(99)"); });
      expect((await fixture.client.execute("SELECT parent_id FROM children")).rows.map((row) => Number(row.parent_id))).toEqual([99]);
    } finally { await fixture.close(); }
  });

  for (const cleanupAt of ["rollback", "close"] as const) {
    test(`${cleanupAt} failure preserves original statement failure and closes before releasing`, async () => {
      stopAuthority = installDatabaseWriteAuthority();
      const fixture = await databaseFixture();
      const begin: Client["transaction"] = fixture.client.transaction.bind(fixture.client);
      const primary = new Error("authoritative statement failure");
      fixture.client.transaction = async (mode?: TransactionMode) => {
        const tx = await begin(mode);
        const close = tx.close.bind(tx);
        if (cleanupAt === "rollback") tx.rollback = async () => { throw new Error("injected rollback cleanup failure"); };
        else tx.close = () => { close(); throw new Error("injected close cleanup failure"); };
        return tx;
      };
      try {
        let failure: unknown;
        try { await withDatabaseTransaction(fixture.client, async (tx) => { await tx.execute("INSERT INTO entries VALUES(1)"); throw primary; }); }
        catch (error) { failure = error; }
        expect(failure).toBe(primary);
        fixture.client.transaction = begin;
        await withDatabaseTransaction(fixture.client, (tx) => tx.execute("INSERT INTO entries VALUES(2)"));
        expect((await fixture.client.execute("SELECT id FROM entries")).rows.map((row) => Number(row.id))).toEqual([2]);
      } finally { fixture.client.transaction = begin; await fixture.close(); }
    });
  }

  test("late interruption after real commit returns settled success without rollback", async () => {
    stopAuthority = installDatabaseWriteAuthority();
    const fixture = await databaseFixture();
    const begin: Client["transaction"] = fixture.client.transaction.bind(fixture.client);
    const controller = new AbortController();
    let rollbacks = 0;
    fixture.client.transaction = async (mode?: TransactionMode) => {
      const tx: Transaction = await begin(mode);
      const commit = tx.commit.bind(tx);
      const rollback = tx.rollback.bind(tx);
      tx.commit = async () => { await commit(); controller.abort(); };
      tx.rollback = async () => { rollbacks++; await rollback(); };
      return tx;
    };
    try {
      expect(await withDatabaseTransaction(fixture.client, async (tx) => { await tx.execute("INSERT INTO entries VALUES(7)"); return 7; }, { signal: controller.signal })).toBe(7);
      expect(rollbacks).toBe(0);
      expect((await fixture.client.execute("SELECT id FROM entries")).rows.map((row) => Number(row.id))).toEqual([7]);
    } finally { fixture.client.transaction = begin; await fixture.close(); }
  });

  test("nested write helpers reuse the lease and supplied executor", async () => {
    stopAuthority = installDatabaseWriteAuthority();
    const fixture = await databaseFixture();
    try {
      await withDatabaseTransaction(fixture.client, async (tx) => {
        await withDatabaseWrite(() => tx.execute("INSERT INTO entries VALUES(1)"));
        await withDatabaseWrite(() => tx.execute("INSERT INTO entries VALUES(2)"));
      });
      expect((await fixture.client.execute("SELECT id FROM entries ORDER BY id")).rows.map((row) => Number(row.id))).toEqual([1, 2]);
    } finally { await fixture.close(); }
  });
});
