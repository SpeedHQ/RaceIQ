/**
 * Diagnostic: verify AC Evo session lifecycle against a recorded .bin file.
 *
 * Usage: bun scripts/diag-ac-evo-status.ts <path>
 *
 * Reports:
 *   - Total raw frames
 *   - status/IsRaceOn transitions
 *   - Frames gated out by parser (AC_OFF / AC_REPLAY)
 *   - Whether lap detector finalises session after menu exit
 */
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { getServerGame } from "../server/games/registry";
import { META_FRAME_MAGIC } from "../server/udp-recorder";
import { ACEVO_STATUS, GRAPHICS_EVO } from "../server/games/ac-evo/structs";
import { unpackTriplet } from "../server/games/shared/pack-triplet";
import { LapDetectorAcEvo } from "../server/lap-detector-ac-evo";
import { CapturingDbAdapter } from "../server/pipeline-adapters";

initGameAdapters();
initServerGameAdapters();

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/diag-ac-evo-status.ts <bin-path>");
  process.exit(1);
}

const raw = readFileSync(path);
const buf: Buffer = path.endsWith(".gz") ? Buffer.from(gunzipSync(raw)) : raw;

let offset = 0;
if (buf.length >= 8 && buf.readUInt32LE(0) === META_FRAME_MAGIC) {
  const payloadLen = buf.readUInt32LE(4);
  offset = 8 + payloadLen;
  console.log(`[meta] skipped ${8 + payloadLen} byte meta frame`);
}

const serverGame = getServerGame("ac-evo");
const parserState = serverGame.createParserState?.() ?? null;

const statusName = (s: number) => {
  switch (s) {
    case ACEVO_STATUS.AC_OFF: return "OFF";
    case ACEVO_STATUS.AC_REPLAY: return "REPLAY";
    case ACEVO_STATUS.AC_LIVE: return "LIVE";
    case ACEVO_STATUS.AC_PAUSE: return "PAUSE";
    default: return `UNKNOWN(${s})`;
  }
};

const db = new CapturingDbAdapter();
const detector = new LapDetectorAcEvo({ db });

let frameCount = 0;
let parsedCount = 0;
let gatedCount = 0;
let lastStatus = -999;
let firstSessionId: number | null = null;
let sessionNulledAtFrame: number | null = null;
const transitions: { frame: number; rawStatus: number; statusName: string; parsed: boolean }[] = [];

while (offset < buf.length) {
  if (offset + 4 > buf.length) break;
  const frameLen = buf.readUInt32LE(offset);
  if (frameLen === META_FRAME_MAGIC) {
    if (offset + 8 > buf.length) break;
    const payloadLen = buf.readUInt32LE(offset + 4);
    offset += 8 + payloadLen;
    continue;
  }
  offset += 4;
  if (offset + frameLen > buf.length) break;
  const frameBuf = buf.subarray(offset, offset + frameLen);
  offset += frameLen;

  const triplet = unpackTriplet(frameBuf);
  if (!triplet) continue;

  const status = triplet.graphics.readInt32LE(GRAPHICS_EVO.status.offset);
  const packet = serverGame.tryParse(frameBuf, parserState);

  if (packet) {
    parsedCount++;
    await detector.feed(packet);
    if (firstSessionId === null && detector.session) firstSessionId = detector.session.sessionId;
  } else {
    gatedCount++;
  }

  if (status !== lastStatus) {
    transitions.push({ frame: frameCount, rawStatus: status, statusName: statusName(status), parsed: packet !== null });
    lastStatus = status;
  }

  frameCount++;
}

console.log(`\n[bin] total frames:   ${frameCount}`);
console.log(`[bin] parsed frames:  ${parsedCount}`);
console.log(`[bin] gated frames:   ${gatedCount}  (status=OFF or REPLAY → parser returns null)`);
console.log(`\n[bin] status transitions:`);
for (const t of transitions) {
  console.log(`  frame ${t.frame.toString().padStart(6)} | status=${t.rawStatus} (${t.statusName}) | parsed=${t.parsed}`);
}

// Simulate stale timer (as if 11s have passed since last packet)
(detector as any)._lastActivePacketTime = Date.now() - 11_000;
const sessionBefore = detector.session?.sessionId ?? null;
await detector.flushStaleLap?.();
const sessionAfter = detector.session?.sessionId ?? null;

console.log(`\n[finalize] before flushStaleLap: session=${sessionBefore}`);
console.log(`[finalize] after flushStaleLap:  session=${sessionAfter}`);
console.log(`[finalize] session nulled correctly: ${sessionBefore !== null && sessionAfter === null}`);
console.log(`[db] total laps inserted: ${db.laps.length}`);
console.log(`[db] session ids: ${[...new Set(db.laps.map((l) => l.sessionId))].join(", ")}`);
