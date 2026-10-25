import { parentPort } from "node:worker_threads";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { createDatabaseWorkerClient, configureDatabaseWriteWorkerTransport, withDatabaseWrite, type WriteLeaseRequest, type WriteLeaseResponse } from "@raceiq/backend-core/db/write-coordination";

if (!parentPort) throw new Error("Worker SQL lease fixture requires a parent port");

const leaseListeners = new Set<(message: WriteLeaseResponse) => void>();
const disconnect = configureDatabaseWriteWorkerTransport({
  request: (message: WriteLeaseRequest) => parentPort!.postMessage(message),
  subscribe(listener) { leaseListeners.add(listener); return () => { leaseListeners.delete(listener); }; },
});
const { promise: releasePromise, resolve: releaseOuterWrite } = Promise.withResolvers<void>();
const worker = createDatabaseWorkerClient();
const db = drizzle(worker);

parentPort.on("message", (message: WriteLeaseResponse | { type: "test-release" }) => {
  if (message.type === "test-release") releaseOuterWrite();
  else for (const listener of leaseListeners) listener(message);
});
parentPort.on("close", () => {
  for (const listener of leaseListeners) listener({ type: "write-lease-channel-closed", reason: "Worker SQL test channel closed" });
});

async function run() {
  try {
    await withDatabaseWrite(() => db.run(sql`INSERT INTO entries (id, value) VALUES (1, 'committed')`));
    await withDatabaseWrite(async () => {
      await worker.execute("INSERT INTO entries (id, value) VALUES (2, 'worker execute')");
      await withDatabaseWrite(() => db.run(sql`INSERT INTO entries (id, value) VALUES (3, 'nested lazy Drizzle')`));
      parentPort!.postMessage({ type: "test-held" });
      await releasePromise;
    });

    let duplicateRejected = false;
    try {
      await withDatabaseWrite(() => db.run(sql`INSERT INTO entries (id, value) VALUES (1, 'duplicate')`));
    } catch {
      duplicateRejected = true;
    }
    if (!duplicateRejected) throw new Error("Duplicate-key Drizzle SQL unexpectedly succeeded");
    await withDatabaseWrite(() => worker.execute("INSERT INTO entries (id, value) VALUES (5, 'after rejected SQL')"));

    try {
      await worker.execute("INSERT INTO entries (id, value) VALUES (6, 'post-release unauthorized')");
      throw new Error("Post-release SQL unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Worker SQL requires an active remote database write lease") throw error;
    }
    parentPort!.postMessage({ type: "test-done" });
  } catch (error) {
    parentPort!.postMessage({ type: "test-error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    disconnect();
    parentPort!.close();
  }
}

void run();
