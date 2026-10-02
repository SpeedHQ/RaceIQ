import { readKunosFrames } from "../../../server/games/kunos/frame-reader";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { parseAccBuffers } from "../../../server/games/acc/parser";
import { readWString } from "../../../server/games/acc/utils";
import { STATIC } from "../../../server/games/acc/structs";
import { getAccCarByModel } from "../../../shared/racing/cars/acc";
import { getAccTrackByName } from "../../../shared/racing/tracks/catalogs/acc";

export function readAccPackets(binPath: string, maxFrames = Infinity) {
  const frames = readKunosFrames(binPath);
  let carOrdinal = 0;
  let trackOrdinal = 0;
  const packets: Array<{ frameIndex: number; packet: TelemetryPacket }> = [];

  for (let i = 0; i < Math.min(frames.length, maxFrames); i++) {
    const frame = frames[i];
    if (carOrdinal === 0) {
      const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
      const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
      if (cm) carOrdinal = getAccCarByModel(cm)?.id ?? 0;
      if (tn) trackOrdinal = getAccTrackByName(tn)?.id ?? 0;
    }

    const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, {
      carOrdinal,
      trackOrdinal,
    });
    if (packet) packets.push({ frameIndex: i, packet });
  }

  return packets;
}
