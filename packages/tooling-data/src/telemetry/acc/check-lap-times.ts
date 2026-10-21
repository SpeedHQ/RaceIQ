import { readAccPackets } from "./load-packets";

const binPath = "test/artifacts/sessions/acc-2026-04-09T18-56-49-633Z.bin";
const packets = readAccPackets(binPath);

let maxCurrentLap = 0;
let maxLastLap = 0;
let maxBestLap = 0;

for (const { packet } of packets) {
  maxCurrentLap = Math.max(maxCurrentLap, packet.CurrentLap ?? 0);
  maxLastLap = Math.max(maxLastLap, packet.LastLap ?? 0);
  maxBestLap = Math.max(maxBestLap, packet.BestLap ?? 0);
}

console.log(`Max CurrentLap: ${maxCurrentLap.toFixed(2)}s`);
console.log(`Max LastLap: ${maxLastLap.toFixed(2)}s`);
console.log(`Max BestLap: ${maxBestLap.toFixed(2)}s`);
