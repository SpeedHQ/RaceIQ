import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openLiveCaptureArchive, openLiveCaptureMember } from "../src/archive";
import type { LiveArchiveIndex, LiveArchiveMember, LiveArchiveSnapshot } from "../src/contract";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raceiq-live-archive-"));
  const path = join(root, "capture.bin.gz");
  const first = gzipSync(Buffer.from("first committed payload"));
  const second = gzipSync(Buffer.from("second committed payload"));
  const member = (id: string, entryName: string, memberOffset: number, compressedByteLength: number, generation: number): LiveArchiveMember => ({
    id, kind: "auxiliary", entryName, memberOffset, compressedByteLength, byteLength: id === "first" ? 23 : 24,
    firstOrdinal: generation - 1, recordCount: 1, sourceStart: generation - 1, sourceEnd: generation,
    sourceByteStart: generation - 1, sourceByteEnd: generation, generation,
  });
  const firstMember = member("first", "first.bin", 0, first.length, 1);
  const secondMember = member("second", "second.bin", first.length, second.length, 2);
  const common = {
    version: 5 as const, gameId: "fm-2023" as const, captureEpoch: "epoch", attempt: "attempt",
    generation: 2, committedArchiveLength: first.length + second.length,
    sourceDurableWatermark: 2, metadataDurableWatermark: 2, sourceRevision: "revision",
    sourceByteLength: 2, sourceRecordCount: 2, archiveFile: "capture.bin.gz" as const, sealed: false,
  };
  const index: LiveArchiveIndex = { ...common, members: [firstMember, secondMember] };
  const snapshot: LiveArchiveSnapshot = { ...common, member: secondMember };
  writeFileSync(path, Buffer.concat([first, second, Buffer.from("uncommitted crash suffix")]));
  return { root, path, first, second, firstMember, secondMember, index, snapshot };
}

test("live archive snapshots expose only contiguous committed gzip members", async () => {
  const { root, path, index } = fixture();
  try {
    const archive = await openLiveCaptureArchive(path, index);
    expect(await archive.readEntryBuffer("first.bin", 64)).toEqual(Buffer.from("first committed payload"));
    expect(await archive.readEntryBuffer("second.bin", 64)).toEqual(Buffer.from("second committed payload"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("live member snapshot reads one DB-fenced member without earlier member rows", async () => {
  const { root, path, snapshot } = fixture();
  try {
    const archive = await openLiveCaptureMember(path, snapshot);
    expect(await archive.readEntryBuffer("second.bin", 64)).toEqual(Buffer.from("second committed payload"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("live snapshots reject uncommitted or truncated archive prefixes", async () => {
  const { root, path, index } = fixture();
  try {
    await expect(openLiveCaptureArchive(path, { ...index, committedArchiveLength: statSync(path).size + 1 })).rejects.toThrow();
    writeFileSync(path, Buffer.concat([gzipSync(Buffer.from("first committed payload")), Buffer.from([0x1f, 0x8b])]));
    await expect(openLiveCaptureArchive(path, index)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
