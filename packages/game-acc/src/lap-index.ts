import type { LapIndexPacket } from "@raceiq/shared/telemetry/lap-index";
import { PHYSICS as ACC_PHYSICS, GRAPHICS as ACC_GRAPHICS, STATIC as ACC_STATIC, FLAG_STATUS } from "@raceiq/capture-formats/acc/structs";
import { readWString } from "./utils";
import { getAccParserCarByModel, getAccParserTrackByName } from "@raceiq/game-acc-metadata/parser-data-resolver";
import { SESSION_TYPE_NAMES } from "./parser";

/** Direct detector projection for packed ACC frames. No TelemetryPacket allocation. */
export function parseAccLapIndex(physics: Buffer, graphics: Buffer, stat: Buffer, carId: string, trackId: string, timestampMs = 0): LapIndexPacket | null {
  if (physics.length < ACC_PHYSICS.SIZE || graphics.length < ACC_GRAPHICS.MIN_SIZE || stat.length < ACC_STATIC.SIZE) return null;
  const cm = readWString(stat, ACC_STATIC.carModel.offset, ACC_STATIC.carModel.size);
  const tn = readWString(stat, ACC_STATIC.track.offset, ACC_STATIC.track.size);
  carId = String(getAccParserCarByModel(cm)?.id ?? carId);
  trackId = String(getAccParserTrackByName(tn)?.id ?? trackId);
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
  const sessionType = i(ACC_GRAPHICS.session.offset);
  const flagStatus = i(ACC_GRAPHICS.flag.offset);
  const packet: LapIndexPacket = {
    gameId: "acc", IsRaceOn: i(ACC_GRAPHICS.status.offset) === 2 ? 1 : 0, TimestampMS: timestampMs,
    carId, trackId, CarPerformanceIndex: 0, CarClass: 0, LapNumber: i(ACC_GRAPHICS.completedLaps.offset) + 1,
    CurrentLap: current > 0 && current !== 0x7fffffff ? current / 1000 : 0,
    LastLap: last > 0 && last !== 0x7fffffff ? last / 1000 : 0, BestLap: best > 0 && best !== 0x7fffffff ? best / 1000 : 0,
    DistanceTraveled: graphics.readFloatLE(ACC_GRAPHICS.distanceTraveled.offset), PositionX: graphics.readFloatLE(coord), PositionZ: graphics.readFloatLE(coord + 8),
    Yaw: f(ACC_PHYSICS.heading.offset), Fuel: f(ACC_PHYSICS.fuel.offset),
    TireWearFL: f(ACC_PHYSICS.tyreWearFL.offset), TireWearFR: f(ACC_PHYSICS.tyreWearFR.offset), TireWearRL: f(ACC_PHYSICS.tyreWearRL.offset), TireWearRR: f(ACC_PHYSICS.tyreWearRR.offset),
    RacePosition: i(ACC_GRAPHICS.position.offset), WheelOnRumbleStripFL: 0, WheelOnRumbleStripFR: 0, WheelOnRumbleStripRL: 0, WheelOnRumbleStripRR: 0,
    acc: { sessionType: SESSION_TYPE_NAMES[sessionType] ?? "unknown", flagStatus: FLAG_STATUS[flagStatus] ?? "none", pitStatus: i(ACC_GRAPHICS.isInPit.offset) ? "in_pit" : i(ACC_GRAPHICS.isInPitLane.offset) ? "pit_lane" : "out", currentSectorIndex: i(ACC_GRAPHICS.currentSectorIndex.offset), lastSectorTime: i(ACC_GRAPHICS.lastSectorTime.offset), isValidLap: graphics.length >= ACC_GRAPHICS.isValidLap.offset + 4 ? (i(ACC_GRAPHICS.isValidLap.offset) === 1 ? true : i(ACC_GRAPHICS.isValidLap.offset) === 0 ? false : null) : null } as never,
  };
  return packet;
}
