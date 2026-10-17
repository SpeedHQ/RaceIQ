import { Readable } from "node:stream";
import { open } from "node:fs/promises";
import { crc32, createInflateRaw } from "node:zlib";
import { Schema } from "effect";
import { LiveArchiveIndexSchema, LiveArchiveSnapshotSchema, type ArchiveManifest, type ArchiveChunk, type LiveArchiveIndex, type LiveArchiveSnapshot } from "./contract";

export type CaptureArchiveOptions = {
  onRead?: (offset: number, length: number) => void;
  onDecompress?: (entryName: string) => void;
};

export interface CaptureArchive {
  readonly path: string;
  readEntry(entryName: string): AsyncIterable<Uint8Array>;
  readEntryBuffer(entryName: string, maxBytes: number): Promise<Buffer>;
}

const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_COMPRESSED_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 100_000;

function validateLiveIndex(index: LiveArchiveIndex): void {
  if (!index.captureEpoch || index.captureEpoch.length > 512 || !index.attempt || index.attempt.length > 512 ||
      !index.sourceRevision || index.sourceRevision.length > 512 ||
      index.sourceDurableWatermark > index.sourceByteLength ||
      index.metadataDurableWatermark > index.sourceDurableWatermark ||
      index.members.length > MAX_ENTRIES) {
    throw new Error("Invalid live gzip snapshot metadata");
  }
  let generation = 0;
  let cursor = 0;
  for (const member of [...index.members].sort((a, b) => a.memberOffset - b.memberOffset)) {
    if (member.generation !== generation + 1 || member.generation > index.generation ||
        member.memberOffset !== cursor) {
      throw new Error("Live gzip snapshot is not a contiguous committed prefix");
    }
    generation = member.generation;
    cursor += member.compressedByteLength;
    if (!Number.isSafeInteger(cursor) || cursor > index.committedArchiveLength) {
      throw new Error("Live gzip member exceeds committed prefix");
    }
  }
  if (cursor !== index.committedArchiveLength || generation !== index.generation) {
    throw new Error("Live gzip snapshot generation or committed length mismatch");
  }
}

function validateLiveMemberSnapshot(snapshot: LiveArchiveSnapshot): void {
  const numericValues = [
    snapshot.generation, snapshot.committedArchiveLength, snapshot.sourceDurableWatermark,
    snapshot.metadataDurableWatermark, snapshot.sourceByteLength, snapshot.sourceRecordCount,
    snapshot.member.generation, snapshot.member.memberOffset, snapshot.member.compressedByteLength,
  ];
  if (!snapshot.captureEpoch || snapshot.captureEpoch.length > 512 || !snapshot.attempt || snapshot.attempt.length > 512 ||
      !snapshot.sourceRevision || snapshot.sourceRevision.length > 512 ||
      !numericValues.every(Number.isSafeInteger) ||
      snapshot.sourceDurableWatermark > snapshot.sourceByteLength ||
      snapshot.metadataDurableWatermark > snapshot.sourceDurableWatermark ||
      snapshot.member.generation > snapshot.generation ||
      snapshot.member.memberOffset + snapshot.member.compressedByteLength > snapshot.committedArchiveLength) {
    throw new Error("Invalid live gzip member snapshot");
  }
}

export async function openCaptureArchive(
  archivePath: string,
  manifest: ArchiveManifest,
  options?: CaptureArchiveOptions,
): Promise<CaptureArchive> {
  return openArchivePrefix(archivePath, manifest, undefined, options);
}

/** Open a validated snapshot, ignoring only bytes after its committed prefix. */
export async function openLiveCaptureArchive(
  archivePath: string,
  input: unknown,
  options?: CaptureArchiveOptions,
): Promise<CaptureArchive> {
  const index = Schema.decodeUnknownSync(LiveArchiveIndexSchema)(input);
  validateLiveIndex(index);
  return openArchivePrefix(archivePath, {
    version: 4,
    gameId: index.gameId,
    sourceRevision: index.sourceRevision,
    sourceByteLength: index.sourceByteLength,
    sourceRecordCount: index.sourceRecordCount,
    archiveFile: index.archiveFile,
    chunks: index.members.map(({ generation: _generation, ...member }) => member),
  }, index.committedArchiveLength, options);
}

/**
 * Open one DB-fenced committed descriptor without loading earlier member rows.
 * Caller must obtain snapshot and descriptor in the same fenced DB transaction.
 */
export async function openLiveCaptureMember(
  archivePath: string,
  input: unknown,
  options?: CaptureArchiveOptions,
): Promise<CaptureArchive> {
  const snapshot = Schema.decodeUnknownSync(LiveArchiveSnapshotSchema)(input) as LiveArchiveSnapshot;
  validateLiveMemberSnapshot(snapshot);
  const { generation: _generation, ...member } = snapshot.member;
  return openArchivePrefix(archivePath, {
    version: 4,
    gameId: snapshot.gameId,
    sourceRevision: snapshot.sourceRevision,
    sourceByteLength: snapshot.sourceByteLength,
    sourceRecordCount: snapshot.sourceRecordCount,
    archiveFile: snapshot.archiveFile,
    chunks: [member],
  }, snapshot.committedArchiveLength, options, true);
}

async function openArchivePrefix(
  archivePath: string,
  manifest: ArchiveManifest,
  committedLength: number | undefined,
  options?: CaptureArchiveOptions,
  selectedMember = false,
): Promise<CaptureArchive> {
  if (!manifest || manifest.version !== 4 || manifest.archiveFile !== "capture.bin.gz" ||
      typeof manifest.sourceRevision !== "string" || manifest.sourceRevision.length > 512 ||
      !Array.isArray(manifest.chunks) || manifest.chunks.length > MAX_ENTRIES) {
    throw new Error("Invalid gzip archive manifest");
  }
  const archiveHandle = await open(archivePath, "r");
  let info;
  try { info = await archiveHandle.stat(); } finally { await archiveHandle.close(); }
  const limit = committedLength ?? info.size;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > info.size) throw new Error("Invalid committed gzip prefix length");
  const names = new Set<string>();
  const ids = new Set<string>();
  const indexed: Array<{ chunk: ArchiveChunk; end: number }> = [];
  for (const chunk of manifest.chunks) {
    if (!chunk || typeof chunk.id !== "string" || typeof chunk.entryName !== "string" ||
        (chunk.lapId !== undefined && typeof chunk.lapId !== "string")) {
      throw new Error("Invalid gzip member metadata");
    }
    const name = chunk.entryName;
    const offset = chunk.memberOffset;
    const length = chunk.compressedByteLength;
    if (chunk.id.length > 256 || ids.has(chunk.id) || (chunk.lapId !== undefined && chunk.lapId.length > 512) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(name) || names.has(name)) {
      throw new Error(`Invalid or duplicate gzip entry identity: ${name}`);
    }
    names.add(name);
    ids.add(chunk.id);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 18 ||
        length > MAX_COMPRESSED_ENTRY_BYTES || !Number.isSafeInteger(offset + length) || offset + length > limit) {
      throw new Error(`Invalid gzip member range: ${name}`);
    }
    if (!Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < 0 || chunk.byteLength > MAX_ENTRY_BYTES) {
      throw new Error(`Invalid gzip uncompressed size: ${name}`);
    }
    indexed.push({ chunk, end: offset + length });
  }
  indexed.sort((a, b) => a.chunk.memberOffset - b.chunk.memberOffset);
  if (selectedMember) {
    if (indexed.length !== 1) throw new Error("Live member snapshot must select exactly one gzip member");
  } else {
    let cursor = 0;
    for (const item of indexed) {
      if (item.chunk.memberOffset !== cursor) throw new Error("Gzip member ranges contain a gap or overlap");
      cursor = item.end;
    }
    if (cursor !== limit) throw new Error(committedLength === undefined
      ? "Gzip archive has unindexed trailing bytes"
      : "Committed gzip prefix has unindexed trailing bytes");
  }
  const byName = new Map(manifest.chunks.map((chunk) => [chunk.entryName, chunk]));
  const readEntry = async function* (chunk: ArchiveChunk): AsyncIterable<Uint8Array> {
    const handle = await open(archivePath, "r");
    try {
      const readExact = async (buffer: Buffer, position: number) => {
        let count = 0;
        while (count < buffer.length) {
          const result = await handle.read(buffer, count, buffer.length - count, position + count);
          if (!result.bytesRead) throw new Error(`Truncated gzip member: ${chunk.entryName}`);
          options?.onRead?.(position + count, result.bytesRead);
          count += result.bytesRead;
        }
      };
      const header = Buffer.alloc(10);
      await readExact(header, chunk.memberOffset);
      if (header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 8 || header[3] !== 0) {
        throw new Error(`Invalid or unsupported gzip header: ${chunk.entryName}`);
      }
      const trailer = Buffer.alloc(8);
      await readExact(trailer, chunk.memberOffset + chunk.compressedByteLength - 8);
      if (trailer.readUInt32LE(4) !== (chunk.byteLength >>> 0)) throw new Error(`Gzip size mismatch: ${chunk.entryName}`);
      options?.onDecompress?.(chunk.entryName);
      const input = Readable.from((async function* () {
        let position = chunk.memberOffset + 10;
        const end = chunk.memberOffset + chunk.compressedByteLength - 8;
        while (position < end) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) throw new Error(`Truncated gzip payload: ${chunk.entryName}`);
          options?.onRead?.(position, bytesRead);
          position += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      })());
      const inflater = createInflateRaw({ chunkSize: 64 * 1024 });
      input.on("error", (error) => inflater.destroy(error));
      input.pipe(inflater);
      let outputBytes = 0;
      let crc = 0;
      try {
        for await (const value of inflater) {
          const bytes = value as Buffer;
          outputBytes += bytes.length;
          if (outputBytes > chunk.byteLength || outputBytes > MAX_ENTRY_BYTES) throw new Error(`Gzip entry exceeds declared size: ${chunk.entryName}`);
          crc = crc32(bytes, crc);
          yield bytes;
        }
      } finally { input.destroy(); inflater.destroy(); }
      if (inflater.bytesWritten !== chunk.compressedByteLength - 18) {
        throw new Error(`Gzip member contains trailing bytes or another member: ${chunk.entryName}`);
      }
      if (outputBytes !== chunk.byteLength || crc !== trailer.readUInt32LE(0)) {
        throw new Error(`Gzip checksum or size mismatch: ${chunk.entryName}`);
      }
    } finally { await handle.close(); }
  };
  return {
    path: archivePath,
    readEntry(entryName) {
      const chunk = byName.get(entryName);
      if (!chunk) throw new Error(`Unknown gzip entry: ${entryName}`);
      return readEntry(chunk);
    },
    async readEntryBuffer(entryName, maxBytes) {
      const chunk = byName.get(entryName);
      if (!chunk) throw new Error(`Unknown gzip entry: ${entryName}`);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || chunk.byteLength > maxBytes) {
        throw new Error(`Gzip entry exceeds size limit: ${entryName}`);
      }
      const buffer = Buffer.allocUnsafe(chunk.byteLength);
      let length = 0;
      for await (const bytes of readEntry(chunk)) {
        buffer.set(bytes, length);
        length += bytes.byteLength;
      }
      return buffer;
    },
  };
}
