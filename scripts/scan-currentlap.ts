import { parseDump } from "../test/helpers/parse-dump";

const files: Array<[string, string]> = [
  ["fm-2023", "test/artifacts/laps/fm-2023-2026-04-09T21-55-03-186Z.bin"],
  ["f1-2025", "test/artifacts/laps/f1-2025-2026-04-09T21-34-10-190Z.bin"],
];

for (const [gameId, path] of files) {
  console.log(`\n=== ${path} ===`);
  const { rawPackets } = await parseDump(gameId as any, path);
  console.log(`Total packets: ${rawPackets.length}`);
  if (rawPackets.length === 0) continue;

  // Min/max CurrentLap
  let minCL = Infinity, maxCL = -Infinity;
  for (const p of rawPackets) {
    if (p.CurrentLap < minCL) minCL = p.CurrentLap;
    if (p.CurrentLap > maxCL) maxCL = p.CurrentLap;
  }
  console.log(`CurrentLap range: ${minCL.toFixed(3)} .. ${maxCL.toFixed(3)}`);
  console.log(`First packet: CL=${rawPackets[0].CurrentLap.toFixed(3)} LL=${rawPackets[0].LastLap.toFixed(3)} LN=${rawPackets[0].LapNumber} DT=${rawPackets[0].DistanceTraveled.toFixed(0)}`);
  console.log(`Last packet: CL=${rawPackets[rawPackets.length-1].CurrentLap.toFixed(3)} LL=${rawPackets[rawPackets.length-1].LastLap.toFixed(3)} LN=${rawPackets[rawPackets.length-1].LapNumber} DT=${rawPackets[rawPackets.length-1].DistanceTraveled.toFixed(0)}`);

  // Find all reset points (>=30 -> <=2)
  let resetCount = 0;
  for (let i = 1; i < rawPackets.length; i++) {
    if (rawPackets[i - 1].CurrentLap >= 30 && rawPackets[i].CurrentLap <= 2) {
      if (resetCount < 10) console.log(`  Reset at i=${i}: prev CL=${rawPackets[i-1].CurrentLap.toFixed(3)} -> cur CL=${rawPackets[i].CurrentLap.toFixed(3)} LN=${rawPackets[i-1].LapNumber}->${rawPackets[i].LapNumber} LL=${rawPackets[i].LastLap.toFixed(3)}`);
      resetCount++;
    }
  }
  console.log(`Total resets (>=30 -> <=2): ${resetCount}`);

  // Also check all LapNumber transitions
  let lnTransitions = 0;
  for (let i = 1; i < rawPackets.length; i++) {
    if (rawPackets[i].LapNumber !== rawPackets[i-1].LapNumber) {
      if (lnTransitions < 10) console.log(`  LN trans at i=${i}: ${rawPackets[i-1].LapNumber}->${rawPackets[i].LapNumber} CL=${rawPackets[i-1].CurrentLap.toFixed(3)}->${rawPackets[i].CurrentLap.toFixed(3)} LL=${rawPackets[i].LastLap.toFixed(3)}`);
      lnTransitions++;
    }
  }
  console.log(`Total LapNumber transitions: ${lnTransitions}`);
}
