import { readFileSync } from "fs";
import { initServerGameAdapters } from "../server/games/init";
import { importSessionBin } from "../server/import-session-bin";

initServerGameAdapters();
import { getAcEvoTrackName } from "../shared/ac-evo-track-data";
import { getSessions } from "../server/db/queries";

const bytes = readFileSync("C:/Users/acoop/Downloads/ac-evo-unknown-track-session17.bin.gz");
const result = await importSessionBin(Buffer.from(bytes), "ac-evo");
console.log("packets:", result.packetCount, "laps:", result.laps.length);
for (const lap of result.laps) {
  console.log(
    `lap ${lap.lapNumber} time=${lap.lapTime} carOrd=${lap.carOrdinal} trackOrd=${lap.trackOrdinal} track="${getAcEvoTrackName(lap.trackOrdinal)}"`
  );
}
const sessionId = result.laps[0]?.sessionId;
if (sessionId) {
  const sessions = await getSessions("ac-evo");
  const s = sessions.find((x) => x.id === sessionId);
  console.log("db session:", JSON.stringify(s));
}
