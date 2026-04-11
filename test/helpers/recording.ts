import { readFileSync } from "fs";

/**
 * Read a UDP dump file written by UdpRecorder.
 *
 * Format: repeated [uint32 LE length][N raw bytes]
 * A truncated final record (declared length > remaining bytes) is silently skipped.
 *
 * @returns Array of raw packet Buffers in recording order.
 */
export function readUdpDump(filePath: string): Buffer[] {
  const data = readFileSync(filePath);
  const packets: Buffer[] = [];
  let offset = 0;

  while (offset + 4 <= data.length) {
    const len = data.readUInt32LE(offset);
    offset += 4;
    if (offset + len > data.length) break; // truncated final record
    packets.push(data.slice(offset, offset + len));
    offset += len;
  }

  return packets;
}
