import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { decodeGenericSparseFrame, isGenericSparseFrame } from "@raceiq/capture-formats/session/generic-sparse";

function readMaybeGzipped(filePath: string): Buffer {
  const raw = readFileSync(filePath);
  return filePath.endsWith(".gz") ? gunzipSync(raw) : raw;
}

/**
 * Read raw UDP datagrams from diagnostic dumps or canonical fixture captures.
 * Shared framing handles metadata, receipt timestamps and truncated tails.
 * Canonical fixture deltas are reconstructed before replaying them to a socket.
 *
 * Supports both plain .bin and gzip-compressed .bin.gz files.
 *
 * @returns Array of raw packet Buffers in recording order.
 */
export function readUdpDump(filePath: string, limit?: number): Buffer[] {
  const data = readMaybeGzipped(filePath);
  const packets: Buffer[] = [];
  let previous: Buffer | null = null;
  let checkpointOffset = -1;
  for (const record of iterateSessionCaptureRecords(data, 0, { strict: false })) {
    if (record.kind !== "frame") {
      previous = null;
      checkpointOffset = -1;
      continue;
    }
    let frame = record.frame;
    if (isGenericSparseFrame(frame)) {
      if (!previous || frame.length < 9 || frame.readUInt32LE(5) !== record.offset - checkpointOffset) {
        throw new Error(`Invalid UDP fixture checkpoint at ${record.offset}`);
      }
      frame = decodeGenericSparseFrame(frame, previous);
    } else {
      checkpointOffset = record.offset;
    }
    previous = frame;
    packets.push(frame);
    if (limit !== undefined && packets.length >= limit) break;
  }

  return packets;
}
