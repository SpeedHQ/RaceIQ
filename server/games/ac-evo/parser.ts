/**
 * AC Evo v0.6 parser: reads from SPageFilePhysics, SPageFileGraphicEvo, and
 * SPageFileStaticEvo directly (no longer routed through the ACC parser).
 *
 * Diverges from ACC: graphics layout is completely different, and identifiers
 * live in different pages:
 *   - car model: GRAPHICS_EVO.car_model (char[33])
 *   - track:     STATIC_EVO.track (char[33])
 *   - driver:    GRAPHICS_EVO.driver_name / driver_surname
 */

import type { TelemetryPacket, AccExtendedData, GameId } from "../../../shared/types";
import {
  PHYSICS,
  GRAPHICS_EVO,
  STATIC_EVO,
  ACEVO_STATUS,
  ACEVO_FLAG_NAMES,
  ACEVO_CAR_LOCATION,
} from "./structs";
import { readCString } from "./utils";
import { getAcEvoCarByDisplayName } from "../../../shared/ac-evo-car-data";
import { getAcEvoTrackByName } from "../../../shared/ac-evo-track-data";

const SLOT_CALIBRATION_FRAMES = 60;
const SPEED_THRESHOLD_KMH = 20;

export interface AcEvoParserCache {
  carOrdinal: number;
  trackOrdinal: number;
  lastCarModel: string;
  lastTrack: string;
  /** Locked player slot (-1 = not yet identified) */
  playerSlot: number;
  /** Per-slot cosine score accumulators */
  _slotScores: Float32Array;
  _scoredFrames: number;
  /** Previous coords per slot [slot*3 + xyz] */
  _prevCoords: Float32Array;
}

export function createAcEvoParserCache(): AcEvoParserCache {
  return {
    carOrdinal: 0,
    trackOrdinal: 0,
    lastCarModel: "",
    lastTrack: "",
    playerSlot: -1,
    _slotScores: new Float32Array(60),
    _scoredFrames: 0,
    _prevCoords: new Float32Array(60 * 3),
  };
}

export function parseAcEvoBuffers(
  physicsBuf: Buffer,
  graphicsBuf: Buffer,
  staticBuf: Buffer,
  cache: AcEvoParserCache,
): TelemetryPacket | null {
  if (
    physicsBuf.length < PHYSICS.SIZE ||
    graphicsBuf.length < GRAPHICS_EVO.SIZE ||
    staticBuf.length < STATIC_EVO.SIZE
  ) {
    return null;
  }

  // --- Identify car/track ---
  // v0.6 puts car_model inside GRAPHICS_EVO, track inside STATIC_EVO
  const carModelStr = readCString(graphicsBuf, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size);
  const trackStr = readCString(staticBuf, STATIC_EVO.track.offset, STATIC_EVO.track.size);

  if (carModelStr && carModelStr !== cache.lastCarModel) {
    cache.lastCarModel = carModelStr;
    const car = getAcEvoCarByDisplayName(carModelStr);
    if (car) {
      cache.carOrdinal = car.id;
    } else {
      cache.carOrdinal = 0;
      console.warn(`[AC Evo Parser] Unknown car "${carModelStr}" — add it to shared/games/ac-evo/cars.csv`);
    }
  }

  if (trackStr && trackStr !== cache.lastTrack) {
    cache.lastTrack = trackStr;
    const track = getAcEvoTrackByName(trackStr);
    if (track) {
      cache.trackOrdinal = track.id;
      console.log(`[AC Evo Parser] Resolved track: "${trackStr}" → ordinal ${track.id}`);
    } else {
      cache.trackOrdinal = 0;
      console.warn(`[AC Evo Parser] Unknown track name: "${trackStr}"`);
    }
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
  const angVelX = physicsBuf.readFloatLE(PHYSICS.localAngularVelX.offset);
  const angVelY = physicsBuf.readFloatLE(PHYSICS.localAngularVelY.offset);
  const angVelZ = physicsBuf.readFloatLE(PHYSICS.localAngularVelZ.offset);
  const gX = physicsBuf.readFloatLE(PHYSICS.accGX.offset);
  const gY = physicsBuf.readFloatLE(PHYSICS.accGY.offset);
  const gZ = physicsBuf.readFloatLE(PHYSICS.accGZ.offset);

  const heading = physicsBuf.readFloatLE(PHYSICS.heading.offset);
  const pitch = physicsBuf.readFloatLE(PHYSICS.pitch.offset);
  const roll = physicsBuf.readFloatLE(PHYSICS.roll.offset);

  const pressFL = physicsBuf.readFloatLE(PHYSICS.tyrePressureFL.offset);
  const pressFR = physicsBuf.readFloatLE(PHYSICS.tyrePressureFR.offset);
  const pressRL = physicsBuf.readFloatLE(PHYSICS.tyrePressureRL.offset);
  const pressRR = physicsBuf.readFloatLE(PHYSICS.tyrePressureRR.offset);

  const coreFL = physicsBuf.readFloatLE(PHYSICS.tyreCoreFL.offset);
  const coreFR = physicsBuf.readFloatLE(PHYSICS.tyreCoreFR.offset);
  const coreRL = physicsBuf.readFloatLE(PHYSICS.tyreCoreRL.offset);
  const coreRR = physicsBuf.readFloatLE(PHYSICS.tyreCoreRR.offset);

  const tempFL = physicsBuf.readFloatLE(PHYSICS.tyreTempFL.offset);
  const tempFR = physicsBuf.readFloatLE(PHYSICS.tyreTempFR.offset);
  const tempRL = physicsBuf.readFloatLE(PHYSICS.tyreTempRL.offset);
  const tempRR = physicsBuf.readFloatLE(PHYSICS.tyreTempRR.offset);

  const innerFL = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerFL.offset);
  const innerFR = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerFR.offset);
  const innerRL = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerRL.offset);
  const innerRR = physicsBuf.readFloatLE(PHYSICS.tyreTempInnerRR.offset);
  const outerFL = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterFL.offset);
  const outerFR = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterFR.offset);
  const outerRL = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterRL.offset);
  const outerRR = physicsBuf.readFloatLE(PHYSICS.tyreTempOuterRR.offset);

  const camberFL = physicsBuf.readFloatLE(PHYSICS.camberFL.offset);
  const camberFR = physicsBuf.readFloatLE(PHYSICS.camberFR.offset);
  const camberRL = physicsBuf.readFloatLE(PHYSICS.camberRL.offset);
  const camberRR = physicsBuf.readFloatLE(PHYSICS.camberRR.offset);

  const chBase = PHYSICS.contactHeadingBase.offset;
  const contactHeading: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ] = [
    [physicsBuf.readFloatLE(chBase), physicsBuf.readFloatLE(chBase + 4), physicsBuf.readFloatLE(chBase + 8)],
    [physicsBuf.readFloatLE(chBase + 12), physicsBuf.readFloatLE(chBase + 16), physicsBuf.readFloatLE(chBase + 20)],
    [physicsBuf.readFloatLE(chBase + 24), physicsBuf.readFloatLE(chBase + 28), physicsBuf.readFloatLE(chBase + 32)],
    [physicsBuf.readFloatLE(chBase + 36), physicsBuf.readFloatLE(chBase + 40), physicsBuf.readFloatLE(chBase + 44)],
  ];

  const wearFL = physicsBuf.readFloatLE(PHYSICS.tyreWearFL.offset);
  const wearFR = physicsBuf.readFloatLE(PHYSICS.tyreWearFR.offset);
  const wearRL = physicsBuf.readFloatLE(PHYSICS.tyreWearRL.offset);
  const wearRR = physicsBuf.readFloatLE(PHYSICS.tyreWearRR.offset);

  const brTempFL = physicsBuf.readFloatLE(PHYSICS.brakeTempFL.offset);
  const brTempFR = physicsBuf.readFloatLE(PHYSICS.brakeTempFR.offset);
  const brTempRL = physicsBuf.readFloatLE(PHYSICS.brakeTempRL.offset);
  const brTempRR = physicsBuf.readFloatLE(PHYSICS.brakeTempRR.offset);

  const padFL = physicsBuf.readFloatLE(PHYSICS.padLifeFL.offset);
  const padFR = physicsBuf.readFloatLE(PHYSICS.padLifeFR.offset);
  const padRL = physicsBuf.readFloatLE(PHYSICS.padLifeRL.offset);
  const padRR = physicsBuf.readFloatLE(PHYSICS.padLifeRR.offset);

  const suspFL = physicsBuf.readFloatLE(PHYSICS.suspTravelFL.offset);
  const suspFR = physicsBuf.readFloatLE(PHYSICS.suspTravelFR.offset);
  const suspRL = physicsBuf.readFloatLE(PHYSICS.suspTravelRL.offset);
  const suspRR = physicsBuf.readFloatLE(PHYSICS.suspTravelRR.offset);

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

  const damFront = physicsBuf.readFloatLE(PHYSICS.damFront.offset);
  const damRear = physicsBuf.readFloatLE(PHYSICS.damRear.offset);
  const damLeft = physicsBuf.readFloatLE(PHYSICS.damLeft.offset);
  const damRight = physicsBuf.readFloatLE(PHYSICS.damRight.offset);
  const damCentre = physicsBuf.readFloatLE(PHYSICS.damCentre.offset);

  const tcFloat = physicsBuf.readFloatLE(PHYSICS.tc.offset);
  const absFloat = physicsBuf.readFloatLE(PHYSICS.abs.offset);
  const slipVib = physicsBuf.readFloatLE(PHYSICS.slipVibrations.offset);
  const absVib = physicsBuf.readFloatLE(PHYSICS.absVibrations.offset);
  const brakeBias = physicsBuf.readFloatLE(PHYSICS.brakeBias.offset);
  const currentMaxRpm = physicsBuf.readInt32LE(PHYSICS.currentMaxRpm.offset);

  // --- Graphics (v0.6) ---
  const status = graphicsBuf.readInt32LE(GRAPHICS_EVO.status.offset);
  const completedLaps = graphicsBuf.readInt32LE(GRAPHICS_EVO.total_lap_count.offset);
  const position = graphicsBuf.readUInt32LE(GRAPHICS_EVO.current_pos.offset);
  const iCurrentTime = graphicsBuf.readInt32LE(GRAPHICS_EVO.current_lap_time_ms.offset);
  const iLastTime = graphicsBuf.readInt32LE(GRAPHICS_EVO.last_laptime_ms.offset);
  const iBestTime = graphicsBuf.readInt32LE(GRAPHICS_EVO.best_laptime_ms.offset);
  const currentKm = graphicsBuf.readFloatLE(GRAPHICS_EVO.current_km.offset);
  const normalizedCarPos = graphicsBuf.readFloatLE(GRAPHICS_EVO.npos.offset);
  const carLocation = graphicsBuf.readInt32LE(GRAPHICS_EVO.car_location.offset);
  const flagRaw = graphicsBuf.readInt32LE(GRAPHICS_EVO.flag.offset);
  const isInPitBox = graphicsBuf.readUInt8(GRAPHICS_EVO.is_in_pit_box.offset);
  const isInPitLane = graphicsBuf.readUInt8(GRAPHICS_EVO.is_in_pit_lane.offset);
  const isValidLap = graphicsBuf.readUInt8(GRAPHICS_EVO.is_valid_lap.offset);
  const activeCars = graphicsBuf.readUInt8(GRAPHICS_EVO.active_cars.offset);

  const tcActiveBool = graphicsBuf.readUInt8(GRAPHICS_EVO.tc_active.offset);
  const absActiveBool = graphicsBuf.readUInt8(GRAPHICS_EVO.abs_active.offset);
  const tcActive = tcActiveBool || tcFloat > 0.01 || slipVib > 0.01 ? 1 : 0;
  const absActive = absActiveBool || absFloat > 0.01 || absVib > 0.01 ? 1 : 0;

  // Electronics (setting-level integers) — from embedded Electronics sub-struct
  const elecBase = GRAPHICS_EVO.electronics_base.offset;
  const tcLevel = graphicsBuf.readInt8(elecBase + 0);     // tc_level
  const tcCutLevel = graphicsBuf.readInt8(elecBase + 1);  // tc_cut_level
  const absLevel = graphicsBuf.readInt8(elecBase + 2);    // abs_level
  const engineMapLevel = graphicsBuf.readInt8(elecBase + 12); // engine_map_level

  // Tyre compound from front-left tyre state (FL and FR share tyre_compound_front)
  const tyreLfBase = GRAPHICS_EVO.tyre_lf_base.offset;
  const tyreCompound = readCString(graphicsBuf, tyreLfBase + 36, 33);

  // Fuel projection
  const fuelPerLap = graphicsBuf.readFloatLE(GRAPHICS_EVO.fuel_per_lap.offset);

  // Player slot calibration (same velocity-correlation technique)
  if (cache.playerSlot === -1) {
    calibratePlayerSlot(physicsBuf, graphicsBuf, cache, activeCars);
  }
  const playerSlot = cache.playerSlot === -1 ? 0 : cache.playerSlot;
  const coordBase = GRAPHICS_EVO.car_coordinates_base.offset;
  const carX = graphicsBuf.readFloatLE(coordBase + playerSlot * 12);
  const carY = graphicsBuf.readFloatLE(coordBase + playerSlot * 12 + 4);
  const carZ = graphicsBuf.readFloatLE(coordBase + playerSlot * 12 + 8);

  // --- Static (v0.6) ---
  const startingAmbient = staticBuf.readFloatLE(STATIC_EVO.starting_ambient_temperature_c.offset);
  const startingGround = staticBuf.readFloatLE(STATIC_EVO.starting_ground_temperature_c.offset);
  const trackLengthM = staticBuf.readFloatLE(STATIC_EVO.track_length_m.offset);

  // --- Derived ---
  const gear = accGear <= 1 ? 0 : accGear - 1;
  const accel = Math.round(gas * 255);
  const brakeVal = Math.round(brake * 255);
  const steer = Math.round(steerAngle * 127);
  const speed = speedKmh / 3.6;

  const INV = 0x7fffffff;
  const currentLap = iCurrentTime > 0 && iCurrentTime !== INV ? iCurrentTime / 1000 : 0;
  const lastLap = iLastTime > 0 && iLastTime !== INV ? iLastTime / 1000 : 0;
  const bestLap = iBestTime > 0 && iBestTime !== INV ? iBestTime / 1000 : 0;
  const distanceTraveled = currentKm * 1000; // km → m

  const flagStatus = ACEVO_FLAG_NAMES[flagRaw] ?? "none";

  let pitStatus = "out";
  if (isInPitBox) pitStatus = "in_pit";
  else if (isInPitLane || carLocation === ACEVO_CAR_LOCATION.ACEVO_PITLANE) pitStatus = "pit_lane";
  else if (carLocation === ACEVO_CAR_LOCATION.ACEVO_UNASSIGNED) {
    // Pre-session / pre-spawn frames have car_location=UNASSIGNED and all
    // pit flags zero. Driver hasn't moved yet — safest assumption is "in pit
    // garage", so downstream lap detection correctly classifies the first
    // driven lap as an outlap.
    pitStatus = "in_pit";
  }

  const isRaceOn = status === ACEVO_STATUS.AC_LIVE ? 1 : 0;

  const acc: AccExtendedData = {
    tireCompound: tyreCompound || "dry_compound",
    tireCoreTemp: [coreFL, coreFR, coreRL, coreRR],
    tireInnerTemp: [innerFL, innerFR, innerRL, innerRR],
    tireOuterTemp: [outerFL, outerFR, outerRL, outerRR],
    tireCamber: [camberFL, camberFR, camberRL, camberRR],
    tireRadius: [0, 0, 0, 0], // not in v0.6 static
    tireContactHeading: contactHeading,
    brakePadCompound: 0,
    brakePadWear: [padFL, padFR, padRL, padRR],
    tc: tcLevel,
    tcCut: tcCutLevel,
    abs: absLevel,
    engineMap: engineMapLevel,
    brakeBias,
    tcIntervention: tcActive,
    absIntervention: absActive,
    tcRaw: tcFloat,
    absRaw: absFloat,
    slipVibrations: slipVib,
    absVibrations: absVib,
    rainIntensity: 0,
    trackGripStatus: "unknown",
    windSpeed: 0,
    windDirection: 0,
    flagStatus,
    drsAvailable: false,
    drsEnabled: false,
    pitStatus,
    fuelPerLap,
    currentSectorIndex: -1,
    lastSectorTime: 0,
    carDamage: {
      front: damFront,
      rear: damRear,
      left: damLeft,
      right: damRight,
      centre: damCentre,
    },
  };

  // Expose AC Evo-specific extras on the acc object for downstream use
  (acc as any).normalizedCarPosition = normalizedCarPos;
  (acc as any).isValidLap = isValidLap ? 1 : 0;
  (acc as any).trackLengthM = trackLengthM;

  const packet: TelemetryPacket = {
    gameId: "ac-evo" as GameId,
    acc,
    IsRaceOn: isRaceOn,
    TimestampMS: Date.now(),

    EngineMaxRpm: currentMaxRpm || 0,
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

    // v0.6 signed travel (0 = rest, + = compression, - = extension).
    // Encode as centered 0–1 so the bar fills correctly: 0.5 = rest,
    // >0.5 = compressed, <0.5 = extended. ±50 mm assumed full range.
    // SuspensionTravelMFL carries the raw metres for the mm display label.
    NormSuspensionTravelFL: Math.max(0, Math.min(1, 0.5 + suspFL / 0.1)),
    NormSuspensionTravelFR: Math.max(0, Math.min(1, 0.5 + suspFR / 0.1)),
    NormSuspensionTravelRL: Math.max(0, Math.min(1, 0.5 + suspRL / 0.1)),
    NormSuspensionTravelRR: Math.max(0, Math.min(1, 0.5 + suspRR / 0.1)),

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

    CarOrdinal: cache.carOrdinal,
    CarClass: 0,
    CarPerformanceIndex: 0,
    DrivetrainType: 1,
    NumCylinders: 0,

    PositionX: carX,
    PositionY: carY,
    PositionZ: carZ,
    Speed: speed,
    Power: 0,
    Torque: 0,
    TrackOrdinal: cache.trackOrdinal,

    WeatherType: 0,
    TrackTemp: startingGround,
    AirTemp: startingAmbient,
    RainPercent: 0,
  };

  return packet;
}

/**
 * Correlate physics velocity direction with per-slot coordinate deltas to
 * identify which car slot is the player's. v0.6 doesn't expose a per-slot
 * car ID array, so we have to infer.
 */
function calibratePlayerSlot(
  physicsBuf: Buffer,
  graphicsBuf: Buffer,
  cache: AcEvoParserCache,
  activeCars: number,
): void {
  const speedKmh = physicsBuf.readFloatLE(PHYSICS.speedKmh.offset);
  if (speedKmh < SPEED_THRESHOLD_KMH) return;

  const velX = physicsBuf.readFloatLE(PHYSICS.velocityX.offset);
  const velZ = physicsBuf.readFloatLE(PHYSICS.velocityZ.offset);
  const velMag = Math.sqrt(velX * velX + velZ * velZ);
  if (velMag < 0.1) return;

  const coordBase = GRAPHICS_EVO.car_coordinates_base.offset;
  const slotCount = Math.min(activeCars || 1, 60);

  for (let i = 0; i < slotCount; i++) {
    const x = graphicsBuf.readFloatLE(coordBase + i * 12);
    const z = graphicsBuf.readFloatLE(coordBase + i * 12 + 8);
    const prevX = cache._prevCoords[i * 3];
    const prevZ = cache._prevCoords[i * 3 + 2];

    const dx = x - prevX;
    const dz = z - prevZ;
    const dMag = Math.sqrt(dx * dx + dz * dz);

    if (dMag > 0.01) {
      const cosine = (velX * dx + velZ * dz) / (velMag * dMag);
      cache._slotScores[i] += cosine;
    }

    cache._prevCoords[i * 3] = x;
    cache._prevCoords[i * 3 + 2] = z;
  }

  cache._scoredFrames++;

  if (cache._scoredFrames >= SLOT_CALIBRATION_FRAMES) {
    let bestSlot = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < 60; i++) {
      if (cache._slotScores[i] > bestScore) {
        bestScore = cache._slotScores[i];
        bestSlot = i;
      }
    }
    cache.playerSlot = bestSlot;
    console.log(`[AC Evo Parser] Player slot locked: ${bestSlot} (score ${bestScore.toFixed(1)} after ${cache._scoredFrames} frames)`);
  }
}
