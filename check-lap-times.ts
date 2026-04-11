import { readAccFrames } from "./server/games/acc/recorder";
import { parseAccBuffers } from "./server/games/acc/parser";
import { readWString } from "./server/games/acc/utils";
import { STATIC } from "./server/games/acc/structs";
import { getAccCarByModel } from "./shared/acc-car-data";
import { getAccTrackByName } from "./shared/acc-track-data";

const binPath = "test/artifacts/laps/acc-2026-04-09T18-56-49-633Z.bin";
const frames = readAccFrames(binPath);

let carOrdinal = 0;
let trackOrdinal = 0;
let maxCurrentLap = 0;
let maxLastLap = 0;
let maxBestLap = 0;

for (let i = 0; i < frames.length; i++) {
  const frame = frames[i];
  if (carOrdinal === 0) {
    const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
    const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
    if (cm) carOrdinal = getAccCarByModel(cm)?.id ?? 0;
    if (tn) trackOrdinal = getAccTrackByName(tn)?.id ?? 0;
  }

  const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, { carOrdinal, trackOrdinal });
  if (packet) {
    maxCurrentLap = Math.max(maxCurrentLap, packet.CurrentLap ?? 0);
    maxLastLap = Math.max(maxLastLap, packet.LastLap ?? 0);
    maxBestLap = Math.max(maxBestLap, packet.BestLap ?? 0);
  }
}

console.log(`Max CurrentLap: ${maxCurrentLap.toFixed(2)}s`);
console.log(`Max LastLap: ${maxLastLap.toFixed(2)}s`);
console.log(`Max BestLap: ${maxBestLap.toFixed(2)}s`);
