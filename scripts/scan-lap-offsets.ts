/**
 * Scan a session bin and report LapNumber transitions with their byte offsets.
 * Usage: bun run scripts/scan-lap-offsets.ts <sessionId>
 */
import { readFileSync } from "fs";
import { db } from "../server/db/index";
import { sessions } from "../server/db/schema";
import { eq } from "drizzle-orm";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { getServerGame } from "../server/games/registry";
import { META_FRAME_MAGIC } from "../server/udp-recorder";

initGameAdapters();
initServerGameAdapters();

const sessionId = Number(process.argv[2]);
const sess = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
if (!sess?.rawFile) { console.log("no rawFile"); process.exit(1); }
const buf = readFileSync(sess.rawFile);
console.log("File:", sess.rawFile);
console.log("Size:", buf.length);

const adapter = getServerGame(sess.gameId as any);
const state = adapter.createParserState?.() ?? null;

let off = 0;
if (buf.readUInt32LE(0) === META_FRAME_MAGIC) off = 8 + buf.readUInt32LE(4);

let prevLap = -999;
let frameIdx = 0;
const seenLaps = new Set<number>();
while (off + 4 <= buf.length) {
  const len = buf.readUInt32LE(off);
  if (off + 4 + len > buf.length) break;
  const frameStart = off;
  const frameBuf = buf.subarray(off + 4, off + 4 + len);
  off += 4 + len;
  try {
    const pkt: any = adapter.tryParse(frameBuf, state);
    if (pkt && pkt.LapNumber !== prevLap) {
      seenLaps.add(pkt.LapNumber);
      console.log(`  Frame ${frameIdx}: offset=${frameStart} LapNumber=${pkt.LapNumber} CurrentLap=${pkt.CurrentLap?.toFixed(2)} Distance=${pkt.DistanceTraveled?.toFixed(0)}`);
      prevLap = pkt.LapNumber;
    }
  } catch { /* skip */ }
  frameIdx++;
}
console.log("Unique LapNumbers seen:", [...seenLaps].sort((a,b) => a-b));
console.log(`Total frames: ${frameIdx}`);
process.exit(0);
