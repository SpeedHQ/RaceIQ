import { readKunosFrames } from "../../../server/games/kunos/frame-reader";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { parseAccBuffers } from "../../../server/games/acc/parser";

export function readAccPackets(binPath: string, maxFrames = Infinity) {
  const frames = readKunosFrames(binPath);
  const packets: Array<{ frameIndex: number; packet: TelemetryPacket }> = [];

  for (let i = 0; i < Math.min(frames.length, maxFrames); i++) {
    const frame = frames[i];
    const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData);
    if (packet) packets.push({ frameIndex: i, packet });
  }

  return packets;
}
