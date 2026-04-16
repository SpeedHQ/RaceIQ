import { readFileSync } from "fs";
import { gunzipSync } from "zlib";

function readMaybeGzipped(filePath: string): Buffer {
  const raw = readFileSync(filePath);
  return filePath.endsWith(".gz") ? gunzipSync(raw) : raw;
}

/**
 * Read a UDP dump file written by UdpRecorder.
 *
 * Format: repeated [uint32 LE length][N raw bytes]
 * A truncated final record (declared length > remaining bytes) is silently skipped.
 *
 * Supports both plain .bin and gzip-compressed .bin.gz files.
 *
 * @returns Array of raw packet Buffers in recording order.
 */
export function readUdpDump(filePath: string, limit?: number): Buffer[] {
  const data = readMaybeGzipped(filePath);
  const packets: Buffer[] = [];
  let offset = 0;

  while (offset + 4 <= data.length) {
    const len = data.readUInt32LE(offset);
    offset += 4;
    if (offset + len > data.length) break; // truncated final record
    packets.push(data.slice(offset, offset + len));
    offset += len;
    if (limit !== undefined && packets.length >= limit) break;
  }

  return packets;
}
