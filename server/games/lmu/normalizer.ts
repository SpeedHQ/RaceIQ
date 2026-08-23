import {
  lmuIdentityOrdinal,
  type LMUIdentityRecord,
} from "../../../shared/games/lmu";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { LMUExtendedData } from "../../../shared/telemetry/lmu";
import {
  LMU_SCORING_INFO,
  LMU_SCORING_VEHICLE,
  LMU_TELEMETRY,
  LMU_WHEEL,
  LMU_WHEEL_SIZE,
} from "./layout";
import { readCString, type LMUSourceFrameV1 } from "./source-frame";

const KELVIN_TO_CELSIUS = 273.15;
const KPA_TO_PSI = 0.1450377377;
const TWO_PI_PER_MINUTE = (Math.PI * 2) / 60;
const WHEEL_KEYS = ["FL", "FR", "RL", "RR"] as const;

type WheelKey = (typeof WHEEL_KEYS)[number];

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface NormalizedWheel {
  suspensionTravelM: number;
  brakeTemperatureC: number;
  rotationRadPerSecond: number;
  slipRatio: number;
  slipAngle: number;
  combinedSlip: number;
  pressurePsi: number;
  temperatureLeftC: number;
  temperatureMiddleC: number;
  temperatureRightC: number;
  temperatureAverageC: number;
  carcassTemperatureC: number;
  wear: number;
  onRumbleStrip: number;
}

function finiteDouble(buffer: Buffer, offset: number, fallback = 0): number {
  const value = buffer.readDoubleLE(offset);
  return Number.isFinite(value) ? value : fallback;
}

function finiteFloat(buffer: Buffer, offset: number, fallback = 0): number {
  const value = buffer.readFloatLE(offset);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function vector(buffer: Buffer, offset: number): Vec3 {
  return {
    x: finiteDouble(buffer, offset),
    y: finiteDouble(buffer, offset + 8),
    z: finiteDouble(buffer, offset + 16),
  };
}

function input255(value: number): number {
  return Math.round(clamp(value, 0, 1) * 255);
}

function canonicalGear(nativeGear: number): number {
  if (nativeGear < 0) return 0;
  if (nativeGear === 0) return 11;
  return Math.trunc(nativeGear);
}

function positiveTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function wheel(telemetry: Buffer, index: number): NormalizedWheel {
  const offset = LMU_TELEMETRY.wheels + index * LMU_WHEEL_SIZE;
  const longitudinalPatchVelocity = finiteDouble(
    telemetry,
    offset + LMU_WHEEL.longitudinalPatchVelocity,
  );
  const longitudinalGroundVelocity = finiteDouble(
    telemetry,
    offset + LMU_WHEEL.longitudinalGroundVelocity,
  );
  const lateralPatchVelocity = finiteDouble(
    telemetry,
    offset + LMU_WHEEL.lateralPatchVelocity,
  );
  const slipRatio =
    (longitudinalPatchVelocity - longitudinalGroundVelocity) /
    Math.max(Math.abs(longitudinalGroundVelocity), 1);
  const slipAngle = Math.atan2(
    lateralPatchVelocity,
    Math.max(Math.abs(longitudinalPatchVelocity), 0.1),
  );
  const left = finiteDouble(
    telemetry,
    offset + LMU_WHEEL.temperature,
    KELVIN_TO_CELSIUS,
  ) - KELVIN_TO_CELSIUS;
  const middle = finiteDouble(
    telemetry,
    offset + LMU_WHEEL.temperature + 8,
    KELVIN_TO_CELSIUS,
  ) - KELVIN_TO_CELSIUS;
  const right = finiteDouble(
    telemetry,
    offset + LMU_WHEEL.temperature + 16,
    KELVIN_TO_CELSIUS,
  ) - KELVIN_TO_CELSIUS;
  return {
    suspensionTravelM: finiteDouble(
      telemetry,
      offset + LMU_WHEEL.suspensionDeflection,
    ),
    brakeTemperatureC: finiteDouble(
      telemetry,
      offset + LMU_WHEEL.brakeTemperature,
    ),
    rotationRadPerSecond: finiteDouble(
      telemetry,
      offset + LMU_WHEEL.rotation,
    ),
    slipRatio,
    slipAngle,
    combinedSlip: Math.hypot(slipRatio, Math.tan(slipAngle)),
    pressurePsi:
      finiteDouble(telemetry, offset + LMU_WHEEL.pressureKpa) * KPA_TO_PSI,
    temperatureLeftC: left,
    temperatureMiddleC: middle,
    temperatureRightC: right,
    temperatureAverageC: (left + middle + right) / 3,
    carcassTemperatureC:
      finiteDouble(
        telemetry,
        offset + LMU_WHEEL.tireCarcassTemperature,
        KELVIN_TO_CELSIUS,
      ) - KELVIN_TO_CELSIUS,
    wear: clamp(finiteDouble(telemetry, offset + LMU_WHEEL.wear), 0, 1),
    onRumbleStrip:
      telemetry.readUInt8(offset + LMU_WHEEL.surfaceType) === 5 ? 1 : 0,
  };
}

function weatherType(raining: number, cloudCoverage: number): number {
  if (raining >= 0.66) return 4;
  if (raining > 0) return 3;
  if (cloudCoverage >= 4) return 2;
  if (cloudCoverage > 0) return 1;
  return 0;
}

export function identityFromLMUSourceFrame(
  frame: LMUSourceFrameV1,
): LMUIdentityRecord {
  const carName = readCString(
    frame.telemetry,
    LMU_TELEMETRY.vehicleName,
    64,
  );
  const carModel = readCString(
    frame.telemetry,
    LMU_TELEMETRY.vehicleModel,
    30,
  );
  const trackName =
    readCString(frame.scoringInfo, LMU_SCORING_INFO.trackName, 64) ||
    readCString(frame.telemetry, LMU_TELEMETRY.trackName, 64);
  const identityName = carModel || carName || "Unknown LMU car";
  const identityTrack = trackName || "Unknown LMU track";
  return {
    carId: lmuIdentityOrdinal("car", identityName),
    carName: identityName,
    trackId: lmuIdentityOrdinal("track", identityTrack),
    trackName: identityTrack,
  };
}

export function normalizeLMUSourceFrame(
  frame: LMUSourceFrameV1,
): TelemetryPacket {
  const telemetry = frame.telemetry;
  const scoringInfo = frame.scoringInfo;
  const scoring = frame.playerScoring;
  const identity = identityFromLMUSourceFrame(frame);
  const position = vector(telemetry, LMU_TELEMETRY.position);
  const localVelocity = vector(telemetry, LMU_TELEMETRY.localVelocity);
  const localAcceleration = vector(
    telemetry,
    LMU_TELEMETRY.localAcceleration,
  );
  const localRotation = vector(telemetry, LMU_TELEMETRY.localRotation);
  const orientation = [
    vector(telemetry, LMU_TELEMETRY.orientation),
    vector(telemetry, LMU_TELEMETRY.orientation + 24),
    vector(telemetry, LMU_TELEMETRY.orientation + 48),
  ];
  const forward = {
    x: -orientation[0].z,
    y: -orientation[1].z,
    z: -orientation[2].z,
  };
  const yaw = Math.atan2(forward.x, forward.z);
  const pitch = Math.asin(clamp(forward.y, -1, 1));
  const roll = Math.atan2(-orientation[1].x, orientation[1].y);
  const wheels = Object.fromEntries(
    WHEEL_KEYS.map((key, index) => [key, wheel(telemetry, index)]),
  ) as Record<WheelKey, NormalizedWheel>;

  const elapsedTime = Math.max(
    0,
    finiteDouble(telemetry, LMU_TELEMETRY.elapsedTime),
  );
  const lapStartElapsedTime = Math.max(
    0,
    finiteDouble(telemetry, LMU_TELEMETRY.lapStartElapsedTime),
  );
  const trackLengthM = Math.max(
    0,
    finiteDouble(scoringInfo, LMU_SCORING_INFO.lapDistance),
  );
  const lapDistanceM = scoring
    ? Math.max(0, finiteDouble(scoring, LMU_SCORING_VEHICLE.lapDistance))
    : 0;
  const completedLaps = scoring
    ? Math.max(0, scoring.readInt16LE(LMU_SCORING_VEHICLE.totalLaps))
    : Math.max(0, telemetry.readInt32LE(LMU_TELEMETRY.lapNumber) - 1);
  const currentSector = telemetry.readInt32LE(LMU_TELEMETRY.currentSector);
  const currentSectorIndex = currentSector & 0x7fffffff;
  const engineRpm = Math.max(
    0,
    finiteDouble(telemetry, LMU_TELEMETRY.engineRpm),
  );
  const engineTorque = finiteDouble(telemetry, LMU_TELEMETRY.engineTorque);
  const motorRpm = finiteDouble(
    telemetry,
    LMU_TELEMETRY.electricBoostMotorRpm,
  );
  const motorTorque = finiteDouble(
    telemetry,
    LMU_TELEMETRY.electricBoostMotorTorque,
  );
  const raining = clamp(
    finiteDouble(scoringInfo, LMU_SCORING_INFO.raining),
    0,
    1,
  );
  const cloudCoverage = scoringInfo.readUInt8(
    LMU_SCORING_INFO.cloudCoverage,
  );
  const driverName = scoring
    ? readCString(scoring, LMU_SCORING_VEHICLE.driverName, 32)
    : readCString(scoringInfo, LMU_SCORING_INFO.playerName, 32);
  const carName = readCString(
    telemetry,
    LMU_TELEMETRY.vehicleName,
    64,
  );
  const carModel = readCString(
    telemetry,
    LMU_TELEMETRY.vehicleModel,
    30,
  );
  const frontTireCompound = readCString(
    telemetry,
    LMU_TELEMETRY.frontTireCompoundName,
    18,
  );
  const rearTireCompound = readCString(
    telemetry,
    LMU_TELEMETRY.rearTireCompoundName,
    18,
  );
  const vehicleClass = telemetry.readUInt8(LMU_TELEMETRY.vehicleClass);
  const inPits = scoring
    ? scoring.readUInt8(LMU_SCORING_VEHICLE.inPits) !== 0
    : false;
  const lmu: LMUExtendedData = {
    gameVersion: frame.gameVersion,
    vehicleId: telemetry.readInt32LE(LMU_TELEMETRY.id),
    driverName,
    carName,
    carModel,
    vehicleClass,
    trackName: identity.trackName,
    trackLengthM,
    lapDistanceM,
    lapDistancePct:
      trackLengthM > 0 ? clamp(lapDistanceM / trackLengthM, 0, 1) : 0,
    currentSectorIndex,
    lapInvalidated:
      telemetry.readUInt8(LMU_TELEMETRY.lapInvalidated) !== 0,
    inPits,
    pitState: scoring
      ? scoring.readUInt8(LMU_SCORING_VEHICLE.pitState)
      : 0,
    frontTireCompound,
    rearTireCompound,
    rearFlapActivated:
      telemetry.readUInt8(LMU_TELEMETRY.rearFlapActivated) !== 0,
    rearFlapLegalStatus: telemetry.readUInt8(
      LMU_TELEMETRY.rearFlapLegalStatus,
    ),
    speedLimiterActive:
      telemetry.readUInt8(LMU_TELEMETRY.speedLimiterActive) !== 0,
    tcActive: telemetry.readUInt8(LMU_TELEMETRY.tcActive) !== 0,
    absActive: telemetry.readUInt8(LMU_TELEMETRY.absActive) !== 0,
    tcLevel: telemetry.readUInt8(LMU_TELEMETRY.tc),
    tcCutLevel: telemetry.readUInt8(LMU_TELEMETRY.tcCut),
    absLevel: telemetry.readUInt8(LMU_TELEMETRY.abs),
    motorMap: telemetry.readUInt8(LMU_TELEMETRY.motorMap),
    migration: telemetry.readUInt8(LMU_TELEMETRY.migration),
    frontAntiSway: telemetry.readUInt8(LMU_TELEMETRY.frontAntiSway),
    rearAntiSway: telemetry.readUInt8(LMU_TELEMETRY.rearAntiSway),
    batteryChargeFraction: clamp(
      finiteDouble(telemetry, LMU_TELEMETRY.batteryChargeFraction),
      0,
      1,
    ),
    stateOfCharge: finiteFloat(telemetry, LMU_TELEMETRY.stateOfCharge),
    virtualEnergy: finiteFloat(telemetry, LMU_TELEMETRY.virtualEnergy),
    regenKw: finiteFloat(telemetry, LMU_TELEMETRY.regenKw),
    trackLimitsSteps: telemetry.readUInt8(LMU_TELEMETRY.trackLimitsSteps),
    trackGripLevel: scoringInfo.readUInt8(
      LMU_SCORING_INFO.trackGripLevel,
    ),
    cloudCoverage,
  };

  return {
    gameId: "lmu",
    lmu,
    sessionUID: [
      frame.gameVersion,
      frame.sessionEvent,
      scoringInfo.readInt32LE(LMU_SCORING_INFO.session),
      identity.trackId,
      identity.carId,
    ].join(":"),
    IsRaceOn:
      scoringInfo.readUInt8(LMU_SCORING_INFO.inRealtime) !== 0 ? 1 : 0,
    TimestampMS: Math.round(frame.captureTimestampMs),
    EngineMaxRpm: Math.max(
      0,
      finiteDouble(telemetry, LMU_TELEMETRY.engineMaxRpm),
    ),
    EngineIdleRpm: 0,
    CurrentEngineRpm: engineRpm,
    AccelerationX: localAcceleration.x,
    AccelerationY: localAcceleration.y,
    AccelerationZ: -localAcceleration.z,
    VelocityX: localVelocity.x,
    VelocityY: localVelocity.y,
    VelocityZ: -localVelocity.z,
    AngularVelocityX: localRotation.x,
    AngularVelocityY: localRotation.y,
    AngularVelocityZ: localRotation.z,
    Yaw: yaw,
    Pitch: pitch,
    Roll: roll,
    NormSuspensionTravelFL: 0,
    NormSuspensionTravelFR: 0,
    NormSuspensionTravelRL: 0,
    NormSuspensionTravelRR: 0,
    TireSlipRatioFL: wheels.FL.slipRatio,
    TireSlipRatioFR: wheels.FR.slipRatio,
    TireSlipRatioRL: wheels.RL.slipRatio,
    TireSlipRatioRR: wheels.RR.slipRatio,
    WheelRotationSpeedFL: wheels.FL.rotationRadPerSecond,
    WheelRotationSpeedFR: wheels.FR.rotationRadPerSecond,
    WheelRotationSpeedRL: wheels.RL.rotationRadPerSecond,
    WheelRotationSpeedRR: wheels.RR.rotationRadPerSecond,
    WheelOnRumbleStripFL: wheels.FL.onRumbleStrip,
    WheelOnRumbleStripFR: wheels.FR.onRumbleStrip,
    WheelOnRumbleStripRL: wheels.RL.onRumbleStrip,
    WheelOnRumbleStripRR: wheels.RR.onRumbleStrip,
    WheelInPuddleDepthFL: 0,
    WheelInPuddleDepthFR: 0,
    WheelInPuddleDepthRL: 0,
    WheelInPuddleDepthRR: 0,
    SurfaceRumbleFL_2: 0,
    SurfaceRumbleFR_2: 0,
    SurfaceRumbleRL_2: 0,
    SurfaceRumbleRR_2: 0,
    TireSlipCombinedFL_2: wheels.FL.combinedSlip,
    TireTempFL: wheels.FL.temperatureAverageC,
    TireTempFR: wheels.FR.temperatureAverageC,
    TireTempRL: wheels.RL.temperatureAverageC,
    TireTempRR: wheels.RR.temperatureAverageC,
    TireCarcassTempFL: wheels.FL.carcassTemperatureC,
    TireCarcassTempFR: wheels.FR.carcassTemperatureC,
    TireCarcassTempRL: wheels.RL.carcassTemperatureC,
    TireCarcassTempRR: wheels.RR.carcassTemperatureC,
    TireCarcassTempLeftFL: wheels.FL.temperatureLeftC,
    TireCarcassTempLeftFR: wheels.FR.temperatureLeftC,
    TireCarcassTempLeftRL: wheels.RL.temperatureLeftC,
    TireCarcassTempLeftRR: wheels.RR.temperatureLeftC,
    TireCarcassTempMiddleFL: wheels.FL.temperatureMiddleC,
    TireCarcassTempMiddleFR: wheels.FR.temperatureMiddleC,
    TireCarcassTempMiddleRL: wheels.RL.temperatureMiddleC,
    TireCarcassTempMiddleRR: wheels.RR.temperatureMiddleC,
    TireCarcassTempRightFL: wheels.FL.temperatureRightC,
    TireCarcassTempRightFR: wheels.FR.temperatureRightC,
    TireCarcassTempRightRL: wheels.RL.temperatureRightC,
    TireCarcassTempRightRR: wheels.RR.temperatureRightC,
    Boost: 0,
    Fuel: Math.max(0, finiteDouble(telemetry, LMU_TELEMETRY.fuel)),
    FuelCapacity: Math.max(
      0,
      finiteDouble(telemetry, LMU_TELEMETRY.fuelCapacity),
    ),
    DistanceTraveled:
      completedLaps * trackLengthM + Math.max(0, lapDistanceM),
    BestLap: scoring
      ? positiveTime(finiteDouble(scoring, LMU_SCORING_VEHICLE.bestLapTime))
      : 0,
    LastLap: scoring
      ? positiveTime(finiteDouble(scoring, LMU_SCORING_VEHICLE.lastLapTime))
      : 0,
    CurrentLap: Math.max(0, elapsedTime - lapStartElapsedTime),
    CurrentRaceTime: elapsedTime,
    LapNumber: Math.max(
      0,
      telemetry.readInt32LE(LMU_TELEMETRY.lapNumber),
    ),
    RacePosition: scoring
      ? scoring.readUInt8(LMU_SCORING_VEHICLE.place)
      : 0,
    Accel: input255(finiteDouble(telemetry, LMU_TELEMETRY.throttle)),
    Brake: input255(finiteDouble(telemetry, LMU_TELEMETRY.brake)),
    Clutch: input255(finiteDouble(telemetry, LMU_TELEMETRY.clutch)),
    HandBrake: 0,
    Gear: canonicalGear(telemetry.readInt32LE(LMU_TELEMETRY.gear)),
    Steer: Math.round(
      clamp(finiteDouble(telemetry, LMU_TELEMETRY.steering), -1, 1) * 127,
    ),
    NormDrivingLine: 0,
    NormAIBrakeDiff: 0,
    TireWearFL: wheels.FL.wear,
    TireWearFR: wheels.FR.wear,
    TireWearRL: wheels.RL.wear,
    TireWearRR: wheels.RR.wear,
    SurfaceRumbleFL: 0,
    SurfaceRumbleFR: 0,
    SurfaceRumbleRL: 0,
    SurfaceRumbleRR: 0,
    TireSlipAngleFL: wheels.FL.slipAngle,
    TireSlipAngleFR: wheels.FR.slipAngle,
    TireSlipAngleRL: wheels.RL.slipAngle,
    TireSlipAngleRR: wheels.RR.slipAngle,
    TireCombinedSlipFL: wheels.FL.combinedSlip,
    TireCombinedSlipFR: wheels.FR.combinedSlip,
    TireCombinedSlipRL: wheels.RL.combinedSlip,
    TireCombinedSlipRR: wheels.RR.combinedSlip,
    SuspensionTravelMFL: wheels.FL.suspensionTravelM,
    SuspensionTravelMFR: wheels.FR.suspensionTravelM,
    SuspensionTravelMRL: wheels.RL.suspensionTravelM,
    SuspensionTravelMRR: wheels.RR.suspensionTravelM,
    CarOrdinal: identity.carId,
    CarClass: vehicleClass,
    CarPerformanceIndex: 0,
    DrivetrainType: 1,
    NumCylinders: 0,
    PositionX: position.x,
    PositionY: position.y,
    PositionZ: position.z,
    Speed: Math.hypot(
      localVelocity.x,
      localVelocity.y,
      localVelocity.z,
    ),
    Power:
      engineTorque * engineRpm * TWO_PI_PER_MINUTE +
      motorTorque * motorRpm * TWO_PI_PER_MINUTE,
    Torque: engineTorque + motorTorque,
    TrackOrdinal: identity.trackId,
    BrakeTempFrontLeft: wheels.FL.brakeTemperatureC,
    BrakeTempFrontRight: wheels.FR.brakeTemperatureC,
    BrakeTempRearLeft: wheels.RL.brakeTemperatureC,
    BrakeTempRearRight: wheels.RR.brakeTemperatureC,
    TirePressureFrontLeft: wheels.FL.pressurePsi,
    TirePressureFrontRight: wheels.FR.pressurePsi,
    TirePressureRearLeft: wheels.RL.pressurePsi,
    TirePressureRearRight: wheels.RR.pressurePsi,
    DrsActive: lmu.rearFlapActivated ? 1 : 0,
    TrackTemp: finiteDouble(
      scoringInfo,
      LMU_SCORING_INFO.trackTemperature,
    ),
    AirTemp: finiteDouble(
      scoringInfo,
      LMU_SCORING_INFO.ambientTemperature,
    ),
    RainPercent: Math.round(raining * 100),
    WeatherType: weatherType(raining, cloudCoverage),
  };
}
