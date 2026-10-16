import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  encodeFrameLength,
  encodeMetaFrame,
  encodeSegmentBoundaryFrame,
  encodeSegmentContextFrame,
  encodeSegmentContextEndFrame,
  encodeSparseCaptureFormatFrame,
  iterateSessionCaptureRecords,
} from "@raceiq/capture-formats/session/framing";
import {
  clearCaptureManifestCache,
  iterateSessionCaptureFrames,
  iterateSessionCaptureRecordsFromSource,
  loadSessionSource,
  resolveLapCaptureArtifact,
  setCaptureFileFactoryForTest,
} from "@raceiq/backend-core/session-capture/source-loader";
import { encodeKunosSparseFrame } from "@raceiq/capture-formats/session/kunos-sparse";
import { packTriplet, ACC_PACKED_MAGIC } from "@raceiq/capture-formats/kunos/pack-triplet";
import { encodeLMUSourcePayload, LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_SIZE, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_SCORING_INFO_SIZE, LMU_TELEMETRY_INFO_SIZE } from "@raceiq/capture-formats/lmu/layout";
import { encodeLmuSparseFrame } from "@raceiq/capture-formats/session/lmu-sparse";
import type { ArchiveManifest } from "@raceiq/capture-splitting";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("rejects published bundle chunk whose byte length disagrees with manifest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-bundle-manifest-"));
  directories.push(directory);
  const manifestPath = join(directory, "manifest.json");
  writeFileSync(join(directory, "lap.bin"), Buffer.from([1, 2, 3]));
  writeFileSync(manifestPath, JSON.stringify({
    version: 3,
    gameId: "fm-2023",
    sourceRevision: "fixture",
    sourceByteLength: 3,
    sourceRecordCount: 1,
    chunks: [{
      id: "lap-1", kind: "lap", lapId: "42", lapNumber: 1, path: "lap.bin",
      byteLength: 4, firstOrdinal: 0, recordCount: 1,
      sourceStart: 0, sourceEnd: 1, sourceByteStart: 12, sourceByteEnd: 19,
      ownedFrameByteOffset: 12, ownedFrameCount: 1,
    }],
  }));
  clearCaptureManifestCache(manifestPath);

  await expect(resolveLapCaptureArtifact(manifestPath, "lap-1", 42)).rejects.toThrow(/size mismatch/i);
});

test("manifest-only member remapping invalidates selected buffers and rejects mismatched layouts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-indexed-cache-"));
  directories.push(directory);
  const manifestPath = join(directory, "manifest.json");
  const archivePath = join(directory, "capture.bin.gz");
  const header = Buffer.concat([encodeMetaFrame(1), encodeSparseCaptureFormatFrame()]);
  const payloads = [1, 2].map((value) => Buffer.concat([header, encodeFrameLength(1), Buffer.from([value])]));
  const members = payloads.map((payload) => gzipSync(payload));
  writeFileSync(archivePath, Buffer.concat(members));
  const manifest: ArchiveManifest = {
    version: 4, gameId: "fm-2023", sourceRevision: "cache", archiveFile: "capture.bin.gz",
    sourceByteLength: 0, sourceRecordCount: 2,
    chunks: members.map((member, index) => ({
      id: `lap-${index}`, kind: "lap", lapId: String(42 + index), lapNumber: index,
      entryName: `entry-${index}.bin`, memberOffset: index === 0 ? 0 : members[0]!.length,
      compressedByteLength: member.length, byteLength: payloads[index]!.length,
      firstOrdinal: index, recordCount: 1, sourceStart: index, sourceEnd: index + 1,
      sourceByteStart: index, sourceByteEnd: index + 1, ownedFrameByteOffset: header.length, ownedFrameCount: 1,
    })),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const reference = { captureLayoutVersion: 2, captureArchiveFile: archivePath };
  const first = await resolveLapCaptureArtifact(manifestPath, "lap-0", 42, reference);
  const source = { rawFile: archivePath, source: null, gameId: "fm-2023" as const, carId: "0", trackId: "0" };
  const before = await loadSessionSource({ ...source, artifact: first.artifact });
  expect(before.kind === "capture" ? before.buffer : undefined).toEqual(payloads[0]);
  const replacement: ArchiveManifest = { ...manifest, chunks: manifest.chunks.map((chunk, index) => ({
    ...chunk, memberOffset: index === 0 ? members[0]!.length : 0,
    compressedByteLength: members[1 - index]!.length, byteLength: payloads[1 - index]!.length,
  })) };
  writeFileSync(manifestPath, JSON.stringify(replacement));
  utimesSync(manifestPath, new Date(), new Date(Date.now() + 1000));
  const second = await resolveLapCaptureArtifact(manifestPath, "lap-0", 42, reference);
  const after = await loadSessionSource({ ...source, artifact: second.artifact });
  expect(after.kind === "capture" ? after.buffer : undefined).toEqual(payloads[1]);
  await expect(resolveLapCaptureArtifact(manifestPath, "lap-0", 42, {
    captureLayoutVersion: 1, captureArchiveFile: archivePath,
  })).rejects.toThrow();
  await expect(resolveLapCaptureArtifact(manifestPath, "lap-0", 42, {
    captureLayoutVersion: 2, captureArchiveFile: join(directory, "unrelated.bin.gz"),
  })).rejects.toThrow();
});
for (const compressed of [false, true]) {
  test(`streams ${compressed ? "gzip" : "plain"} capture frames with decompressed offsets`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-source-stream-"));
    directories.push(directory);
    const first = Buffer.from([1, 2, 3]);
    const second = Buffer.from([4, 5]);
    const capture = Buffer.concat([
      encodeMetaFrame(2),
      encodeFrameLength(first.length),
      first,
      encodeSparseCaptureFormatFrame(),
      encodeFrameLength(second.length),
      second,
    ]);
    const rawFile = join(directory, compressed ? "capture.bin.gz" : "capture.bin");
    writeFileSync(rawFile, compressed ? gzipSync(capture) : capture);

    const records = [];
    for await (const record of iterateSessionCaptureFrames({
      rawFile,
      source: null,
      gameId: "f1-2025",
      carId: "0",
      trackId: "0",
    })) {
      records.push({ offset: record.offset, frame: [...record.frame] });
    }

    expect(records).toEqual([
      { offset: 12, frame: [1, 2, 3] },
      { offset: 35, frame: [4, 5] },
    ]);
  });
}

for (const compressed of [false, true]) {
  test(`streams ${compressed ? "gzip" : "plain"} segment records without whole-file reads`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-source-stream-"));
    directories.push(directory);
    const frame = Buffer.alloc(128 * 1024, 7);
    const capture = Buffer.concat([
      encodeMetaFrame(2), encodeFrameLength(frame.length), frame,
      encodeSparseCaptureFormatFrame(),
      encodeSegmentBoundaryFrame(), encodeSegmentContextFrame(),
      encodeFrameLength(2), Buffer.from([8, 9]), encodeSegmentContextEndFrame(),
    ]);
    const rawFile = join(directory, compressed ? "segments.bin.gz" : "segments.bin");
    writeFileSync(rawFile, compressed ? gzipSync(capture) : capture);
    setCaptureFileFactoryForTest((path) => {
      const file = Bun.file(path);
      return {
        size: file.size, lastModified: file.lastModified,
        slice: (start, end) => file.slice(start, end),
        stream: () => file.stream(),
        arrayBuffer: () => { throw new Error("whole-capture read"); },
      };
    });
    try {
      const actual = [];
      for await (const record of iterateSessionCaptureRecordsFromSource({
        rawFile, source: null, gameId: "f1-2025", carId: "0", trackId: "0",
      })) actual.push(record);
      expect(actual.map(({ kind, offset }) => ({ kind, offset }))).toEqual(
        [...iterateSessionCaptureRecords(capture)].map(({ kind, offset }) => ({ kind, offset })),
      );
      expect(actual.filter((record) => record.kind === "frame").map((record) => record.frame)).toEqual([frame, Buffer.from([8, 9])]);
    } finally {
      setCaptureFileFactoryForTest(null);
    }
  });
}

for (const malformed of [
  { name: "metadata", bytes: Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0x00, 0x01]) },
  { name: "frame", bytes: Buffer.from([0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0]) },
]) {
  test(`rejects oversized ${malformed.name} records before buffering their payload`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-source-stream-"));
    directories.push(directory);
    const rawFile = join(directory, "malformed.bin");
    writeFileSync(rawFile, Buffer.concat([
      encodeMetaFrame(1),
      encodeSparseCaptureFormatFrame(),
      malformed.bytes,
    ]));

    const consume = async () => {
      for await (const _record of iterateSessionCaptureFrames({
        rawFile,
        source: null,
        gameId: "f1-2025",
        carId: "0",
        trackId: "0",
      })) {
        // No valid records expected.
      }
    };

    await expect(consume()).rejects.toThrow(/record length .* exceeds 16 MiB limit/);
  });
}
test("rejects unmarked full-frame captures from playback and source loading", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-legacy-playback-"));
  directories.push(directory);
  const rawFile = join(directory, "legacy.bin");
  writeFileSync(rawFile, Buffer.concat([
    encodeMetaFrame(1),
    encodeFrameLength(3),
    Buffer.from([1, 2, 3]),
  ]));
  const source = { rawFile, source: null, gameId: "f1-2025" as const, carId: "0", trackId: "0" };
  const consume = async () => {
    for await (const _record of iterateSessionCaptureFrames(source)) {}
  };
  await expect(consume()).rejects.toThrow(/Legacy full-frame captures are not supported/);
  await expect(loadSessionSource(source)).rejects.toThrow(/Legacy full-frame captures are not supported/);
});
test("rejects sparse deltas backed by same-size cross-format checkpoints in both readers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-cross-format-"));
  directories.push(directory);
  const lmu = Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE);
  LMU_SOURCE_FRAME_MAGIC.copy(lmu);
  const packed = packTriplet(ACC_PACKED_MAGIC, 0, 0, Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE - 28), Buffer.alloc(0), Buffer.alloc(0));
  for (const wrongCheckpoint of [packed, lmu]) {
    const delta = wrongCheckpoint === packed
      ? encodeLmuSparseFrame(Buffer.from(lmu), Buffer.from(lmu), 4 + packed.length)
      : encodeKunosSparseFrame(packed, packed, 4 + lmu.length);
    const capture = Buffer.concat([encodeMetaFrame(), encodeFrameLength(wrongCheckpoint.length), wrongCheckpoint,
      encodeFrameLength(delta.length), delta]);
    const secondOffset = 12 + 4 + wrongCheckpoint.length;
    expect(() => [...iterateSessionCaptureRecords(capture, secondOffset)]).toThrow(/checkpoint/);
    const rawFile = join(directory, `bad-${wrongCheckpoint === packed ? "kunos" : "lmu"}.bin`);
    writeFileSync(rawFile, capture);
    await expect(async () => {
      for await (const _record of iterateSessionCaptureRecordsFromSource({ rawFile, source: null, gameId: "lmu", carId: "ferrari_499p_2023", trackId: "lemans_2023/lemanswec" })) {}
    }).toThrow(/checkpoint/);
  }
});


test("source loader preserves empty payloads and timestamp zero in plain and gzip recordings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-empty-source-"));
  directories.push(directory);
  const bytes = Buffer.concat([encodeMetaFrame(2), encodeSparseCaptureFormatFrame(), encodeFrameLength(0), encodeFrameLength(0, 0)]);
  for (const compressed of [false, true]) {
    const rawFile = join(directory, compressed ? "capture.bin.gz" : "capture.bin");
    writeFileSync(rawFile, compressed ? gzipSync(bytes) : bytes);
    const records = [];
    for await (const record of iterateSessionCaptureRecordsFromSource({
      rawFile, source: null, gameId: "fm-2023", carId: "0", trackId: "0",
    }, { strict: true })) records.push(record);
    expect(records).toEqual([...iterateSessionCaptureRecords(bytes)]);
  }
});
for (const compressed of [false, true]) {
  test(`loads released checkpoint-only ${compressed ? "gzip" : "plain"} captures with converted-session provenance`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-released-capture-"));
    directories.push(directory);
    const frame = Buffer.alloc(324, 7);
    frame.writeUInt16LE(2025, 0);
    const capture = Buffer.concat([encodeMetaFrame(1), encodeFrameLength(frame.length), frame]);
    const rawFile = join(directory, "released.bin");
    writeFileSync(rawFile, compressed ? gzipSync(capture) : capture);
    const source = { rawFile, source: null, gameId: "fm-2023" as const, carId: "0", trackId: "0", captureFormatVersion: 1 };

    const records = [];
    for await (const record of iterateSessionCaptureRecordsFromSource(source)) records.push(record);
    expect(records).toEqual([{ kind: "frame", offset: 12, endOffset: 12 + 4 + frame.length, frame }]);
    const loaded = await loadSessionSource(source);
    expect(loaded.kind).toBe("capture");
    if (loaded.kind !== "capture") throw new Error("Expected capture source");
    expect(loaded.buffer).toEqual(capture);
    expect(loaded.frameIndex.records).toEqual([{ offset: 12, length: frame.length, frameIndex: 0 }]);
  });
}

test("rejects checkpoint-only standalone captures without version-1 provenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-no-provenance-"));
  directories.push(directory);
  const frame = Buffer.alloc(324, 7);
  frame.writeUInt16LE(2025, 0);
  const rawFile = join(directory, "released.bin");
  writeFileSync(rawFile, Buffer.concat([encodeMetaFrame(1), encodeFrameLength(frame.length), frame]));
  for (const captureFormatVersion of [undefined, 0]) {
    const source = { rawFile, source: null, gameId: "fm-2023" as const, carId: "0", trackId: "0", captureFormatVersion };
    await expect(loadSessionSource(source)).rejects.toThrow(/Legacy full-frame captures are not supported/);
    await expect(async () => {
      for await (const _record of iterateSessionCaptureRecordsFromSource(source)) {}
    }).toThrow(/Legacy full-frame captures are not supported/);
  }
});

test("cache cannot transfer converted-capture provenance to an unconverted source", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-provenance-cache-"));
  directories.push(directory);
  const frame = Buffer.alloc(324, 7);
  frame.writeUInt16LE(2025, 0);
  const rawFile = join(directory, "released.bin");
  writeFileSync(rawFile, Buffer.concat([encodeMetaFrame(1), encodeFrameLength(frame.length), frame]));
  await loadSessionSource({ rawFile, source: null, gameId: "fm-2023", carId: "0", trackId: "0", captureFormatVersion: 1 });
  await expect(loadSessionSource({ rawFile, source: null, gameId: "fm-2023", carId: "0", trackId: "0" }))
    .rejects.toThrow(/Legacy full-frame captures are not supported/);
});
test("accepts released LMU source checkpoint-only captures with version-1 provenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-released-lmu-"));
  directories.push(directory);
  const frame = encodeLMUSourcePayload({
    gameVersion: 1,
    sessionEvent: 1,
    captureTimestampMs: 1_000,
    telemetry: Buffer.alloc(LMU_TELEMETRY_INFO_SIZE),
    scoringInfo: Buffer.alloc(LMU_SCORING_INFO_SIZE),
  });
  expect(frame.length).toBe(LMU_SOURCE_FRAME_SIZE);
  const capture = Buffer.concat([encodeMetaFrame(1), encodeFrameLength(frame.length), frame]);
  const rawFile = join(directory, "lmu-spa-iron-lynx-gte.bin.gz");
  writeFileSync(rawFile, gzipSync(capture));
  const source = { rawFile, source: null, gameId: "lmu" as const, carId: "ferrari_499p_2023", trackId: "lemans_2023/lemanswec", captureFormatVersion: 1 };
  const records = [];
  for await (const record of iterateSessionCaptureRecordsFromSource(source)) records.push(record);
  expect(records).toEqual([{ kind: "frame", offset: 12, endOffset: 12 + 4 + frame.length, frame }]);
  const loaded = await loadSessionSource(source);
  expect(loaded.kind).toBe("capture");
  if (loaded.kind !== "capture") throw new Error("Expected capture source");
  expect(loaded.buffer).toEqual(capture);
});
test("loads and indexes gzip sparse captures from decompressed bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-gzip-load-"));
  directories.push(directory);
  const frame = Buffer.from([1, 2, 3]);
  const capture = Buffer.concat([
    encodeMetaFrame(1),
    encodeFrameLength(frame.length),
    frame,
    encodeSparseCaptureFormatFrame(),
  ]);
  const rawFile = join(directory, "capture.bin.gz");
  writeFileSync(rawFile, gzipSync(capture));
  const loaded = await loadSessionSource({
    rawFile,
    source: null,
    gameId: "f1-2025",
    carId: "0",
    trackId: "0",
  });
  expect(loaded.kind).toBe("capture");
  if (loaded.kind !== "capture") throw new Error("Expected capture source");
  expect(loaded.buffer).toEqual(capture);
  expect(loaded.frameIndex.records).toEqual([{ offset: 12, length: frame.length, frameIndex: 0 }]);
});
