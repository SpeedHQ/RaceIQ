/**
 * ACC parser: converts raw shared memory buffers into a TelemetryPacket.
 *
 * Offsets match ACC v1.9 shared memory structs defined in structs.ts.
 */

import type { TelemetryPacket, AccExtendedData } from "../../../shared/types";
import { PHYSICS, GRAPHICS, STATIC, FLAG_STATUS } from "./structs";
import { readWString } from "./utils";

/**
 * Parse the three ACC shared memory buffers into a unified TelemetryPacket.
 * Returns null if the buffers are too small.
 */
export function parseAccBuffers(
  physicsBuf: Buffer,
  graphicsBuf: Buffer,
  staticBuf: Buffer,
  overrides?: { carOrdinal?: number; trackOrdinal?: number }
): TelemetryPacket | null {
  if (
    physicsBuf.length < PHYSICS.SIZE ||
    graphicsBuf.length < GRAPHICS.SIZE ||
    staticBuf.length < STATIC.SIZE
  ) {
    return null;
  }

  // --- Physics ---
  const gas = physicsBuf.readFloatLE(PHYSICS.gas.offset);
  const brake = physicsBuf.readFloatLE(PHYSICS.brake.offset);
  const fuel = physicsBuf.readFloatLE(PHYSICS.fuel.offset);
  const accGear = physicsBuf.readInt32LE(PHYSICS.gear.offset);
  const rpms = physicsBuf.readInt32LE(PHYSICS.rpms.offset);
  const steerAngle = physicsBuf.readFloatLE(PHYSICS.steerAngle.offset);
  const speedKmh = physicsBuf.readFloatLE(PHYSICS.speedKmh.offset);

  const velX = physicsBuf.readFloatLE(PHYSICS.velocityX.offset);
  const velY = physicsBuf.readFloatLE(PHYSICS.velocityY.offset);
  const velZ = physicsBuf.readFloatLE(PHYSICS.velocityZ.offset);
  // Car-local angular velocity — yaw rate is the Y component (rad/s)
  const angVelX = physicsBuf.readFloatLE(PHYSICS.localAngularVelX.offset);
  const angVelY = physicsBuf.readFloatLE(PHYSICS.localAngularVelY.offset);
  const angVelZ = physicsBuf.readFloatLE(PHYSICS.localAngularVelZ.offset);
  const gX = physicsBuf.readFloatLE(PHYSICS.accGX.offset);
  const gY = physicsBuf.readFloatLE(PHYSICS.accGY.offset);
  const gZ = physicsBuf.readFloatLE(PHYSICS.accGZ.offset);

  const heading = physicsBuf.readFloatLE(PHYSICS.heading.offset);
  const pitch = physicsBuf.readFloatLE(PHYSICS.pitch.offset);
  const roll = physicsBuf.readFloatLE(PHYSICS.roll.offset);

  // Tire pressures (PSI)
  const pressFL = physicsBuf.readFloatLE(PHYSICS.tyrePressureFL.offset);
  const pressFR = physicsBuf.readFloatLE(PHYSICS.tyrePressureFR.offset);
  const pressRL = physicsBuf.readFloatLE(PHYSICS.tyrePressureRL.offset);
  const pressRR = physicsBuf.readFloatLE(PHYSICS.tyrePressureRR.offset);

  // Tire core temps (°C)
  const coreFL = physicsBuf.readFloatLE(PHYSICS.tyreCoreFL.offset);
  const coreFR = physicsBuf.readFloatLE(PHYSICS.tyreCoreFR.offset);
  const coreRL = physicsBuf.readFloatLE(PHYSICS.tyreCoreRL.offset);
  const coreRR = physicsBuf.readFloatLE(PHYSICS.tyreCoreRR.offset);

  // Tire display temps (°C) — averaged per-tire temp for display
  const tempFL = physicsBuf.readFloatLE(PHYSICS.tyreTempFL.offset);
  const tempFR = physicsBuf.readFloatLE(PHYSICS.tyreTempFR.offset);
  const tempRL = physicsBuf.readFloatLE(PHYSICS.tyreTempRL.offset);
  const tempRR = physicsBuf.readFloatLE(PHYSICS.tyreTempRR.offset);

  // Inner/middle/outer surface temps (°C)
  const innerFL = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerFL.offset);
  const innerFR = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerFR.offset);
  const innerRL = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerRL.offset);
  const innerRR = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerRR.offset);
  const outerFL = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterFL.offset);
  const outerFR = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterFR.offset);
  const outerRL = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterRL.offset);
  const outerRR = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterRR.offset);

  // Tire wear (0..1, higher = more worn)
  const wearFL = physicsBuf.readFloatLE(PHYSICS.tyreWearFL.offset);
  const wearFR = physicsBuf.readFloatLE(PHYSICS.tyreWearFR.offset);
  const wearRL = physicsBuf.readFloatLE(PHYSICS.tyreWearRL.offset);
  const wearRR = physicsBuf.readFloatLE(PHYSICS.tyreWearRR.offset);

  // Brake temps (°C)
  const brTempFL = physicsBuf.readFloatLE(PHYSICS.brakeTempFL.offset);
  const brTempFR = physicsBuf.readFloatLE(PHYSICS.brakeTempFR.offset);
  const brTempRL = physicsBuf.readFloatLE(PHYSICS.brakeTempRL.offset);
  const brTempRR = physicsBuf.readFloatLE(PHYSICS.brakeTempRR.offset);

  // Brake pad & disc life (mm remaining)
  const padFL = physicsBuf.readFloatLE(PHYSICS.padLifeFL.offset);
  const padFR = physicsBuf.readFloatLE(PHYSICS.padLifeFR.offset);
  const padRL = physicsBuf.readFloatLE(PHYSICS.padLifeRL.offset);
  const padRR = physicsBuf.readFloatLE(PHYSICS.padLifeRR.offset);

  // Suspension
  const suspFL = physicsBuf.readFloatLE(PHYSICS.suspTravelFL.offset);
  const suspFR = physicsBuf.readFloatLE(PHYSICS.suspTravelFR.offset);
  const suspRL = physicsBuf.readFloatLE(PHYSICS.suspTravelRL.offset);
  const suspRR = physicsBuf.readFloatLE(PHYSICS.suspTravelRR.offset);

  // Wheel slip & rotation
  // wheelSlip[4] at 56 is ACC's combined slip magnitude; slipRatio[4] at 640
  // is longitudinal and slipAngle[4] at 656 is lateral — all three are
  // exposed separately by ACC shared memory.
  const combinedSlipFL = physicsBuf.readFloatLE(PHYSICS.wheelSlipFL.offset);
  const combinedSlipFR = physicsBuf.readFloatLE(PHYSICS.wheelSlipFR.offset);
  const combinedSlipRL = physicsBuf.readFloatLE(PHYSICS.wheelSlipRL.offset);
  const combinedSlipRR = physicsBuf.readFloatLE(PHYSICS.wheelSlipRR.offset);
  const slipRatioFL = physicsBuf.readFloatLE(PHYSICS.slipRatioFL.offset);
  const slipRatioFR = physicsBuf.readFloatLE(PHYSICS.slipRatioFR.offset);
  const slipRatioRL = physicsBuf.readFloatLE(PHYSICS.slipRatioRL.offset);
  const slipRatioRR = physicsBuf.readFloatLE(PHYSICS.slipRatioRR.offset);
  const slipAngleFL = physicsBuf.readFloatLE(PHYSICS.slipAngleFL.offset);
  const slipAngleFR = physicsBuf.readFloatLE(PHYSICS.slipAngleFR.offset);
  const slipAngleRL = physicsBuf.readFloatLE(PHYSICS.slipAngleRL.offset);
  const slipAngleRR = physicsBuf.readFloatLE(PHYSICS.slipAngleRR.offset);
  const rotFL = physicsBuf.readFloatLE(PHYSICS.wheelRotFL.offset);
  const rotFR = physicsBuf.readFloatLE(PHYSICS.wheelRotFR.offset);
  const rotRL = physicsBuf.readFloatLE(PHYSICS.wheelRotRL.offset);
  const rotRR = physicsBuf.readFloatLE(PHYSICS.wheelRotRR.offset);

  // Damage (0..1)
  const damFront = physicsBuf.readFloatLE(PHYSICS.damFront.offset);
  const damRear = physicsBuf.readFloatLE(PHYSICS.damRear.offset);
  const damLeft = physicsBuf.readFloatLE(PHYSICS.damLeft.offset);
  const damRight = physicsBuf.readFloatLE(PHYSICS.damRight.offset);
  const damCentre = physicsBuf.readFloatLE(PHYSICS.damCentre.offset);

  // @ts-ignore
  const _tcPhysics = physicsBuf.readFloatLE(PHYSICS.tc.offset);
  // @ts-ignore
  const _absPhysics = physicsBuf.readFloatLE(PHYSICS.abs.offset);
  const brakeBias = physicsBuf.readFloatLE(PHYSICS.brakeBias.offset);
  const currentMaxRpm = physicsBuf.readInt32LE(PHYSICS.currentMaxRpm.offset);

  // --- Graphics ---
  const status = graphicsBuf.readInt32LE(GRAPHICS.status.offset);
  const completedLaps = graphicsBuf.readInt32LE(GRAPHICS.completedLaps.offset);
  const position = graphicsBuf.readInt32LE(GRAPHICS.position.offset);
  const iCurrentTime = graphicsBuf.readInt32LE(GRAPHICS.iCurrentTime.offset);
  const iLastTime = graphicsBuf.readInt32LE(GRAPHICS.iLastTime.offset);
  const iBestTime = graphicsBuf.readInt32LE(GRAPHICS.iBestTime.offset);
  const distanceTraveled = graphicsBuf.readFloatLE(GRAPHICS.distanceTraveled.offset);
  const isInPit = graphicsBuf.readInt32LE(GRAPHICS.isInPit.offset);
  const isInPitLane = graphicsBuf.readInt32LE(GRAPHICS.isInPitLane.offset);
  const currentSectorIndex = graphicsBuf.readInt32LE(GRAPHICS.currentSectorIndex.offset);
  const lastSectorTime = graphicsBuf.readInt32LE(GRAPHICS.lastSectorTime.offset);
  const flag = graphicsBuf.readInt32LE(GRAPHICS.flag.offset);

  // Car world position from graphics: find player slot via playerCarID
  const playerCarID = graphicsBuf.readInt32LE(GRAPHICS.playerCarID.offset);
  let playerSlot = 0;
  if (playerCarID > 0) {
    for (let i = 0; i < 60; i++) {
      if (graphicsBuf.readInt32LE(GRAPHICS.carIDBase.offset + i * 4) === playerCarID) {
        playerSlot = i;
        break;
      }
    }
  }
  const carX = graphicsBuf.readFloatLE(GRAPHICS.carCoordinatesBase.offset + playerSlot * 12);
  const carY = graphicsBuf.readFloatLE(GRAPHICS.carCoordinatesBase.offset + playerSlot * 12 + 4);
  const carZ = graphicsBuf.readFloatLE(GRAPHICS.carCoordinatesBase.offset + playerSlot * 12 + 8);

  // Electronics from graphics (integers, the "setting level" values)
  const tc = graphicsBuf.readInt32LE(GRAPHICS.tcGraphics.offset);
  const tcCut = graphicsBuf.readInt32LE(GRAPHICS.tcCut.offset);
  const engineMap = graphicsBuf.readInt32LE(GRAPHICS.engineMap.offset);
  const absLevel = graphicsBuf.readInt32LE(GRAPHICS.absGraphics.offset);
  const fuelPerLap = graphicsBuf.readFloatLE(GRAPHICS.fuelXLap.offset); // litres

  const windSpeed = graphicsBuf.readFloatLE(GRAPHICS.windSpeed.offset);
  const windDirection = graphicsBuf.readFloatLE(GRAPHICS.windDirection.offset);
  const rainTyres = graphicsBuf.readInt32LE(GRAPHICS.rainTyres.offset);

  const tireCompound = readWString(graphicsBuf, GRAPHICS.currentTyreCompound.offset, GRAPHICS.currentTyreCompound.size);

  // --- Static ---
  const maxRpm = staticBuf.readInt32LE(STATIC.maxRpm.offset);

  // --- Derived values ---
  const gear = accGear <= 1 ? 0 : accGear - 1;
  const accel = Math.round(gas * 255);
  const brakeVal = Math.round(brake * 255);
  const steer = Math.round(steerAngle * 127);
  const speed = speedKmh / 3.6;

  const INV = 0x7fffffff;
  const currentLap = iCurrentTime > 0 && iCurrentTime !== INV ? iCurrentTime / 1000 : 0;
  const lastLap = iLastTime > 0 && iLastTime !== INV ? iLastTime / 1000 : 0;
  const bestLap = iBestTime > 0 && iBestTime !== INV ? iBestTime / 1000 : 0;

  const trackGripStatus = "unknown"; // extended field, not in base .h
  const flagStatus = FLAG_STATUS[flag] ?? "none";

  let pitStatus = "out";
  if (isInPit) pitStatus = "in_pit";
  else if (isInPitLane) pitStatus = "pit_lane";

  const isRaceOn = status === 2 ? 1 : 0;

  const acc: AccExtendedData = {
    tireCompound: tireCompound || (rainTyres ? "wet_compound" : "dry_compound"),
    tireCoreTemp: [coreFL, coreFR, coreRL, coreRR],
    tireInnerTemp: [innerFL, innerFR, innerRL, innerRR],
    tireOuterTemp: [outerFL, outerFR, outerRL, outerRR],
    brakePadCompound: 0,
    brakePadWear: [padFL, padFR, padRL, padRR],
    tc,
    tcCut,
    abs: absLevel,
    engineMap,
    brakeBias,
    rainIntensity: 0,
    trackGripStatus,
    windSpeed,
    windDirection,
    flagStatus,
    drsAvailable: false,
    drsEnabled: false,
    pitStatus,
    fuelPerLap,
    currentSectorIndex,
    lastSectorTime,
    carDamage: {
      front: damFront,
      rear: damRear,
      left: damLeft,
      right: damRight,
      centre: damCentre,
    },
  };

  const packet: TelemetryPacket = {
    gameId: "acc",
    acc,
    IsRaceOn: isRaceOn,
    TimestampMS: Date.now(),

    EngineMaxRpm: currentMaxRpm || maxRpm,
    EngineIdleRpm: 0,
    CurrentEngineRpm: rpms,

    AccelerationX: gX * 9.81,
    AccelerationY: gY * 9.81,
    AccelerationZ: gZ * 9.81,
    VelocityX: velX,
    VelocityY: velY,
    VelocityZ: velZ,
    AngularVelocityX: angVelX,
    AngularVelocityY: angVelY,
    AngularVelocityZ: angVelZ,

    Yaw: heading,
    Pitch: pitch,
    Roll: roll,

    // Not provided by ACC — compute at display time from SuspensionTravelM
    NormSuspensionTravelFL: 0,
    NormSuspensionTravelFR: 0,
    NormSuspensionTravelRL: 0,
    NormSuspensionTravelRR: 0,

    TireSlipRatioFL: slipRatioFL,
    TireSlipRatioFR: slipRatioFR,
    TireSlipRatioRL: slipRatioRL,
    TireSlipRatioRR: slipRatioRR,

    WheelRotationSpeedFL: rotFL,
    WheelRotationSpeedFR: rotFR,
    WheelRotationSpeedRL: rotRL,
    WheelRotationSpeedRR: rotRR,

    WheelOnRumbleStripFL: 0,
    WheelOnRumbleStripFR: 0,
    WheelOnRumbleStripRL: 0,
    WheelOnRumbleStripRR: 0,
    WheelInPuddleDepthFL: 0,
    WheelInPuddleDepthFR: 0,
    WheelInPuddleDepthRL: 0,
    WheelInPuddleDepthRR: 0,
    SurfaceRumbleFL_2: 0,
    SurfaceRumbleFR_2: 0,
    SurfaceRumbleRL_2: 0,
    SurfaceRumbleRR_2: 0,
    TireSlipCombinedFL_2: 0,

    // Use display tire temp as primary
    TireTempFL: tempFL,
    TireTempFR: tempFR,
    TireTempRL: tempRL,
    TireTempRR: tempRR,

    Boost: 0,
    Fuel: fuel,
    DistanceTraveled: distanceTraveled,
    BestLap: bestLap,
    LastLap: lastLap,
    CurrentLap: currentLap,
    CurrentRaceTime: currentLap,

    LapNumber: completedLaps,
    RacePosition: position,

    Accel: accel,
    Brake: brakeVal,
    Clutch: 0,
    HandBrake: 0,
    Gear: gear,
    Steer: steer,
    NormDrivingLine: 0,
    NormAIBrakeDiff: 0,

    // Tire wear — ACC reports 0..1 (0 = new, 1 = gone), same convention as Forza
    TireWearFL: wearFL,
    TireWearFR: wearFR,
    TireWearRL: wearRL,
    TireWearRR: wearRR,

    SurfaceRumbleFL: 0,
    SurfaceRumbleFR: 0,
    SurfaceRumbleRL: 0,
    SurfaceRumbleRR: 0,
    TireSlipAngleFL: slipAngleFL,
    TireSlipAngleFR: slipAngleFR,
    TireSlipAngleRL: slipAngleRL,
    TireSlipAngleRR: slipAngleRR,
    TireCombinedSlipFL: combinedSlipFL,
    TireCombinedSlipFR: combinedSlipFR,
    TireCombinedSlipRL: combinedSlipRL,
    TireCombinedSlipRR: combinedSlipRR,

    // Suspension travel (meters)
    SuspensionTravelMFL: suspFL,
    SuspensionTravelMFR: suspFR,
    SuspensionTravelMRL: suspRL,
    SuspensionTravelMRR: suspRR,

    TirePressureFrontLeft: pressFL,
    TirePressureFrontRight: pressFR,
    TirePressureRearLeft: pressRL,
    TirePressureRearRight: pressRR,

    BrakeTempFrontLeft: brTempFL,
    BrakeTempFrontRight: brTempFR,
    BrakeTempRearLeft: brTempRL,
    BrakeTempRearRight: brTempRR,

    CarOrdinal: overrides?.carOrdinal ?? 0,
    CarClass: 0,
    CarPerformanceIndex: 0,
    DrivetrainType: 1,  // most GT3 are RWD
    NumCylinders: 0,

    PositionX: carX,
    PositionY: carY,
    PositionZ: carZ,
    Speed: speed,
    Power: 0,
    Torque: 0,
    TrackOrdinal: overrides?.trackOrdinal ?? 0,

    // Weather/track conditions
    WeatherType: rainTyres ? 3 : 0, // rough: wet tyres = rain
    TrackTemp: 0, // ACC doesn't expose track temp in base shared memory
    AirTemp: 0,
    RainPercent: 0,
  };

  return packet;
}
