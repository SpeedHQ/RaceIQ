import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import type { AcEvoParserCache } from "./parser";
import { PHYSICS as EVO_PHYSICS, GRAPHICS_EVO, STATIC_EVO, ACEVO_STATUS, ACEVO_CAR_LOCATION, ACEVO_FLAG_NAMES, ACEVO_SESSION_TYPE_NAMES } from "@raceiq/capture-formats/ac-evo/structs";
import { readCString } from "./utils";
import { acEvoCarId, acEvoTrackId } from "@raceiq/game-ac-evo-metadata/identity";
import { calibratePlayerSlot } from "./player-slot";
import { integrateDistance } from "./distance";
export function parseAcEvoLapIndex(physics: Buffer, graphics: Buffer, stat: Buffer, cache: AcEvoParserCache, timestampMs = 0): LapIndexPacket | null {
  if (physics.length < EVO_PHYSICS.SIZE || graphics.length < GRAPHICS_EVO.SIZE || stat.length < STATIC_EVO.SIZE) return null;
  const status = graphics.readInt32LE(GRAPHICS_EVO.status.offset);
  if (status === ACEVO_STATUS.AC_OFF || status === ACEVO_STATUS.AC_REPLAY) return null;
  const car = readCString(graphics, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size);
  const track = readCString(stat, STATIC_EVO.track.offset, STATIC_EVO.track.size);
  const cfg = readCString(stat, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size);
  if (car !== cache.lastCarModel) {
    cache.lastCarModel = car;
    cache.carId = acEvoCarId(car);
  }
  if (track !== cache.lastTrack || cfg !== cache.lastTrackConfiguration) {
    cache.lastTrack = track;
    cache.lastTrackConfiguration = cfg;
    cache.trackId = track.trim() ? acEvoTrackId(track, cfg) : "";
  }
  const current = graphics.readInt32LE(GRAPHICS_EVO.current_lap_time_ms.offset), last = graphics.readInt32LE(GRAPHICS_EVO.last_laptime_ms.offset), best = graphics.readInt32LE(GRAPHICS_EVO.best_laptime_ms.offset);
  const distance = integrateDistance(cache.distanceState, physics.readInt32LE(EVO_PHYSICS.packetId.offset), physics.readFloatLE(EVO_PHYSICS.speedKmh.offset) / 3.6, graphics.readFloatLE(GRAPHICS_EVO.current_km.offset));
  const activeCars = graphics.readUInt8(GRAPHICS_EVO.active_cars.offset);
  if (cache.playerSlotState.slot === -1) {
    calibratePlayerSlot(physics, graphics, cache.playerSlotState, activeCars);
  }
  const playerSlot = cache.playerSlotState.slot === -1 ? 0 : cache.playerSlotState.slot;
  const coordinateBase = GRAPHICS_EVO.car_coordinates_base.offset + playerSlot * 12;
  const racePosition = graphics.readUInt32LE(GRAPHICS_EVO.current_pos.offset);
  const isInPitLane = graphics.readUInt8(GRAPHICS_EVO.is_in_pit_lane.offset) !== 0;
  const isInPitBox = graphics.readUInt8(GRAPHICS_EVO.is_in_pit_box.offset) !== 0;
  const carLocation = graphics.readInt32LE(GRAPHICS_EVO.car_location.offset);
  const pitStatus =
    isInPitBox ? "in_pit" :
    isInPitLane || carLocation === ACEVO_CAR_LOCATION.ACEVO_PITLANE ? "pit_lane" :
    carLocation === ACEVO_CAR_LOCATION.ACEVO_UNASSIGNED ? "in_pit" : "out";
  const flagStatus = ACEVO_FLAG_NAMES[graphics.readInt32LE(GRAPHICS_EVO.flag.offset)] ?? "none";
  const sessionTypeRaw = stat.readInt32LE(STATIC_EVO.session.offset);
  const sessionType = ACEVO_SESSION_TYPE_NAMES[sessionTypeRaw] ?? "unknown";
  const isValidLapRaw = graphics.readUInt8(GRAPHICS_EVO.is_valid_lap.offset);
  const isValidLap = isValidLapRaw ? true : isInPitLane || isInPitBox ? null : false;
  return {
    gameId: "ac-evo",
    acEvoIdentity: { carName: car, trackName: track, trackConfiguration: cfg },
    carId: cache.carId,
    trackId: cache.trackId,
    carModelName: car || undefined,
    IsRaceOn: status === ACEVO_STATUS.AC_LIVE ? 1 : 0,
    CarPerformanceIndex: 0,
    CarClass: 0,
    TimestampMS: timestampMs,
    LapNumber: graphics.readInt32LE(GRAPHICS_EVO.total_lap_count.offset) + 1,
    CurrentLap: current > 0 ? current / 1000 : 0,
    LastLap: last > 0 ? last / 1000 : 0,
    BestLap: best > 0 ? best / 1000 : 0,
    DistanceTraveled: distance,
    PositionX: graphics.readFloatLE(coordinateBase),
    PositionZ: graphics.readFloatLE(coordinateBase + 8),
    Yaw: physics.readFloatLE(EVO_PHYSICS.heading.offset),
    Fuel: physics.readFloatLE(EVO_PHYSICS.fuel.offset),
    TireWearFL: physics.readFloatLE(EVO_PHYSICS.tyreWearFL.offset),
    TireWearFR: physics.readFloatLE(EVO_PHYSICS.tyreWearFR.offset),
    TireWearRL: physics.readFloatLE(EVO_PHYSICS.tyreWearRL.offset),
    TireWearRR: physics.readFloatLE(EVO_PHYSICS.tyreWearRR.offset),
    RacePosition: racePosition,
    acc: { isValidLap, pitStatus, flagStatus, acEvo: { sessionType } as Pick<NonNullable<NonNullable<LapIndexPacket["acc"]>["acEvo"]>, "sessionType"> } as NonNullable<LapIndexPacket["acc"]>,
    WheelOnRumbleStripFL: 0,
    WheelOnRumbleStripFR: 0,
    WheelOnRumbleStripRL: 0,
    WheelOnRumbleStripRR: 0,
  };
}
