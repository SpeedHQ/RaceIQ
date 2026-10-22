import type { LMUIdentityRecord } from "@raceiq/game-lmu-metadata/index";
import {
  resolveLMUCar,
  resolveLMUTrack,
} from "@raceiq/game-lmu-metadata/catalog";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LMUExtendedData } from "@raceiq/shared/telemetry/lmu";
import {
  LMU_SCORING_INFO,
  LMU_SCORING_VEHICLE,
  LMU_TELEMETRY,
  LMU_WHEEL,
  LMU_WHEEL_SIZE,
} from "@raceiq/capture-formats/lmu/layout";
import { readCString, type LMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";

const KELVIN_TO_CELSIUS = 273.15;

const LMU_SESSION_TYPES: Readonly<Record<number, string>> = {
  0: "test-day",
  1: "practice-1",
  2: "practice-2",
  3: "practice-3",
  4: "practice-4",
  5: "qualifying-1",
  6: "qualifying-2",
  7: "qualifying-3",
  8: "qualifying-4",
  9: "warmup",
  10: "race",
  11: "race-2",
  12: "race-3",
  13: "race-4",
};
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nativeFraction(value: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : NaN;
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
    longitudinalPatchVelocity /
    Math.max(Math.abs(longitudinalGroundVelocity), 1);
  const slipAngle = Math.atan2(
    lateralPatchVelocity,
    Math.max(Math.abs(longitudinalGroundVelocity), 0.1),
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
    // LMU reports remaining tire health; RaceIQ packet field stores consumed wear.
    wear: 1 - clamp(finiteDouble(telemetry, offset + LMU_WHEEL.wear), 0, 1),
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
  frame: LMUSourceFrame,
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
  const scoringTrackName = readCString(
    frame.scoringInfo,
    LMU_SCORING_INFO.trackName,
    64,
  );
  const telemetryTrackName = readCString(
    frame.telemetry,
    LMU_TELEMETRY.trackName,
    64,
  );
  const carId = carModel || carName;
  const trackId = scoringTrackName || telemetryTrackName;
  const canonicalCar = resolveLMUCar(carId, carName);
  const canonicalTrack = resolveLMUTrack(
    scoringTrackName,
    telemetryTrackName,
  );
  return {
    carId: canonicalCar?.id ?? carId,
    carName,
    carModel,
    trackId: canonicalTrack?.id ?? trackId,
    trackName: trackId,
  };
}

const syntheticExtensionChannels: Partial<Record<keyof LMUExtendedData, string>> = {
  bestSector1: "Best Sector 1",
  bestSector2: "Best Sector 2",
  brake: "Brake Pos Unfiltered",
  clutch: "Clutch Pos Unfiltered",
  currentSector1: "Current Sector 1",
  currentSector2: "Current Sector 2",
  currentSectorIndex: "Current Sector",
  engineRpm: "Engine RPM",
  frontTireCompound: "TyresCompound",
  inPits: "In Pits",
  lastSector1: "Last Sector 1",
  lastSector2: "Last Sector 2",
  lapDistanceM: "Lap Dist",
  lapDistancePct: "Lap Dist",
  rearFlapActivated: "RearFlapActivated",
  rearTireCompound: "TyresCompound",
  regenKw: "Regen Rate",
  speedLimiterActive: "Speed Limiter",
  stateOfCharge: "SoC",
  tcActive: "TC",
  throttle: "Throttle Pos Unfiltered",
  steering: "Steering Pos Unfiltered",
  virtualEnergy: "Virtual Energy",
  absLevel: "ABSLevel",
};

export function normalizeLMUSourceFrame(
  frame: LMUSourceFrame,
): TelemetryPacket {
  const telemetry = frame.telemetry;
  const scoringInfo = frame.scoringInfo;
  const scoring = frame.playerScoring;
  const identity = identityFromLMUSourceFrame(frame);
  const sessionTypeOrdinal = scoringInfo.readInt32LE(LMU_SCORING_INFO.session);
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
  const nativeLapDistanceM = scoring ? scoring.readDoubleLE(LMU_SCORING_VEHICLE.lapDistance) : NaN;
  const lapDistanceM = Number.isFinite(nativeLapDistanceM) ? Math.max(0, nativeLapDistanceM) : 0;
  const lapDistancePct = trackLengthM > 0 && Number.isFinite(nativeLapDistanceM) && nativeLapDistanceM >= 0 && nativeLapDistanceM <= trackLengthM
    ? nativeLapDistanceM / trackLengthM : undefined;
  const completedLaps = scoring
    ? Math.max(0, scoring.readInt16LE(LMU_SCORING_VEHICLE.totalLaps))
    : Math.max(0, telemetry.readInt32LE(LMU_TELEMETRY.lapNumber) - 1);
  const currentSector = telemetry.readInt32LE(LMU_TELEMETRY.currentSector);
  const currentSectorIndex = currentSector & 0x7fffffff;
  const positiveScoringTime = (offset: number) => {
    if (!scoring) return undefined;
    const value = scoring.readDoubleLE(offset);
    return value < 0 ? undefined : value;
  };
  const engineRpm = telemetry.readDoubleLE(LMU_TELEMETRY.engineRpm);
  const engineTorque = telemetry.readDoubleLE(LMU_TELEMETRY.engineTorque);
  const motorRpm = telemetry.readDoubleLE(LMU_TELEMETRY.electricBoostMotorRpm);
  const motorTorque = telemetry.readDoubleLE(LMU_TELEMETRY.electricBoostMotorTorque);
  const motorState = telemetry.readUInt8(LMU_TELEMETRY.electricBoostMotorState);
  const stateOfCharge = telemetry.readFloatLE(LMU_TELEMETRY.stateOfCharge);
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
  const syntheticChannels = frame.syntheticChannels === undefined
    ? null
    : new Set(frame.syntheticChannels);
  const channelAvailable = (channel: string) =>
    frame.schemaVersion !== 4 || syntheticChannels?.has(channel) === true;
  const extensionAvailable = (field: keyof LMUExtendedData) => {
    if (frame.schemaVersion !== 4) return true;
    const channel = syntheticExtensionChannels[field];
    return channel !== undefined && channelAvailable(channel);
  };
  const telemetryElapsedTime = telemetry.readDoubleLE(LMU_TELEMETRY.elapsedTime);
  const scoringElapsedTime = scoringInfo.readDoubleLE(LMU_SCORING_INFO.currentElapsedTime);
  const lmu: LMUExtendedData = {
    carId: identity.carId,
    trackId: identity.trackId,
    gameVersion: frame.gameVersion,
    ...(frame.schemaVersion !== 4 && Number.isFinite(telemetryElapsedTime) && telemetryElapsedTime >= 0 ? { telemetryElapsedTime } : {}),
    ...(frame.schemaVersion !== 4 && Number.isFinite(scoringElapsedTime) && scoringElapsedTime >= 0 ? { scoringElapsedTime } : {}),
    sessionType: LMU_SESSION_TYPES[sessionTypeOrdinal] ?? "unknown",
    sessionTypeOrdinal,
    ...(extensionAvailable("deltaBest") ? { deltaBest: finiteDouble(telemetry, LMU_TELEMETRY.deltaBest) } : {}),
    ...(extensionAvailable("vehicleId") ? { vehicleId: telemetry.readInt32LE(LMU_TELEMETRY.id) } : {}),
    driverName,
    carName,
    carModel,
    vehicleClass,
    trackName: identity.trackName,
    trackLengthM,
    ...(extensionAvailable("lapDistanceM") ? { lapDistanceM } : {}),
    ...(extensionAvailable("lapDistancePct") && lapDistancePct != null ? { lapDistancePct } : {}),
    ...(extensionAvailable("currentSectorIndex") ? { currentSectorIndex } : {}),
    ...(extensionAvailable("bestSector1") ? { bestSector1: positiveScoringTime(LMU_SCORING_VEHICLE.bestSector1) } : {}),
    ...(extensionAvailable("bestSector2") ? { bestSector2: positiveScoringTime(LMU_SCORING_VEHICLE.bestSector2) } : {}),
    ...(extensionAvailable("lastSector1") ? { lastSector1: positiveScoringTime(LMU_SCORING_VEHICLE.lastSector1) } : {}),
    ...(extensionAvailable("lastSector2") ? { lastSector2: positiveScoringTime(LMU_SCORING_VEHICLE.lastSector2) } : {}),
    ...(extensionAvailable("currentSector1") ? { currentSector1: positiveScoringTime(LMU_SCORING_VEHICLE.currentSector1) } : {}),
    ...(extensionAvailable("currentSector2") ? { currentSector2: positiveScoringTime(LMU_SCORING_VEHICLE.currentSector2) } : {}),
    ...(frame.schemaVersion !== 4 && channelAvailable("Lap Invalidated") ? {
      lapInvalidated: telemetry.readUInt8(LMU_TELEMETRY.lapInvalidated) !== 0,
    } : {}),
    ...(extensionAvailable("inPits") ? { inPits } : {}),
    ...(frame.schemaVersion !== 4 && scoring ? {
      pitState: scoring.readUInt8(LMU_SCORING_VEHICLE.pitState),
    } : {}),
    ...(extensionAvailable("frontTireCompound") ? { frontTireCompound } : {}),
    ...(extensionAvailable("rearTireCompound") ? { rearTireCompound } : {}),
    ...(extensionAvailable("rearFlapActivated") ? {
      rearFlapActivated: telemetry.readUInt8(LMU_TELEMETRY.rearFlapActivated) !== 0,
    } : {}),
    ...(frame.schemaVersion !== 4 ? {
      rearFlapLegalStatus: telemetry.readUInt8(LMU_TELEMETRY.rearFlapLegalStatus),
    } : {}),
    ...(extensionAvailable("speedLimiterActive") ? {
      speedLimiterActive: telemetry.readUInt8(LMU_TELEMETRY.speedLimiterActive) !== 0,
    } : {}),
    ...(extensionAvailable("tcActive") ? {
      tcActive: telemetry.readUInt8(LMU_TELEMETRY.tcActive) !== 0,
    } : {}),
    ...(frame.schemaVersion !== 4 ? {
      absActive: telemetry.readUInt8(LMU_TELEMETRY.absActive) !== 0,
      tcCutLevel: telemetry.readUInt8(LMU_TELEMETRY.tcCut),
    } : {}),
    ...(extensionAvailable("tcLevel") ? { tcLevel: telemetry.readUInt8(LMU_TELEMETRY.tc) } : {}),
    ...(extensionAvailable("absLevel") ? { absLevel: telemetry.readUInt8(LMU_TELEMETRY.abs) } : {}),
    ...(extensionAvailable("motorMap") ? { motorMap: telemetry.readUInt8(LMU_TELEMETRY.motorMap) } : {}),
    ...(extensionAvailable("migration") ? { migration: telemetry.readUInt8(LMU_TELEMETRY.migration) } : {}),
    ...(extensionAvailable("frontAntiSway") ? { frontAntiSway: telemetry.readUInt8(LMU_TELEMETRY.frontAntiSway) } : {}),
    ...(extensionAvailable("rearAntiSway") ? { rearAntiSway: telemetry.readUInt8(LMU_TELEMETRY.rearAntiSway) } : {}),
    ...(extensionAvailable("batteryChargeFraction") ? {
      batteryChargeFraction: nativeFraction(telemetry.readDoubleLE(LMU_TELEMETRY.batteryChargeFraction)),
    } : {}),
    ...(extensionAvailable("stateOfCharge") && stateOfCharge >= 0 && stateOfCharge <= 100 ? { stateOfCharge } : {}),
    ...(extensionAvailable("virtualEnergy") ? { virtualEnergy: nativeFraction(telemetry.readFloatLE(LMU_TELEMETRY.virtualEnergy)) } : {}),
    ...(extensionAvailable("regenKw") ? { regenKw: telemetry.readFloatLE(LMU_TELEMETRY.regenKw) } : {}),
    ...(extensionAvailable("trackLimitsSteps") ? { trackLimitsSteps: telemetry.readUInt8(LMU_TELEMETRY.trackLimitsSteps) } : {}),
    ...(frame.schemaVersion !== 4 && channelAvailable("Track Grip") ? {
      trackGripLevel: scoringInfo.readUInt8(LMU_SCORING_INFO.trackGripLevel),
    } : {}),
    ...(frame.schemaVersion !== 4 && channelAvailable("Cloud Coverage") ? { cloudCoverage } : {}),
    ...(extensionAvailable("engineRpm") ? { engineRpm } : {}),
    ...(frame.schemaVersion !== 4 && channelAvailable("Engine Water Temp") ? {
      engineWaterTemp: telemetry.readDoubleLE(LMU_TELEMETRY.engineWaterTemp),
    } : {}),
    ...(frame.schemaVersion !== 4 && channelAvailable("Engine Oil Temp") ? {
      engineOilTemp: telemetry.readDoubleLE(LMU_TELEMETRY.engineOilTemp),
    } : {}),
    ...(extensionAvailable("engineTorque") ? { engineTorque } : {}),
    ...(frame.schemaVersion !== 4 && motorState > 0 ? {
      motorRpm,
      motorTorque,
      motorTemperature: telemetry.readDoubleLE(LMU_TELEMETRY.electricBoostMotorTemperature),
      motorWaterTemperature: telemetry.readDoubleLE(LMU_TELEMETRY.electricBoostWaterTemperature),
    } : {}),
    ...(extensionAvailable("motorState") ? { motorState } : {}),
    ...(frame.schemaVersion !== 4 && channelAvailable("Steering Shaft Torque") ? {
      steeringShaftTorque: telemetry.readDoubleLE(LMU_TELEMETRY.steeringShaftTorque),
    } : {}),
    ...(extensionAvailable("throttle") ? { throttle: telemetry.readDoubleLE(LMU_TELEMETRY.throttle) } : {}),
    ...(extensionAvailable("brake") ? { brake: telemetry.readDoubleLE(LMU_TELEMETRY.brake) } : {}),
    ...(extensionAvailable("steering") ? { steering: telemetry.readDoubleLE(LMU_TELEMETRY.steering) } : {}),
    ...(extensionAvailable("clutch") ? { clutch: telemetry.readDoubleLE(LMU_TELEMETRY.clutch) } : {}),
    ...(extensionAvailable("timeGapCarAhead") ? { timeGapCarAhead: telemetry.readFloatLE(LMU_TELEMETRY.timeGapCarAhead) } : {}),
    ...(extensionAvailable("timeGapCarBehind") ? { timeGapCarBehind: telemetry.readFloatLE(LMU_TELEMETRY.timeGapCarBehind) } : {}),
    ...(extensionAvailable("timeGapPlaceAhead") ? { timeGapPlaceAhead: telemetry.readFloatLE(LMU_TELEMETRY.timeGapPlaceAhead) } : {}),
    ...(extensionAvailable("timeGapPlaceBehind") ? { timeGapPlaceBehind: telemetry.readFloatLE(LMU_TELEMETRY.timeGapPlaceBehind) } : {}),
    ...(extensionAvailable("rainIntensity") ? {
      rainIntensity: nativeFraction(scoringInfo.readDoubleLE(LMU_SCORING_INFO.raining)),
    } : {}),
    ...(extensionAvailable("darkCloud") ? {
      darkCloud: nativeFraction(scoringInfo.readDoubleLE(LMU_SCORING_INFO.darkCloud)),
    } : {}),
    ...(extensionAvailable("minimumPathWetness") ? {
      minimumPathWetness: nativeFraction(scoringInfo.readDoubleLE(LMU_SCORING_INFO.minimumPathWetness)),
    } : {}),
    ...(extensionAvailable("maximumPathWetness") ? {
      maximumPathWetness: nativeFraction(scoringInfo.readDoubleLE(LMU_SCORING_INFO.maximumPathWetness)),
    } : {}),
    ...(extensionAvailable("averagePathWetness") ? {
      averagePathWetness: nativeFraction(scoringInfo.readDoubleLE(LMU_SCORING_INFO.averagePathWetness)),
    } : {}),
    ...(extensionAvailable("wind") ? {
      wind: [scoringInfo.readDoubleLE(LMU_SCORING_INFO.wind), scoringInfo.readDoubleLE(LMU_SCORING_INFO.wind + 8), scoringInfo.readDoubleLE(LMU_SCORING_INFO.wind + 16)],
    } : {}),
    ...(extensionAvailable("ignitionStarter") ? {
      ignitionStarter: telemetry.readUInt8(LMU_TELEMETRY.ignitionStarter),
    } : {}),
    ...(extensionAvailable("scheduledStops") ? {
      scheduledStops: telemetry.readUInt8(LMU_TELEMETRY.scheduledStops),
    } : {}),
    ...(extensionAvailable("overheating") ? {
      overheating: telemetry.readUInt8(LMU_TELEMETRY.overheating) !== 0,
    } : {}),
    ...(extensionAvailable("penaltyCount") && scoring ? {
      penaltyCount: scoring.readInt16LE(LMU_SCORING_VEHICLE.penaltyCount),
    } : {}),
    ...(extensionAvailable("pitStopCount") && scoring ? {
      pitStopCount: scoring.readInt16LE(LMU_SCORING_VEHICLE.pitStopCount),
    } : {}),
    ...(extensionAvailable("primaryFlag") && scoring ? {
      primaryFlag: scoring.readUInt8(LMU_SCORING_VEHICLE.primaryFlag),
    } : {}),
    ...(extensionAvailable("underYellow") && scoring ? {
      underYellow: scoring.readUInt8(LMU_SCORING_VEHICLE.underYellow) !== 0,
    } : {}),
    ...(extensionAvailable("countLapFlag") && scoring ? {
      countLapFlag: scoring.readUInt8(LMU_SCORING_VEHICLE.countLapFlag),
    } : {}),
    ...(extensionAvailable("inGarageStall") && scoring ? {
      inGarageStall: scoring.readUInt8(LMU_SCORING_VEHICLE.inGarageStall) !== 0,
    } : {}),
    ...(extensionAvailable("finishStatus") && scoring ? {
      finishStatus: scoring.readUInt8(LMU_SCORING_VEHICLE.finishStatus),
    } : {}),
    ...(extensionAvailable("control") && scoring ? {
      control: scoring.readInt8(LMU_SCORING_VEHICLE.control),
    } : {}),
    ...(extensionAvailable("yellowFlagState") ? {
      yellowFlagState: scoringInfo.readInt8(LMU_SCORING_INFO.yellowFlagState),
    } : {}),
    ...(extensionAvailable("sectorFlags") ? {
      sectorFlags: [scoringInfo.readUInt8(LMU_SCORING_INFO.sectorFlags), scoringInfo.readUInt8(LMU_SCORING_INFO.sectorFlags + 1), scoringInfo.readUInt8(LMU_SCORING_INFO.sectorFlags + 2)],
    } : {}),
    ...(extensionAvailable("gamePhase") ? {
      gamePhase: scoringInfo.readUInt8(LMU_SCORING_INFO.gamePhase),
    } : {}),
  };

  return {
    gameId: "lmu",
    lmu,
    ...(frame.lmuContext ? { lmuContext: frame.lmuContext } : {}),
    sessionUID: JSON.stringify([
      frame.gameVersion,
      frame.sessionEvent,
      scoringInfo.readInt32LE(LMU_SCORING_INFO.session),
      identity.carId,
      identity.trackId,
      ...(frame.lmuContext ? [frame.lmuContext.key.sessionKey] : []),
    ]),
    IsRaceOn:
      scoring !== null && scoringInfo.readUInt8(LMU_SCORING_INFO.inRealtime) !== 0 ? 1 : 0,
    TimestampMS: Math.round(frame.captureTimestampMs),
    EngineMaxRpm: channelAvailable("Engine Max RPM")
      ? Math.max(0, finiteDouble(telemetry, LMU_TELEMETRY.engineMaxRpm))
      : NaN,
    EngineIdleRpm: 0,
    CurrentEngineRpm: extensionAvailable("engineRpm") ? engineRpm : NaN,
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
    TireCarcassAverageTempFL: wheels.FL.carcassTemperatureC,
    TireCarcassAverageTempFR: wheels.FR.carcassTemperatureC,
    TireCarcassAverageTempRL: wheels.RL.carcassTemperatureC,
    TireCarcassAverageTempRR: wheels.RR.carcassTemperatureC,
    TireSurfaceTempInnerFL: wheels.FL.temperatureRightC,
    TireSurfaceTempInnerFR: wheels.FR.temperatureLeftC,
    TireSurfaceTempInnerRL: wheels.RL.temperatureRightC,
    TireSurfaceTempInnerRR: wheels.RR.temperatureLeftC,
    TireSurfaceTempMiddleFL: wheels.FL.temperatureMiddleC,
    TireSurfaceTempMiddleFR: wheels.FR.temperatureMiddleC,
    TireSurfaceTempMiddleRL: wheels.RL.temperatureMiddleC,
    TireSurfaceTempMiddleRR: wheels.RR.temperatureMiddleC,
    TireSurfaceTempOuterFL: wheels.FL.temperatureLeftC,
    TireSurfaceTempOuterFR: wheels.FR.temperatureRightC,
    TireSurfaceTempOuterRL: wheels.RL.temperatureLeftC,
    TireSurfaceTempOuterRR: wheels.RR.temperatureRightC,
    Boost: 0,
    Fuel: channelAvailable("Fuel Level")
      ? Math.max(0, finiteDouble(telemetry, LMU_TELEMETRY.fuel))
      : NaN,
    FuelCapacity: frame.schemaVersion === 4
      ? NaN
      : Math.max(0, finiteDouble(telemetry, LMU_TELEMETRY.fuelCapacity)),
    DistanceTraveled: extensionAvailable("lapDistanceM")
      ? completedLaps * trackLengthM + Math.max(0, lapDistanceM)
      : NaN,
    BestLap: channelAvailable("Best LapTime") && scoring
      ? positiveTime(finiteDouble(scoring, LMU_SCORING_VEHICLE.bestLapTime))
      : NaN,
    LastLap: channelAvailable("Lap Time") && scoring
      ? positiveTime(finiteDouble(scoring, LMU_SCORING_VEHICLE.lastLapTime))
      : NaN,
    CurrentLap: Math.max(0, elapsedTime - lapStartElapsedTime),
    CurrentRaceTime: elapsedTime,
    // LMU telemetry reports zero-based current-lap numbers. RaceIQ lap
    // identity is one-based, matching the displayed lap and persisted laps.
    LapNumber: channelAvailable("Lap")
      ? Math.max(1, telemetry.readInt32LE(LMU_TELEMETRY.lapNumber) + 1)
      : NaN,
    RacePosition: scoring && frame.schemaVersion !== 4
      ? scoring.readUInt8(LMU_SCORING_VEHICLE.place)
      : NaN,
    Accel: extensionAvailable("throttle")
      ? input255(finiteDouble(telemetry, LMU_TELEMETRY.throttle))
      : NaN,
    Brake: extensionAvailable("brake")
      ? input255(finiteDouble(telemetry, LMU_TELEMETRY.brake))
      : NaN,
    Clutch: extensionAvailable("clutch")
      ? input255(finiteDouble(telemetry, LMU_TELEMETRY.clutch))
      : NaN,
    HandBrake: 0,
    Gear: channelAvailable("Gear")
      ? canonicalGear(telemetry.readInt32LE(LMU_TELEMETRY.gear))
      : NaN,
    Steer: extensionAvailable("steering")
      ? Math.round(clamp(finiteDouble(telemetry, LMU_TELEMETRY.steering), -1, 1) * 127)
      : NaN,
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
    carId: identity.carId,
    CarClass: vehicleClass,
    CarPerformanceIndex: 0,
    DrivetrainType: 1,
    NumCylinders: 0,
    Power: extensionAvailable("engineTorque")
      ? engineTorque * engineRpm * TWO_PI_PER_MINUTE
      : NaN,
    Torque: extensionAvailable("engineTorque") ? engineTorque : NaN,
    PositionX: position.x,
    PositionY: position.y,
    PositionZ: position.z,
    Speed: Math.hypot(
      localVelocity.x,
      localVelocity.y,
      localVelocity.z,
    ),
    trackId: identity.trackId,
    BrakeTempFrontLeft: channelAvailable("Brakes Temp") ? wheels.FL.brakeTemperatureC : NaN,
    BrakeTempFrontRight: channelAvailable("Brakes Temp") ? wheels.FR.brakeTemperatureC : NaN,
    BrakeTempRearLeft: channelAvailable("Brakes Temp") ? wheels.RL.brakeTemperatureC : NaN,
    BrakeTempRearRight: channelAvailable("Brakes Temp") ? wheels.RR.brakeTemperatureC : NaN,
    TirePressureFrontLeft: channelAvailable("TyresPressure") ? wheels.FL.pressurePsi : NaN,
    TirePressureFrontRight: channelAvailable("TyresPressure") ? wheels.FR.pressurePsi : NaN,
    TirePressureRearLeft: channelAvailable("TyresPressure") ? wheels.RL.pressurePsi : NaN,
    TirePressureRearRight: channelAvailable("TyresPressure") ? wheels.RR.pressurePsi : NaN,
    DrsActive: channelAvailable("RearFlapActivated")
      ? telemetry.readUInt8(LMU_TELEMETRY.rearFlapActivated) !== 0 ? 1 : 0
      : NaN,
    TrackTemp: channelAvailable("Track Temperature")
      ? finiteDouble(scoringInfo, LMU_SCORING_INFO.trackTemperature)
      : NaN,
    AirTemp: channelAvailable("Ambient Temperature")
      ? finiteDouble(scoringInfo, LMU_SCORING_INFO.ambientTemperature)
      : NaN,
    RainPercent: frame.schemaVersion === 4 ? NaN : Math.round(raining * 100),
    WeatherType: frame.schemaVersion === 4 ? NaN : weatherType(raining, cloudCoverage),
  };
}
