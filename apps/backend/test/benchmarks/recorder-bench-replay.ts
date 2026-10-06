import dgram from "node:dgram";
import { setTimeout as sleep } from "node:timers/promises";
import { readUdpDump } from "@raceiq/backend-core/test-support/recordings/udp";
import { parseF1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";

export async function replayWithClock(path: string, gameId: "fm-2023" | "f1-2025", port: number, speed: number, signal?: AbortSignal) {
  const packets = readUdpDump(path);
  signal?.throwIfAborted();
  const socket = dgram.createSocket("udp4");
  const startNs = process.hrtime.bigint();
  let scheduledElapsedMs = 0;
  let previousTime: number | null = null;
  let previousIdentity: string | null = null;
  try {
    for (const packet of packets) {
      signal?.throwIfAborted();
      let timestamp: number | null = null;
      let identity: string | null = null;
      if (gameId === "fm-2023" && packet.length >= 8) {
        timestamp = packet.readUInt32LE(4);
        identity = "fm";
      } else if (gameId === "f1-2025" && packet.length >= 29) {
        const header = parseF1Header(packet);
        timestamp = header.sessionTime * 1000;
        identity = header.sessionUID.toString();
      }
      if (timestamp !== null) {
        if (previousTime === null || identity !== previousIdentity) {
          previousTime = timestamp;
          previousIdentity = identity;
        } else {
          let delta = timestamp - previousTime;
          if (gameId === "fm-2023" && delta < 0) {
            if (previousTime > 0xf000_0000 && timestamp < 0x0fff_ffff) delta += 0x1_0000_0000;
            else { delta = 0; previousTime = timestamp; }
          }
          if (delta > 0) {
            scheduledElapsedMs += delta / speed;
            previousTime = timestamp;
          } else if (gameId === "fm-2023" && delta === 0) previousTime = timestamp;
        }
      }
      const deadline = startNs + BigInt(Math.round(scheduledElapsedMs * 1_000_000));
      const remainingMs = Number(deadline - process.hrtime.bigint()) / 1_000_000;
      if (remainingMs > 0) {
        if (signal) await sleep(remainingMs, undefined, { signal });
        else await Bun.sleep(remainingMs);
      }
      const sent = Promise.withResolvers<void>();
      socket.send(packet, port, "127.0.0.1", (error) => { if (error) sent.reject(error); else sent.resolve(); });
      await sent.promise;
    }
  } finally { socket.close(); }
  return packets.length;
}
