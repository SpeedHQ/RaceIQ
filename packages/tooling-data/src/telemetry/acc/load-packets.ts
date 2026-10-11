import { readKunosFrames } from "@raceiq/capture-formats/kunos/dump";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { parseAccBuffers } from "@raceiq/game-acc/parser";
import { readWString } from "@raceiq/game-acc/utils";
import { STATIC } from "@raceiq/capture-formats/acc/structs";
import { getAccCarByModel } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccTrackByName } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";

export function readAccPackets(binPath: string, maxFrames = Infinity) {
  const frames = readKunosFrames(binPath);
  let carId = 0;
  let trackId = 0;
  const packets: Array<{ frameIndex: number; packet: TelemetryPacket }> = [];

  for (let i = 0; i < Math.min(frames.length, maxFrames); i++) {
    const frame = frames[i];
    if (carId === 0 || trackId === 0) {
      const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
      const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
      if (cm) carId = getAccCarByModel(cm)?.id ?? 0;
      if (tn) trackId = getAccTrackByName(tn)?.id ?? 0;
    }

    const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, {
      carId: carId === 0 ? "" : String(carId),
      trackId: trackId === 0 ? "" : String(trackId),
    });
    if (packet) packets.push({ frameIndex: i, packet });
  }

  return packets;
}
