import { readAccPackets } from "./load-packets";

const binPath = "test/artifacts/sessions/acc-2026-04-09T18-56-49-633Z.bin";
const lapSequence: number[] = [];

for (const { packet } of readAccPackets(binPath, 15581)) {
  if (packet.LapNumber !== undefined) lapSequence.push(packet.LapNumber);
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
