import { createSocket } from "node:dgram";
import { setTimeout as delay } from "node:timers/promises";
import { F1_HEADER_SIZE, F1_PACKET_IDS } from "@raceiq/capture-formats/f1-2025/f1-wire";

/** Native F1 packets; the production adapter normalizes fuel to tank fraction and percentage wear to fraction worn. */
export async function ingestF1Laps(port: number, laps: number, sessionUID = 460n, wearPerLapPct = 0.8, tireChangeAtLap: number | null = null, firstLap = 1,
  rates: { lapSeconds?: number; fuelPerLap?: number; teamId?: number; initialFuelL?: number; initialWearPct?: number; sessionTimeOffsetS?: number; frameIdStart?: number; trackLengthM?: number; pitLaneTimerActive?: boolean;
    /** Per-wheel overrides use normalized FL, FR, RL, RR order, not F1 packet order. */
    initialWearPctByWheel?: readonly [number, number, number, number]; wearPerLapPctByWheel?: readonly [number, number, number, number] } = {}): Promise<void> {
  const lapSeconds = rates.lapSeconds ?? 60;
  const fuelPerLap = rates.fuelPerLap ?? 2.4;
  const socket = createSocket("udp4");
  let frameId = rates.frameIdStart ?? 0;
  const timeOffset = rates.sessionTimeOffsetS ?? 0;
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
    participants.writeUInt8(rates.teamId ?? 0, 4);
    participants.write("Strategy fixture", 8, "utf8");
    await send(F1_PACKET_IDS.PARTICIPANTS, participants, timeOffset);
    const session = Buffer.alloc(647);
    session.writeInt8(30, 1);
    session.writeInt8(20, 2);
    session.writeUInt8(30, 3);
    session.writeUInt16LE(rates.trackLengthM ?? 3_000, 4);
    session.writeUInt8(10, 6);
    session.writeInt8(0, 7);
    await send(F1_PACKET_IDS.SESSION, session, timeOffset);
    const telemetry = Buffer.alloc(60 * 22);
    telemetry.writeUInt16LE(180, 0);
    telemetry.writeFloatLE(0.7, 2);
    telemetry.writeInt8(4, 15);
    telemetry.writeUInt16LE(10_000, 16);
    telemetry.fill(90, 30, 38);
    for (let lap = 0; lap <= laps; lap++) {
      for (let frame = 0; frame < (lap < laps ? 120 : 1); frame++) {
        const progress = frame / 119;
        const time = timeOffset + lap * lapSeconds + progress * lapSeconds;
        // Refresh session metadata on the accelerated native clock so derived lap position stays fresh.
        await send(F1_PACKET_IDS.SESSION, session, time);
        const replaced = tireChangeAtLap != null && lap + 1 >= tireChangeAtLap;
        const compound = replaced ? 17 : 16;
        const status = Buffer.alloc(55 * 22);
        status.writeFloatLE((rates.initialFuelL ?? 60) - (lap + progress) * fuelPerLap, 5);
        status.writeFloatLE(100, 9);
        status.writeUInt16LE(15_000, 17);
        status.writeUInt16LE(4_000, 19);
        status.writeUInt8(8, 21);
        status.writeUInt8(compound, 25);
        status.writeUInt8(compound, 26);
        await send(F1_PACKET_IDS.CAR_STATUS, status, time);
        const damage = Buffer.alloc(46 * 22);
        for (const [nativeWheel, wheel] of [2, 3, 0, 1].entries()) {
          const wearRate = rates.wearPerLapPctByWheel?.[wheel] ?? wearPerLapPct;
          const initialWear = rates.initialWearPctByWheel?.[wheel] ?? rates.initialWearPct ?? 10;
          const wear = replaced ? (lap + 1 - tireChangeAtLap! + progress) * wearRate : initialWear + (lap + progress) * wearRate;
          damage.writeFloatLE(wear, nativeWheel * 4);
        }
        await send(F1_PACKET_IDS.CAR_DAMAGE, damage, time);
        const motion = Buffer.alloc(60 * 22);
        motion.writeFloatLE(Math.sin(progress * Math.PI * 2) * 477, 0);
        motion.writeFloatLE(Math.cos(progress * Math.PI * 2) * 477, 8);
        motion.writeFloatLE(50, 20);
        await send(F1_PACKET_IDS.MOTION, motion, time);
        const lapData = Buffer.alloc(57 * 22);
        lapData.writeUInt32LE(lap > 0 ? Math.round(lapSeconds * 1_000) : 0, 0);
        lapData.writeUInt32LE(Math.round(progress * lapSeconds * 1_000), 4);
        lapData.writeFloatLE(progress * 3_000, 20);
        lapData.writeFloatLE((lap + firstLap - 1 + progress) * 3_000, 24);
        lapData.writeUInt8(1, 32);
        lapData.writeUInt8(lap + firstLap, 33);
        lapData.writeUInt8(Math.min(2, Math.floor(progress * 3)), 36);
        lapData.writeUInt8(1, 44);
        lapData.writeUInt8(2, 45);
        lapData.writeUInt8(rates.pitLaneTimerActive ? 1 : 0, 46);
        await send(F1_PACKET_IDS.LAP_DATA, lapData, time);
        await send(F1_PACKET_IDS.CAR_TELEMETRY, telemetry, time);
        frameId++;
        await delay(12);
      }
    }
  } finally { socket.close(); }
}
