import { createSocket } from "node:dgram";
import { setTimeout as delay } from "node:timers/promises";
import { PHYSICS, GRAPHICS, STATIC } from "@raceiq/capture-formats/acc/structs";
import { ACC_PACKED_MAGIC, packTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";

/** ACC's production shared-memory capture envelope, fed through the production source parser. */
export async function ingestAccLaps(port: number, laps: number): Promise<void> {
  const socket = createSocket("udp4");
  const staticData = Buffer.alloc(STATIC.SIZE);
  staticData.write("bmw_m4_gt3", STATIC.carModel.offset, STATIC.carModel.size - 2, "utf16le");
  staticData.write("monza", STATIC.track.offset, STATIC.track.size - 2, "utf16le");
  staticData.writeInt32LE(1, STATIC.numCars.offset);
  staticData.writeInt32LE(8_000, STATIC.maxRpm.offset);
  staticData.writeFloatLE(100, STATIC.maxFuel.offset);
  try {
    for (let lap = 0; lap <= laps; lap++) {
      for (let frame = 0; frame < (lap < laps ? 240 : 1); frame++) {
        const progress = frame / 239;
        const physics = Buffer.alloc(PHYSICS.SIZE);
        physics.writeInt32LE(lap * 240 + frame, PHYSICS.packetId.offset);
        physics.writeFloatLE(60 - (lap + progress) * 2.4, PHYSICS.fuel.offset);
        physics.writeFloatLE(180, PHYSICS.speedKmh.offset);
        physics.writeInt32LE(5, PHYSICS.gear.offset);
        physics.writeInt32LE(5_000, PHYSICS.rpms.offset);
        for (const field of [
          PHYSICS.tyreCoreFL, PHYSICS.tyreCoreFR, PHYSICS.tyreCoreRL, PHYSICS.tyreCoreRR,
          PHYSICS.tyreTempFL, PHYSICS.tyreTempFR, PHYSICS.tyreTempRL, PHYSICS.tyreTempRR,
        ]) physics.writeFloatLE(95, field.offset);
        const graphics = Buffer.alloc(GRAPHICS.SIZE);
        graphics.writeInt32LE(lap * 240 + frame, GRAPHICS.packetId.offset);
        graphics.writeInt32LE(2, GRAPHICS.status.offset);
        graphics.writeInt32LE(2, GRAPHICS.session.offset);
        graphics.writeInt32LE(lap, GRAPHICS.completedLaps.offset);
        graphics.writeInt32LE(1, GRAPHICS.position.offset);
        graphics.writeInt32LE(Math.round(progress * 60_000), GRAPHICS.iCurrentTime.offset);
        graphics.writeInt32LE(lap > 0 ? 60_000 : 0, GRAPHICS.iLastTime.offset);
        graphics.writeInt32LE(lap > 0 ? 60_000 : 0, GRAPHICS.iBestTime.offset);
        graphics.writeFloatLE((lap + progress) * 3_000, GRAPHICS.distanceTraveled.offset);
        graphics.writeFloatLE(progress, GRAPHICS.normalizedCarPosition.offset);
        graphics.writeInt32LE(1, GRAPHICS.activeCars.offset);
        graphics.writeFloatLE(Math.sin(progress * Math.PI * 2) * 477, GRAPHICS.carCoordinatesBase.offset);
        graphics.writeFloatLE(Math.cos(progress * Math.PI * 2) * 477, GRAPHICS.carCoordinatesBase.offset + 8);
        graphics.writeInt32LE(1, GRAPHICS.carIDBase.offset);
        graphics.writeInt32LE(1, GRAPHICS.playerCarID.offset);
        graphics.writeInt32LE(1, GRAPHICS.isValidLap.offset);
        graphics.writeInt32LE(Math.min(2, Math.floor(progress * 3)), GRAPHICS.currentSectorIndex.offset);
        graphics.write("Dry", GRAPHICS.currentTyreCompound.offset, GRAPHICS.currentTyreCompound.size - 2, "utf16le");
        const source = packTriplet(ACC_PACKED_MAGIC, 31, 0, physics, graphics, staticData);
        await new Promise<void>((accept, reject) => socket.send(source, port, "127.0.0.1", (error) => error ? reject(error) : accept()));
        await delay(8);
      }
    }
  } finally { socket.close(); }
}
