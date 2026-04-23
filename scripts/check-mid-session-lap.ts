/**
 * Dump per-packet lap-number transitions and detector output for the mid-session
 * AC Evo fixture. Run: `bun run scripts/check-mid-session-lap.ts`
 */
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { getServerGame } from "../server/games/registry";
import { META_FRAME_MAGIC } from "../server/udp-recorder";
import { CapturingDbAdapter } from "../server/pipeline-adapters";
import { LapDetectorAcEvo } from "../server/lap-detector-ac-evo";
import { stopMaintenanceTasks } from "../server/pipeline";

initGameAdapters();
initServerGameAdapters();
const raw = readFileSync("test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz");
const buf = Buffer.from(gunzipSync(raw));
let offset = 0;
if (buf.readUInt32LE(0) === META_FRAME_MAGIC) {
  const payloadLen = buf.readUInt32LE(4);
  offset = 8 + payloadLen;
}
const serverGame = getServerGame("ac-evo");
const parserState = serverGame.createParserState?.() ?? null;
const db = new CapturingDbAdapter();
const detector = new LapDetectorAcEvo({ db });

let firstPacket: any = null;
let maxLap = 0;
let count = 0;
const lapTransitions: { count: number; lapNumber: number; currentLap: number; distance: number }[] = [];
let prevLapNumber = -1;
while (offset < buf.length) {
  if (offset + 4 > buf.length) break;
  const frameLen = buf.readUInt32LE(offset);
  if (frameLen === META_FRAME_MAGIC) {
    const payloadLen = buf.readUInt32LE(offset + 4);
    offset += 8 + payloadLen;
    continue;
  }
  offset += 4;
  const frameBuf = buf.subarray(offset, offset + frameLen);
  const frameStart = offset - 4;
  offset += frameLen;
  const p: any = serverGame.tryParse(frameBuf, parserState);
  if (p) {
    if (!firstPacket) firstPacket = p;
    if (p.LapNumber > maxLap) maxLap = p.LapNumber;
    if (p.LapNumber !== prevLapNumber) {
      lapTransitions.push({ count, lapNumber: p.LapNumber, currentLap: p.CurrentLap, distance: p.DistanceTraveled });
      prevLapNumber = p.LapNumber;
    }
    count++;
    await detector.feed(p, frameStart);
  }
}
await detector.flushIncompleteLap?.();

console.log("=== Game-reported data ===");
console.log("total packets:", count);
console.log("first packet LapNumber:", firstPacket?.LapNumber);
console.log("first packet CurrentLap:", firstPacket?.CurrentLap);
console.log("first packet DistanceTraveled:", firstPacket?.DistanceTraveled);
console.log("max LapNumber:", maxLap);
console.log("lap transitions:");
for (const t of lapTransitions) {
  console.log(`  packet #${t.count}: LapNumber=${t.lapNumber} CurrentLap=${t.currentLap.toFixed(2)} Distance=${t.distance.toFixed(0)}`);
}
console.log("\n=== Detector output ===");
for (const lap of db.laps) {
  console.log(`  detector lap ${lap.lapNumber}: time=${lap.lapTime.toFixed(2)}s valid=${lap.isValid} reason=${lap.invalidReason ?? "-"}`);
}

stopMaintenanceTasks();
