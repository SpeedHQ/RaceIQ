import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { createLiveCaptureWorker } from "../../src/session-capture/live-worker-factory";

let ownedWorker: Worker | undefined;
let ownedRoot: string | undefined;
afterEach(async () => {
  await ownedWorker?.terminate();
  if (ownedRoot) await rm(ownedRoot, { recursive: true, force: true });
  ownedWorker = undefined;
  ownedRoot = undefined;
});

test("empty production derivation closes without creating canonical or archive files", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-live-empty-close-"));
  ownedRoot = root;
  const sourcePath = join(root, "source.bin"), archivePath = join(root, "capture.bin.gz");
  const captureEpoch = randomUUID();
  const worker = createLiveCaptureWorker("fm-2023");
  ownedWorker = worker;
  const closed = new Promise<void>((resolve, reject) => {
    worker.on("error", reject);
    worker.on("exit", () => reject(new Error("Worker exited before capture close")));
    worker.on("message", (message: { type?: string; captureEpoch?: string; message?: string }) => {
      if (message.captureEpoch !== captureEpoch) return;
      if (message.type === "live-started") worker.postMessage({ type: "close-live", captureEpoch, sequence: 1, sourceByteOffset: 0 });
      if (message.type === "live-sealed") resolve();
      if (message.type === "live-failed") reject(new Error(message.message));
    });
  });
  worker.postMessage({ type: "start-live", captureEpoch, attempt: randomUUID(), sessionId: 1,
    sourcePath, archivePath, maxQueuedBytes: 1024 * 1024, maxUnresolvedBytes: 1024 * 1024 });
  await closed;
  expect(await Bun.file(sourcePath).exists()).toBe(false);
  expect(await Bun.file(archivePath).exists()).toBe(false);
}, 5_000);
