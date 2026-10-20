import { createSocket } from "node:dgram";
import { setTimeout as delay } from "node:timers/promises";

/** Native FM Dash packets exercise the real UDP parser and pipeline, not an API mock. */
export interface NativeLap {
  fuelUsed: number;
  wear: [number, number, number, number];
  /** Deliberately unavailable individual channels retain native sentinel values. */
  missingWheel?: number;
  serviceBefore?: { fuel: number; wear: [number, number, number, number] };
}
export interface NativeRun {
  carId: number;
  trackId?: number;
  pi?: number;
  firstLap?: number;
  timestampMs?: number;
  initialFuel?: number;
  initialWear?: [number, number, number, number];
  laps: NativeLap[];
}

export async function ingestNativeRun(run: NativeRun, port = Number(process.env.PW_SEEDED_E2E_UDP_PORT ?? "15320")): Promise<void> {
  const socket = createSocket("udp4");
  const framesPerLap = 240;
  const secondsPerLap = 60;
  const startMs = run.timestampMs ?? 1_000;
  const firstLap = run.firstLap ?? 1;
  let fuel = run.initialFuel ?? 0.9;
  let wear = run.initialWear ?? [0.1, 0.1, 0.1, 0.1];
  let elapsed = 0;
  const send = (packet: Buffer) => new Promise<void>((resolve, reject) => {
    socket.send(packet, port, "127.0.0.1", (error) => error ? reject(error) : resolve());
  });
  try {
    for (let lapIndex = 0; lapIndex <= run.laps.length; lapIndex++) {
      const lap = run.laps[lapIndex];
      if (lap?.serviceBefore) {
        fuel = lap.serviceBefore.fuel;
        wear = [...lap.serviceBefore.wear];
      }
      // One final boundary packet closes the last complete lap, without inventing a full next lap.
      const frameCount = lap ? framesPerLap : 1;
      for (let frame = 0; frame < frameCount; frame++) {
        const progress = frame / (framesPerLap - 1);
        const packet = Buffer.alloc(331);
        packet.writeInt32LE(1, 0);
        packet.writeUInt32LE(startMs + Math.round(elapsed * 1_000), 4);
        packet.writeFloatLE(8_000, 8);
        packet.writeFloatLE(800, 12);
        packet.writeFloatLE(5_000, 16);
        packet.writeInt32LE(run.carId, 212);
        packet.writeInt32LE(3, 216);
        packet.writeInt32LE(run.pi ?? 800, 220);
        packet.writeInt32LE(1, 224);
        packet.writeInt32LE(8, 228);
        packet.writeFloatLE(Math.sin(progress * Math.PI * 2) * 477, 232);
        packet.writeFloatLE(Math.cos(progress * Math.PI * 2) * 477, 240);
        packet.writeFloatLE(50, 244);
        packet.writeFloatLE(fuel - (lap?.fuelUsed ?? 0) * progress, 276);
        packet.writeFloatLE((firstLap - 1 + lapIndex + progress) * 3_000, 280);
        packet.writeFloatLE(firstLap + lapIndex > 1 ? secondsPerLap : 0, 284);
        packet.writeFloatLE(firstLap + lapIndex > 1 ? secondsPerLap : 0, 288);
        packet.writeFloatLE(progress * secondsPerLap, 292);
        packet.writeFloatLE((firstLap - 1) * secondsPerLap + elapsed, 296);
        packet.writeUInt16LE(firstLap + lapIndex, 300);
        packet.writeUInt8(1, 302);
        packet.writeUInt8(180, 303);
        packet.writeUInt8(4, 307);
        for (let wheel = 0; wheel < 4; wheel++) {
          packet.writeFloatLE(lap?.missingWheel === wheel ? -1 : wear[wheel]! + (lap?.wear[wheel] ?? 0) * progress, 311 + wheel * 4);
        }
        packet.writeInt32LE(run.trackId ?? 5, 327);
        await send(packet);
        await delay(6);
        elapsed += secondsPerLap / framesPerLap;
      }
      if (lap) {
        fuel -= lap.fuelUsed;
        wear = [wear[0] + lap.wear[0], wear[1] + lap.wear[1], wear[2] + lap.wear[2], wear[3] + lap.wear[3]];
      }
    }
  } finally {
    socket.close();
  }
}
