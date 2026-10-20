import { createSocket } from "node:dgram";
import { setTimeout as delay } from "node:timers/promises";
import { F1_HEADER_SIZE, F1_PACKET_IDS } from "@raceiq/capture-formats/f1-2025/f1-wire";

/** Native F1 packets; the production adapter normalizes fuel to tank fraction and percentage wear to fraction worn. */
export async function ingestF1Laps(port: number, laps: number, sessionUID = 460n, wearPerLapPct = 0.8, tireChangeAtLap: number | null = null): Promise<void> {
  const socket = createSocket("udp4");
  let frameId = 0;
  const packet = (packetId: number, body: Buffer, time: number): Buffer => {
    const result = Buffer.alloc(F1_HEADER_SIZE + body.length);
    result.writeUInt16LE(2025, 0);
    result.writeUInt8(25, 2);
    result.writeUInt8(1, 3);
    result.writeUInt8(1, 5);
    result.writeUInt8(packetId, 6);
    result.writeBigUInt64LE(sessionUID, 7);
    result.writeFloatLE(time, 15);
    result.writeUInt32LE(frameId, 19);
    result.writeUInt32LE(frameId, 23);
    result.writeUInt8(255, 28);
    body.copy(result, F1_HEADER_SIZE);
    return result;
  };
  const send = (packetId: number, body: Buffer, time: number) => new Promise<void>((accept, reject) => {
    socket.send(packet(packetId, body, time), port, "127.0.0.1", (error) => error ? reject(error) : accept());
  });
  try {
    const participants = Buffer.alloc(1 + 57 * 22);
    participants.writeUInt8(1, 0);
    participants.writeUInt8(1, 2);
    participants.writeUInt8(0, 4);
    participants.write("Strategy fixture", 8, "utf8");
    await send(F1_PACKET_IDS.PARTICIPANTS, participants, 0);
    const session = Buffer.alloc(647);
    session.writeInt8(30, 1);
    session.writeInt8(20, 2);
    session.writeUInt8(30, 3);
    session.writeUInt16LE(3_000, 4);
    session.writeUInt8(10, 6);
    session.writeInt8(0, 7);
    await send(F1_PACKET_IDS.SESSION, session, 0);
    const telemetry = Buffer.alloc(60 * 22);
    telemetry.writeUInt16LE(180, 0);
    telemetry.writeFloatLE(0.7, 2);
    telemetry.writeInt8(4, 15);
    telemetry.writeUInt16LE(10_000, 16);
    for (let lap = 0; lap <= laps; lap++) {
      for (let frame = 0; frame < (lap < laps ? 120 : 1); frame++) {
        const progress = frame / 119;
        const time = lap * 60 + progress * 60;
        const replaced = tireChangeAtLap != null && lap + 1 >= tireChangeAtLap;
        const compound = replaced ? 17 : 16;
        const status = Buffer.alloc(55 * 22);
        status.writeFloatLE(60 - (lap + progress) * 2.4, 5);
        status.writeFloatLE(100, 9);
        status.writeUInt16LE(15_000, 17);
        status.writeUInt16LE(4_000, 19);
        status.writeUInt8(8, 21);
        status.writeUInt8(compound, 25);
        status.writeUInt8(compound, 26);
        await send(F1_PACKET_IDS.CAR_STATUS, status, time);
        const damage = Buffer.alloc(46 * 22);
        const wear = replaced ? (lap + 1 - tireChangeAtLap! + progress) * wearPerLapPct : 10 + (lap + progress) * wearPerLapPct;
        for (const offset of [0, 4, 8, 12]) damage.writeFloatLE(wear, offset);
        await send(F1_PACKET_IDS.CAR_DAMAGE, damage, time);
        const motion = Buffer.alloc(60 * 22);
        motion.writeFloatLE(Math.sin(progress * Math.PI * 2) * 477, 0);
        motion.writeFloatLE(Math.cos(progress * Math.PI * 2) * 477, 8);
        motion.writeFloatLE(50, 20);
        await send(F1_PACKET_IDS.MOTION, motion, time);
        const lapData = Buffer.alloc(57 * 22);
        lapData.writeUInt32LE(lap > 0 ? 60_000 : 0, 0);
        lapData.writeUInt32LE(Math.round(progress * 60_000), 4);
        lapData.writeFloatLE(progress * 3_000, 20);
        lapData.writeFloatLE((lap + progress) * 3_000, 24);
        lapData.writeUInt8(1, 32);
        lapData.writeUInt8(lap + 1, 33);
        lapData.writeUInt8(Math.min(2, Math.floor(progress * 3)), 36);
        lapData.writeUInt8(1, 44);
        lapData.writeUInt8(2, 45);
        await send(F1_PACKET_IDS.LAP_DATA, lapData, time);
        await send(F1_PACKET_IDS.CAR_TELEMETRY, telemetry, time);
        frameId++;
        await delay(12);
      }
    }
  } finally { socket.close(); }
}
