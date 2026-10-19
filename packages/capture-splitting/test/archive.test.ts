import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openCaptureArchive } from "../src/archive";
import type { ArchiveManifest } from "../src/contract";

function fixture(members: Buffer[]): { root: string; path: string; manifest: ArchiveManifest } {
  const root = mkdtempSync(join(tmpdir(), "raceiq-gzip-archive-"));
  const path = join(root, "capture.bin.gz");
  const chunks = members.map((member, index) => ({
    id: `member-${index}`, kind: "auxiliary" as const, entryName: `member-${index}.bin`,
    memberOffset: members.slice(0, index).reduce((sum, value) => sum + value.length, 0),
    compressedByteLength: member.length, byteLength: Buffer.from(`payload-${index}`).length,
    firstOrdinal: index, recordCount: 1, sourceStart: index, sourceEnd: index + 1,
    sourceByteStart: index, sourceByteEnd: index + 1,
  }));
  writeFileSync(path, Buffer.concat(members));
  return { root, path, manifest: {
    version: 4, gameId: "fm-2023", sourceRevision: "test", sourceByteLength: 0,
    sourceRecordCount: members.length, archiveFile: "capture.bin.gz", chunks,
  } };
}

test("reads only selected member and validates its framing and checksum", async () => {
  const entries = [gzipSync(Buffer.from("payload-0")), gzipSync(Buffer.from("payload-1"))];
  const { root, path, manifest } = fixture(entries);
  try {
    const reads: string[] = [];
    const archive = await openCaptureArchive(path, manifest, { onDecompress: (name) => reads.push(name) });
    expect(await archive.readEntryBuffer("member-1.bin", 32)).toEqual(Buffer.from("payload-1"));
    expect(reads).toEqual(["member-1.bin"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects concatenated gzip members within one indexed range", async () => {
  const member = Buffer.concat([gzipSync(Buffer.from("payload-0")), gzipSync(Buffer.from("payload-1"))]);
  const { root, path, manifest } = fixture([member]);
  try {
    await expect((await openCaptureArchive(path, manifest)).readEntryBuffer("member-0.bin", 32)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects gaps and unindexed archive suffixes", async () => {
  const { root, path, manifest } = fixture([gzipSync(Buffer.from("payload-0")), gzipSync(Buffer.from("payload-1"))]);
  try {
    const invalid = { ...manifest, chunks: manifest.chunks.map((chunk, index) =>
      index === 1 ? { ...chunk, memberOffset: chunk.memberOffset + 1 } : chunk) };
    await expect(openCaptureArchive(path, invalid)).rejects.toThrow();
    writeFileSync(path, Buffer.concat([Buffer.from([0]), ...manifest.chunks.map((chunk) => gzipSync(Buffer.from(`payload-${chunk.firstOrdinal}`)))]));
    await expect(openCaptureArchive(path, manifest)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects unsafe indexes before reading any compressed payload", async () => {
  const { root, path, manifest } = fixture([gzipSync(Buffer.from("payload-0")), gzipSync(Buffer.from("payload-1"))]);
  try {
    const first = manifest.chunks[0]!;
    const invalidChunks = [
      { ...first, memberOffset: -1 },
      { ...first, memberOffset: Number.MAX_SAFE_INTEGER },
      { ...first, compressedByteLength: 17 },
      { ...first, compressedByteLength: 513 * 1024 * 1024 },
      { ...first, byteLength: 513 * 1024 * 1024 },
      { ...first, entryName: "../escape.bin" },
      { ...first, entryName: manifest.chunks[1]!.entryName },
      { ...first, id: manifest.chunks[1]!.id },
    ];
    for (const chunk of invalidChunks) {
      const reads: number[] = [];
      await expect(openCaptureArchive(path, { ...manifest, chunks: [chunk, manifest.chunks[1]!] }, {
        onRead: (_offset, length) => reads.push(length),
      })).rejects.toThrow();
      expect(reads).toEqual([]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects selected payload corruption, unsupported headers, and declared-size mismatches", async () => {
  for (const damage of ["checksum", "header", "size", "truncated"] as const) {
    const member = gzipSync(Buffer.from("payload-0"));
    if (damage === "checksum") member[member.length - 8]! ^= 1;
    if (damage === "header") member[3] = 1;
    const { root, path, manifest } = fixture([member]);
    try {
      if (damage === "truncated") writeFileSync(path, member.subarray(0, member.length - 1));
      const invalid = damage === "size"
        ? { ...manifest, chunks: [{ ...manifest.chunks[0]!, byteLength: 1 }] } : manifest;
      await expect((async () => (await openCaptureArchive(path, invalid)).readEntryBuffer("member-0.bin", 32))()).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
