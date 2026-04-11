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

const lapSequence: number[] = [];

for (let i = 0; i < frames.length; i++) {
  const frame = frames[i];
  if (carOrdinal === 0) {
    const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
    const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
    if (cm) carOrdinal = getAccCarByModel(cm)?.id ?? 0;
    if (tn) trackOrdinal = getAccTrackByName(tn)?.id ?? 0;
  }

  const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, { carOrdinal, trackOrdinal });
  if (packet?.LapNumber !== undefined) {
    lapSequence.push(packet.LapNumber);
  }

  if (i >= 15580) break; // last frame
}

// Print lap transitions
console.log("Lap number transitions:\n");
let currentLap = -1;
let transitionCount = 0;
const transitions: Array<{ frame: number; from: number; to: number }> = [];

for (let i = 0; i < lapSequence.length; i++) {
  if (lapSequence[i] !== currentLap) {
    transitions.push({ frame: i, from: currentLap, to: lapSequence[i] });
    currentLap = lapSequence[i];
    transitionCount++;
  }
}

console.log(`Total transitions: ${transitionCount}\n`);
console.log("First 50 transitions:");
transitions.slice(0, 50).forEach((t) => {
  console.log(`  Frame ${t.frame}: ${t.from} → ${t.to}`);
});

console.log("\nLast 20 transitions:");
transitions.slice(-20).forEach((t) => {
  console.log(`  Frame ${t.frame}: ${t.from} → ${t.to}`);
});
