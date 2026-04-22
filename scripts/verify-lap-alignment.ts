/**
 * For a session id, compare each DB lap row's rawByteOffset against the
 * actual file offset where that LapNumber transition happens. Reports the
 * skew (in bytes and inferred seconds). Good laps skew by < 1 frame.
 *
 * Usage: bun run scripts/verify-lap-alignment.ts <sessionId>
 */
import { readFileSync } from "fs";
import { db } from "../server/db/index";
import { sessions, laps } from "../server/db/schema";
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
const adapter = getServerGame(sess.gameId as any);
const state = adapter.createParserState?.() ?? null;

// First, scan the file for where each LapNumber first appears.
let off = 0;
if (buf.readUInt32LE(0) === META_FRAME_MAGIC) off = 8 + buf.readUInt32LE(4);
const lapFirstOffset = new Map<number, number>();
while (off + 4 <= buf.length) {
  const len = buf.readUInt32LE(off);
  if (off + 4 + len > buf.length) break;
  const frameStart = off;
  const frameBuf = buf.subarray(off + 4, off + 4 + len);
  off += 4 + len;
  try {
    const p: any = adapter.tryParse(frameBuf, state);
    if (p && typeof p.LapNumber === "number" && !lapFirstOffset.has(p.LapNumber)) {
      lapFirstOffset.set(p.LapNumber, frameStart);
    }
  } catch { /* skip */ }
}

// Now read DB laps and compare.
const dbLaps = await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all();
dbLaps.sort((a, b) => a.lapNumber - b.lapNumber);

console.log(`Session ${sessionId} (${sess.gameId}) — ${dbLaps.length} laps, ${buf.length.toLocaleString()} bytes on disk`);
console.log();
for (const lap of dbLaps) {
  const fileOff = lapFirstOffset.get(lap.lapNumber);
  const dbOff = lap.rawByteOffset;
  if (fileOff === undefined) {
    console.log(`  Lap ${lap.lapNumber}: DB offset=${dbOff} | file: LapNumber=${lap.lapNumber} never seen`);
    continue;
  }
  const skew = dbOff != null ? dbOff - fileOff : null;
  const flag = skew === null ? "NULL" : Math.abs(skew) < 2000 ? "OK" : "SKEW";
  console.log(
    `  Lap ${lap.lapNumber}: DB=${dbOff?.toLocaleString()} file=${fileOff.toLocaleString()} skew=${skew?.toLocaleString()} [${flag}]`
  );
}

process.exit(0);
