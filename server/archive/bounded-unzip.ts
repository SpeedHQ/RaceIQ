import { unzipSync, type Unzipped } from "fflate";

const MIB = 1024 * 1024;

export const MAX_ARCHIVE_UPLOAD_BYTES = 512 * MIB;
export const MAX_DECOMPRESSED_CAPTURE_BYTES = 1024 * MIB;

export interface ZipExtractionLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const MOTEC_ZIP_LIMITS: ZipExtractionLimits = {
  maxArchiveBytes: MAX_ARCHIVE_UPLOAD_BYTES,
  maxEntries: 32,
  maxEntryBytes: 512 * MIB,
  maxTotalBytes: 768 * MIB,
};

export const LAPS_ZIP_LIMITS: ZipExtractionLimits = {
  maxArchiveBytes: MAX_ARCHIVE_UPLOAD_BYTES,
  maxEntries: 256,
  maxEntryBytes: 512 * MIB,
  maxTotalBytes: 1024 * MIB,
};

export function assertArchiveUploadSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("Archive size is invalid");
  }
  if (byteLength > MAX_ARCHIVE_UPLOAD_BYTES) {
    throw new Error("Archive exceeds the 512 MiB upload limit");
  }
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
const END_RECORD_BYTES = 22;
const CENTRAL_FILE_HEADER_BYTES = 46;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const ZIP64_U16_SENTINEL = 0xffff;
const ZIP64_U32_SENTINEL = 0xffffffff;
const zipNameDecoder = new TextDecoder();

function preflightZip(bytes: Uint8Array, limits: ZipExtractionLimits): void {
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new Error("ZIP archive exceeds the compressed size limit");
  }
  if (bytes.byteLength < END_RECORD_BYTES) {
    throw new Error("ZIP archive is missing its central directory");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstPossibleEnd = Math.max(
    0,
    bytes.byteLength - END_RECORD_BYTES - MAX_ZIP_COMMENT_BYTES,
  );
  let endOffset = -1;
  for (
    let offset = bytes.byteLength - END_RECORD_BYTES;
    offset >= firstPossibleEnd;
    offset--
  ) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + END_RECORD_BYTES + commentLength === bytes.byteLength) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("ZIP archive is missing its central directory");
  }

  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralDirectoryBytes = view.getUint32(endOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }
  if (
    entryCount === ZIP64_U16_SENTINEL ||
    centralDirectoryBytes === ZIP64_U32_SENTINEL ||
    centralDirectoryOffset === ZIP64_U32_SENTINEL
  ) {
    throw new Error("ZIP64 archives are not supported");
  }
  if (entryCount > limits.maxEntries) {
    throw new Error(`ZIP archive exceeds the ${limits.maxEntries}-entry limit`);
  }

  const centralDirectoryEnd =
    centralDirectoryOffset + centralDirectoryBytes;
  if (
    centralDirectoryEnd > endOffset ||
    !Number.isSafeInteger(centralDirectoryEnd)
  ) {
    throw new Error("ZIP central directory is invalid");
  }

  let cursor = centralDirectoryOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index++) {
    if (
      cursor + CENTRAL_FILE_HEADER_BYTES > centralDirectoryEnd ||
      view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_FILE_HEADER
    ) {
      throw new Error("ZIP central directory is invalid");
    }

    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const originalSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const startingDisk = view.getUint16(cursor + 34, true);
    const nextCursor =
      cursor +
      CENTRAL_FILE_HEADER_BYTES +
      nameLength +
      extraLength +
      commentLength;
    if (nextCursor > centralDirectoryEnd || startingDisk !== 0) {
      throw new Error("ZIP central directory is invalid");
    }
    if (
      compressedSize === ZIP64_U32_SENTINEL ||
      originalSize === ZIP64_U32_SENTINEL
    ) {
      throw new Error("ZIP64 archives are not supported");
    }

    const nameBytes = bytes.subarray(
      cursor + CENTRAL_FILE_HEADER_BYTES,
      cursor + CENTRAL_FILE_HEADER_BYTES + nameLength,
    );
    const name = zipNameDecoder
      .decode(nameBytes)
      .replace(/[^\x20-\x7e]/g, "?")
      .slice(0, 128);
    if ((flags & 1) !== 0) {
      throw new Error(`ZIP entry "${name}" is encrypted`);
    }
    if (compression !== 0 && compression !== 8) {
      throw new Error(`ZIP entry "${name}" uses unsupported compression`);
    }
    if (originalSize > limits.maxEntryBytes) {
      throw new Error(`ZIP entry "${name}" exceeds the uncompressed size limit`);
    }
    totalBytes += originalSize;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      throw new Error("ZIP archive exceeds the total uncompressed size limit");
    }
    cursor = nextCursor;
  }
  if (cursor !== centralDirectoryEnd) {
    throw new Error("ZIP central directory is invalid");
  }
}

export function unzipBounded(
  bytes: Uint8Array,
  limits: ZipExtractionLimits,
): Unzipped {
  preflightZip(bytes, limits);
  return unzipSync(bytes);
}
