import type { LapIndexPacket } from "../../lap-detection/types";
import type { AcEvoParserCache } from "../ac-evo/parser";
import { PHYSICS as ACC_PHYSICS, GRAPHICS as ACC_GRAPHICS, STATIC as ACC_STATIC } from "../acc/structs";
import { PHYSICS as EVO_PHYSICS, GRAPHICS_EVO, STATIC_EVO, ACEVO_STATUS } from "../ac-evo/structs";
import { readWString } from "../acc/utils";
import { readCString } from "../ac-evo/utils";
import { getAccCarByModel } from "../../../shared/racing/cars/acc";
import { getAccTrackByName } from "../../../shared/racing/tracks/catalogs/acc";
import { getAcEvoCarByDisplayName } from "../../../shared/racing/cars/ac-evo";
import { getAcEvoTrackByName } from "../../../shared/racing/tracks/catalogs/ac-evo";
import { calibratePlayerSlot } from "../ac-evo/player-slot";
import { integrateDistance } from "../ac-evo/distance";

/** Direct detector projection for packed ACC frames. No TelemetryPacket allocation. */
export function parseAccLapIndex(physics: Buffer, graphics: Buffer, stat: Buffer, carOrdinal: number, trackOrdinal: number): LapIndexPacket | null {
  if (physics.length < ACC_PHYSICS.SIZE || graphics.length < ACC_GRAPHICS.MIN_SIZE || stat.length < ACC_STATIC.SIZE) return null;
  const cm = readWString(stat, ACC_STATIC.carModel.offset, ACC_STATIC.carModel.size);
  const tn = readWString(stat, ACC_STATIC.track.offset, ACC_STATIC.track.size);
  carOrdinal = getAccCarByModel(cm)?.id ?? carOrdinal;
  trackOrdinal = getAccTrackByName(tn)?.id ?? trackOrdinal;
  const i = (o: number) => graphics.readInt32LE(o);
  const f = (o: number) => physics.readFloatLE(o);
  const playerCarId = i(ACC_GRAPHICS.playerCarID.offset);
  let slot = 0;
  if (playerCarId > 0) {
    for (let n = 0; n < 60; n++) {
      if (i(ACC_GRAPHICS.carIDBase.offset + n * 4) === playerCarId) { slot = n; break; }
    }
  }
  const current = i(ACC_GRAPHICS.iCurrentTime.offset);
  const last = i(ACC_GRAPHICS.iLastTime.offset);
  const best = i(ACC_GRAPHICS.iBestTime.offset);
  const coord = ACC_GRAPHICS.carCoordinatesBase.offset + slot * 12;
  const packet: LapIndexPacket = {
    gameId: "acc", IsRaceOn: i(ACC_GRAPHICS.status.offset) === 2 ? 1 : 0, TimestampMS: Date.now(),
    CarOrdinal: carOrdinal, TrackOrdinal: trackOrdinal, CarPerformanceIndex: 0, CarClass: 0, LapNumber: i(ACC_GRAPHICS.completedLaps.offset) + 1,
    CurrentLap: current > 0 && current !== 0x7fffffff ? current / 1000 : 0,
    LastLap: last > 0 && last !== 0x7fffffff ? last / 1000 : 0, BestLap: best > 0 && best !== 0x7fffffff ? best / 1000 : 0,
    DistanceTraveled: graphics.readFloatLE(ACC_GRAPHICS.distanceTraveled.offset), PositionX: graphics.readFloatLE(coord), PositionZ: graphics.readFloatLE(coord + 8),
    Yaw: f(ACC_PHYSICS.heading.offset), Fuel: f(ACC_PHYSICS.fuel.offset),
    TireWearFL: f(ACC_PHYSICS.tyreWearFL.offset), TireWearFR: f(ACC_PHYSICS.tyreWearFR.offset), TireWearRL: f(ACC_PHYSICS.tyreWearRL.offset), TireWearRR: f(ACC_PHYSICS.tyreWearRR.offset),
    RacePosition: i(ACC_GRAPHICS.position.offset), WheelOnRumbleStripFL: 0, WheelOnRumbleStripFR: 0, WheelOnRumbleStripRL: 0, WheelOnRumbleStripRR: 0,
    acc: { pitStatus: i(ACC_GRAPHICS.isInPit.offset) ? "in_pit" : i(ACC_GRAPHICS.isInPitLane.offset) ? "pit_lane" : "out", currentSectorIndex: i(ACC_GRAPHICS.currentSectorIndex.offset), lastSectorTime: i(ACC_GRAPHICS.lastSectorTime.offset), isValidLap: graphics.length >= ACC_GRAPHICS.isValidLap.offset + 4 ? i(ACC_GRAPHICS.isValidLap.offset) === 1 : null } as never,
  };
  return packet;
}

/** Direct detector projection for packed AC Evo frames; mutates only cache needed for distance/identity. */
export function parseAcEvoLapIndex(physics: Buffer, graphics: Buffer, stat: Buffer, cache: AcEvoParserCache): LapIndexPacket | null {
  if (physics.length < EVO_PHYSICS.SIZE || graphics.length < GRAPHICS_EVO.SIZE || stat.length < STATIC_EVO.SIZE) return null;
  const status = graphics.readInt32LE(GRAPHICS_EVO.status.offset);
  if (status === ACEVO_STATUS.AC_OFF || status === ACEVO_STATUS.AC_REPLAY) return null;
  const car = readCString(graphics, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size);
  const track = readCString(stat, STATIC_EVO.track.offset, STATIC_EVO.track.size);
  const cfg = readCString(stat, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size);
  if (car) cache.carOrdinal = getAcEvoCarByDisplayName(car)?.id ?? -1;
  if (track) cache.trackOrdinal = getAcEvoTrackByName(track, cfg)?.id ?? -1;
  const current = graphics.readInt32LE(GRAPHICS_EVO.current_lap_time_ms.offset), last = graphics.readInt32LE(GRAPHICS_EVO.last_laptime_ms.offset), best = graphics.readInt32LE(GRAPHICS_EVO.best_laptime_ms.offset);
  const distance = integrateDistance(cache.distanceState, physics.readInt32LE(EVO_PHYSICS.packetId.offset), physics.readFloatLE(EVO_PHYSICS.speedKmh.offset) / 3.6, graphics.readFloatLE(GRAPHICS_EVO.current_km.offset));
  const activeCars = graphics.readUInt8(GRAPHICS_EVO.active_cars.offset);
  if (cache.playerSlotState.slot === -1) {
    calibratePlayerSlot(physics, graphics, cache.playerSlotState, activeCars);
  }
  const playerSlot = cache.playerSlotState.slot === -1 ? 0 : cache.playerSlotState.slot;
  const coordinateBase = GRAPHICS_EVO.car_coordinates_base.offset + playerSlot * 12;
  return { gameId: "ac-evo", IsRaceOn: status === 2 ? 1 : 0, TimestampMS: Date.now(), CarOrdinal: cache.carOrdinal, TrackOrdinal: cache.trackOrdinal, LapNumber: graphics.readInt32LE(GRAPHICS_EVO.total_lap_count.offset) + 1, CurrentLap: current > 0 ? current / 1000 : 0, LastLap: last > 0 ? last / 1000 : 0, BestLap: best > 0 ? best / 1000 : 0, DistanceTraveled: distance, PositionX: graphics.readFloatLE(coordinateBase), PositionZ: graphics.readFloatLE(coordinateBase + 8), Yaw: physics.readFloatLE(EVO_PHYSICS.heading.offset), Fuel: physics.readFloatLE(EVO_PHYSICS.fuel.offset), TireWearFL: physics.readFloatLE(EVO_PHYSICS.tyreWearFL.offset), TireWearFR: physics.readFloatLE(EVO_PHYSICS.tyreWearFR.offset), TireWearRL: physics.readFloatLE(EVO_PHYSICS.tyreWearRL.offset), TireWearRR: physics.readFloatLE(EVO_PHYSICS.tyreWearRR.offset), RacePosition: graphics.readUInt32LE(GRAPHICS_EVO.current_pos.offset), WheelOnRumbleStripFL: 0, WheelOnRumbleStripFR: 0, WheelOnRumbleStripRL: 0, WheelOnRumbleStripRR: 0 } as LapIndexPacket;
}
