/**
 * Replay a UDP debug dump file to localhost for debugging.
 * Usage: bun scripts/telemetry/recordings/replay-udp-debug.ts <dump-file> [port] [speed]
 *
 * Reads the binary format: [u32le length] [u32le timestamp_ms] [raw bytes]
 * Sends each packet to localhost:port with original timing (adjusted by speed).
 */
import { readFileSync } from "fs";
import { createSocket } from "dgram";

const file = process.argv[2];
if (!file) {
  console.error("Usage: bun scripts/telemetry/recordings/replay-udp-debug.ts <dump-file> [port] [speed]");
  process.exit(1);
}

const port = parseInt(process.argv[3] || "5301");
const speed = parseFloat(process.argv[4] || "1");

const data = readFileSync(file);
const sock = createSocket("udp4");

// Parse all packets
interface RawPacket { timestamp: number; buf: Buffer }
const packets: RawPacket[] = [];
let offset = 0;
while (offset + 8 <= data.length) {
  const len = data.readUInt32LE(offset);
  const ts = data.readUInt32LE(offset + 4);
  if (offset + 8 + len > data.length) break;
  packets.push({ timestamp: ts, buf: data.subarray(offset + 8, offset + 8 + len) });
  offset += 8 + len;
}

console.log(`Loaded ${packets.length} packets from ${file}`);
console.log(`Replaying to localhost:${port} at ${speed}x speed`);

// Analyze F1 headers
let motionCount = 0;
const packetTypeCounts: Record<number, number> = {};
for (const p of packets) {
  if (p.buf.length >= 29 && p.buf.readUInt16LE(0) === 2025) {
    const packetId = p.buf.readUInt8(6);
    packetTypeCounts[packetId] = (packetTypeCounts[packetId] ?? 0) + 1;
    if (packetId === 0) motionCount++;
  }
}
console.log("Packet type counts:", packetTypeCounts);
console.log(`Motion packets (id 0): ${motionCount}`);

// Calculate timing stats
if (packets.length > 1) {
  const firstTs = packets[0].timestamp;
  const lastTs = packets[packets.length - 1].timestamp;
  const duration = (lastTs - firstTs) / 1000;
  console.log(`Duration: ${duration.toFixed(1)}s, Rate: ${(packets.length / duration).toFixed(0)} pps`);

  // Check for gaps > 50ms between packets
  let gaps50 = 0, gaps100 = 0, maxGap = 0;
  for (let i = 1; i < packets.length; i++) {
    const dt = packets[i].timestamp - packets[i - 1].timestamp;
    if (dt > maxGap) maxGap = dt;
    if (dt > 50) gaps50++;
    if (dt > 100) gaps100++;
  }
  console.log(`Gaps >50ms: ${gaps50}, >100ms: ${gaps100}, max: ${maxGap}ms`);

  // Check for gaps between motion packets specifically
  let motionGaps = 0, motionMaxGap = 0, lastMotionTs = 0;
  for (const p of packets) {
    if (p.buf.length >= 29 && p.buf.readUInt16LE(0) === 2025 && p.buf.readUInt8(6) === 0) {
      if (lastMotionTs > 0) {
        const dt = p.timestamp - lastMotionTs;
        if (dt > 50) motionGaps++;
        if (dt > motionMaxGap) motionMaxGap = dt;
      }
      lastMotionTs = p.timestamp;
    }
  }
  console.log(`Motion gaps >50ms: ${motionGaps}, max: ${motionMaxGap}ms`);
}

// Replay with timing
const startTs = packets[0].timestamp;
const startWall = Date.now();

let i = 0;

function sendNext() {
  if (i >= packets.length) {
    console.log("Replay complete");
    sock.close();
    return;
  }

  const p = packets[i];
  sock.send(p.buf, port, "127.0.0.1");
  i++;

  if (i < packets.length) {
    const nextDelay = (packets[i].timestamp - p.timestamp) / speed;
    setTimeout(sendNext, Math.max(0, nextDelay));
  } else {
    console.log("Replay complete");
    sock.close();
  }
}

sendNext();
