import { readAccFrames } from "./server/games/acc/recorder";
import { parseAccBuffers } from "./server/games/acc/parser";
import { readWString } from "./server/games/acc/utils";
import { STATIC } from "./server/games/acc/structs";
import { getAccCarByModel } from "./shared/acc-car-data";
import { getAccTrackByName } from "./shared/acc-track-data";
import { createWriteStream } from "fs";

const binPath = process.argv[2] || "test/artifacts/laps/acc-2026-04-09T18-56-49-633Z.bin";

async function main() {
  try {
    const frames = readAccFrames(binPath);
    console.log(`Read ${frames.length} frames`);

    let carOrdinal = 0;
    let trackOrdinal = 0;
    const packets = [];

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (carOrdinal === 0 || trackOrdinal === 0) {
        const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
        const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
        if (cm) carOrdinal = getAccCarByModel(cm)?.id ?? 0;
        if (tn) trackOrdinal = getAccTrackByName(tn)?.id ?? 0;
      }

      const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, {
        carOrdinal,
        trackOrdinal,
      });

      if (packet) {
        packets.push({
          frameIndex: i,
          lapNumber: packet.LapNumber,
          speed: packet.Speed,
          lapTime: packet.LapTime ?? 0,
          posX: packet.PositionX,
          posZ: packet.PositionZ,
          throttle: packet.ThrottleRaw,
          brake: packet.BrakeRaw,
        });
      }
    }

    // Write CSV
    const csvPath = binPath.replace(".bin", ".csv");
    const ws = createWriteStream(csvPath);

    ws.write("frameIndex,lapNumber,speed,lapTime,posX,posZ,throttle,brake\n");
    for (const p of packets) {
      ws.write(
        `${p.frameIndex},${p.lapNumber},${p.speed.toFixed(2)},${(p.lapTime ?? 0).toFixed(3)},${p.posX.toFixed(1)},${p.posZ.toFixed(1)},${p.throttle},${p.brake}\n`
      );
    }

    ws.end();

    // Print first lap speeds
    const lap0 = packets.filter((p) => p.lapNumber === 0);
    console.log(`\nLap 0: ${lap0.length} packets`);
    console.log("First 10 packets:");
    lap0.slice(0, 10).forEach((p) => {
      console.log(
        `  Frame ${p.frameIndex}: speed=${p.speed.toFixed(2)}, lapTime=${p.lapTime.toFixed(3)}, throttle=${p.throttle}`
      );
    });

    console.log(`\nCSV written to: ${csvPath}`);
  } catch (e) {
    console.error("Error:", e);
    process.exit(1);
  }
}

main();
