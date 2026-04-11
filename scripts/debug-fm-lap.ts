import { parseDumpV2 } from "../test/helpers/parse-dump-v2";
import { assessLapRecording } from "../server/lap-quality";

const { laps } = await parseDumpV2("fm-2023", "test/artifacts/laps/fm-2023-2026-04-09T21-55-03-186Z.bin");

console.log(`Total laps: ${laps.length}`);
for (const lap of laps) {
  const packets = lap.packets;
  const first = packets[0];
  const last = packets[packets.length - 1];
  const dx = last.PositionX - first.PositionX;
  const dz = last.PositionZ - first.PositionZ;
  const gap = Math.sqrt(dx * dx + dz * dz);
  const lapDistance = last.DistanceTraveled - first.DistanceTraveled;
  const quality = assessLapRecording(packets, lap.lapTime);

  console.log(`\nLap ${lap.lapNumber} time=${lap.lapTime.toFixed(3)}s`);
  console.log(`  Packets: ${packets.length}`);
  console.log(`  First: Pos=(${first.PositionX.toFixed(0)}, ${first.PositionZ.toFixed(0)}) DT=${first.DistanceTraveled.toFixed(0)} CL=${first.CurrentLap.toFixed(2)}`);
  console.log(`  Last:  Pos=(${last.PositionX.toFixed(0)}, ${last.PositionZ.toFixed(0)}) DT=${last.DistanceTraveled.toFixed(0)} CL=${last.CurrentLap.toFixed(2)}`);
  console.log(`  gap=${gap.toFixed(0)}m lapDistance=${lapDistance.toFixed(0)}m`);
  console.log(`  quality: valid=${quality.valid} reason=${quality.reason}`);
  console.log(`  v2 stored: valid=${lap.isValid} reason=${lap.invalidReason}`);
}
