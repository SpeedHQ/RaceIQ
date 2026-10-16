import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrameLength } from "@raceiq/capture-formats/session/framing";
import { FileStreamingSplitterHost } from "../src/streaming-host";

function host(root: string, archivePath = join(root, "archive.gz")) {
  return new FileStreamingSplitterHost({
    archivePath, maxQueuedBytes: 1024, maxUnresolvedBytes: 2048,
    commit: async () => undefined,
  });
}

test("prepared stage is open and replenishes one bounded gzip stage and position journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-prepared-host-"));
  const fileHost = host(root);
  try {
    const staging = join(root, ".live-staging");
    const first = await fileHost.createStage("lap", "lap-1");
    await first.append(Buffer.concat([encodeFrameLength(9), Buffer.from("first lap")]));
    await first.close();
    expect((await Array.fromAsync(first.readRecords())).map((record) => record.kind === "frame" ? record.frame.toString() : record.kind)).toEqual(["first lap"]);
    await first.discard();
    const second = await fileHost.createStage("auxiliary", "aux-1");
    await second.append(Buffer.concat([encodeFrameLength(10), Buffer.from("second lap")]));
    await second.close();
    expect((await Array.fromAsync(second.readRecords())).map((record) => record.kind === "frame" ? record.frame.toString() : record.kind)).toEqual(["second lap"]);
    await second.discard();
    const spool = await fileHost.createPositionSpool();
    await spool.append({ offset: 2, endOffset: 5, ordinal: 1 });
    expect(await Array.fromAsync(spool.positions())).toEqual([{ offset: 2, endOffset: 5, ordinal: 1 }]);
    await spool.discard();
    await fileHost.dispose();
    expect(await readdir(staging)).toEqual([]);
  } finally {
    await fileHost.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("dispose waits for prewarm and removes unused stage and journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-prepared-dispose-"));
  const fileHost = host(root);
  await Promise.all([fileHost.dispose(), fileHost.dispose()]);
  expect(await readdir(join(root, ".live-staging"))).toEqual([]);
  await rm(root, { recursive: true, force: true });
});

test("failed staging destination rejects createStage and leaves no prepared artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "raceiq-prepared-failure-"));
  const blocker = join(root, "not-a-directory");
  await writeFile(blocker, "blocker");
  const fileHost = host(root, join(blocker, "archive.gz"));
  await expect(fileHost.createStage("lap", "lap-1")).rejects.toThrow();
  await expect(fileHost.dispose()).rejects.toThrow("Failed to dispose prepared streaming resources");
  await expect(fileHost.dispose()).rejects.toThrow("Failed to dispose prepared streaming resources");
  expect(await readdir(root)).toEqual(["not-a-directory"]);
  await rm(root, { recursive: true, force: true });
});
