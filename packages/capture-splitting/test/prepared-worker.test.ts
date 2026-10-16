import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveWorkJournal } from "../src/live-work-journal";
import { registerLiveSplitterWorker } from "../src/live-worker";

test("disposing during journal creation closes late-created storage without starting capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-prepared-worker-stop-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const journalClosed = Promise.withResolvers<void>();
  const sourceClosed = Promise.withResolvers<void>();
  const originalCreate = LiveWorkJournal.create;
  const messages: unknown[] = [];
  const { port1, port2 } = new MessageChannel();
  port2.on("message", (message: unknown) => { messages.push(message); });
  // Delay only creation timing; the journal, filesystem, host, and cleanup are real.
  LiveWorkJournal.create = async function<T>(...args: Parameters<typeof originalCreate>) {
    entered.resolve();
    await release.promise;
    const journal = await originalCreate<T>(...args);
    const close = journal.close.bind(journal);
    journal.close = async (remove = true) => {
      await close(remove);
      journalClosed.resolve();
    };
    return journal;
  };
  const stop = registerLiveSplitterWorker(port1, {
    gameId: "fm-2023",
    closeSourceReader: async () => { sourceClosed.resolve(); },
  });
  try {
    port2.postMessage({
      type: "start-live", captureEpoch: randomUUID(), attempt: randomUUID(), sessionId: 1,
      sourcePath: join(root, "source.bin"), archivePath: join(root, "capture.bin.gz"),
      maxQueuedBytes: 4096, maxUnresolvedBytes: 4096,
    });
    await entered.promise;
    stop();
    release.resolve();
    await Promise.all([journalClosed.promise, sourceClosed.promise]);
    expect(messages).toEqual([]);
    expect(await readdir(root)).toEqual([".live-staging"]);
    expect(await readdir(join(root, ".live-staging"))).toEqual([]);
  } finally {
    LiveWorkJournal.create = originalCreate;
    release.resolve();
    stop();
    port1.close();
    port2.close();
    await rm(root, { recursive: true, force: true });
  }
});
