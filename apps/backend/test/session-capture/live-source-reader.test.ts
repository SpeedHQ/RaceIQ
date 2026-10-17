import { expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decompressIfGzipSync, iterateSessionCaptureRecords, type SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { LiveCanonicalSourceReader } from "../../src/session-capture/live-source-reader";

async function recording() {
  const root = await mkdtemp(join(tmpdir(), "raceiq-live-source-reader-"));
  const path = join(root, "capture.bin");
  const fixture = decompressIfGzipSync(await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions/fm-2023-with-pitting.bin.gz")));
  const frames: Buffer[] = [];
  for (const record of iterateSessionCaptureRecords(fixture)) {
    if (record.kind === "frame") frames.push(record.frame);
    if (frames.length === 140) break;
  }
  const writer = new SparseSessionRecorder("fm-2023");
  writer.start(path);
  writer.writeMetaFrame();
  let boundaryOffset = 0;
  for (let index = 0; index < frames.length; index++) {
    if (index === 70) { boundaryOffset = writer.getCurrentByteOffset(); writer.writeSegmentBoundary(); }
    writer.writeRecord(frames[index]!, index % 2 === 0 ? undefined : index * 10);
  }
  await writer.stop();
  const info = await stat(path, { bigint: true });
  return { root, path, frames, boundaryOffset, length: Number(info.size), identity: { device: String(info.dev), inode: String(info.ino) } };
}

test("canonical catch-up keeps its descriptor open across sparse seek batches and preserves source records", async () => {
  const input = await recording();
  const reader = new LiveCanonicalSourceReader(input.path, input.identity);
  try {
    const records: SessionCaptureRecord[] = [];
    let offset = 0;
    while (offset < input.length) {
      const batch = await reader.readBatch(offset, input.length, 64 * 1024, 17);
      expect(batch.nextOffset).toBeGreaterThan(offset);
      records.push(...batch.records);
      offset = batch.nextOffset;
    }
    const frames = records.filter((record) => record.kind === "frame");
    expect(frames.map((record) => record.frame)).toEqual(input.frames);
    expect(frames.map((record) => record.frameTimeMs)).toEqual(input.frames.map((_, index) => index % 2 === 0 ? undefined : index * 10));
    expect(records.filter((record) => record.kind === "segment-boundary").map((record) => record.offset)).toEqual([input.boundaryOffset]);
  } finally { await reader.close(); await rm(input.root, { recursive: true, force: true }); }
});

test("canonical seek after first native frame preserves the following sparse marker and deltas", async () => {
  const input = await recording();
  const reader = new LiveCanonicalSourceReader(input.path, input.identity);
  try {
    const first = await reader.readBatch(0, input.length, 64 * 1024, 1);
    const resumed = await reader.readBatch(first.nextOffset, input.length, 64 * 1024, 5);
    const frames = resumed.records.filter((record) => record.kind === "frame");
    expect(frames.map((record) => record.frame)).toEqual(input.frames.slice(1, 6));
    expect(frames.map((record) => record.frameTimeMs)).toEqual([10, undefined, 30, undefined, 50]);
  } finally { await reader.close(); await rm(input.root, { recursive: true, force: true }); }
});

test("canonical catch-up rejects replacement before its first read, using writer identity", async () => {
  const input = await recording();
  const reader = new LiveCanonicalSourceReader(input.path, input.identity);
  try {
    await rename(input.path, `${input.path}.original`);
    await writeFile(input.path, await readFile(`${input.path}.original`));
    await expect(reader.readBatch(0, input.length, 64 * 1024, 17)).rejects.toThrow();
  } finally { await reader.close(); await rm(input.root, { recursive: true, force: true }); }
});
