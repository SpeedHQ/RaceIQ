import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { registerAMS2Identity } from "@raceiq/game-ams2-metadata/index";
import { AMS2_LAYOUT as L, PARTICIPANT_OFFSET, PARTICIPANT_SIZE } from "./layout";
import { decodeAMS2Frame } from "./frame";
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const input255 = (v: number) => Math.round(clamp(v, 0, 1) * 255);
const canonicalGear = (v: number) => v < 0 ? 0 : v === 0 ? 11 : v;
function identityOrdinal(name: string): number {
  let hash = 2166136261;
  for (const byte of Buffer.from(name, "utf8")) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0) & 0x7fffffff || 1;
}
export function normalizeAMS2Frame(raw: Buffer): TelemetryPacket | null {
  const frame = decodeAMS2Frame(raw); if (!frame) return null;
  const memory = frame.memory;
  const version = memory.readUInt32LE(L.mVersion);
  const viewed = memory.readInt32LE(L.mViewedParticipantIndex);
  const count = memory.readInt32LE(L.mNumParticipants);
  if (version < 8 || version > 14 || count < 1 || count > 64 || viewed < 0 || viewed >= count) return null;
  const p = PARTICIPANT_OFFSET + viewed * PARTICIPANT_SIZE;
  const f = (offset: number): number => { const v = memory.readFloatLE(offset); return Number.isFinite(v) ? v : 0; };
  const str = (offset: number): string => memory.subarray(offset, offset + 64).toString("utf8").split("\0")[0].trim();
  const carName = str(L.mCarName); const trackName = [str(L.mTrackLocation), str(L.mTrackVariation)].filter(Boolean).join(" - ");
  if (!carName || !trackName || f(L.mTrackLength) <= 0) return null;
  const carOrdinal = identityOrdinal(carName); const trackOrdinal = identityOrdinal(trackName);
  registerAMS2Identity(carOrdinal, carName, trackOrdinal, trackName, f(L.mTrackLength));
  const gameState = memory.readUInt32LE(L.mGameState);
  const active = (gameState === 2 || gameState === 4) && memory[p] !== 0;
  return {
    gameId: "ams2",
    sessionUID: JSON.stringify([frame.epoch, memory.readUInt32LE(L.mSessionState), carName, trackName]),
    ams2: {carName, trackName, trackLengthM: f(L.mTrackLength), lapDistanceM: f(p + 80),
      sessionType: ["invalid","practice","test","qualifying","formation","race","time-attack"][memory.readUInt32LE(L.mSessionState)] ?? "unknown",
      lapInvalidated: memory[L.mLapInvalidated] !== 0, inPits: memory.readUInt32LE(L.mPitMode) !== 0},
    FuelCapacity: f(L.mFuelCapacity),
    AirTemp: f(L.mAmbientTemperature),
    TrackTemp: f(L.mTrackTemperature),
    RainPercent: f(L.mRainDensity),
    BrakeTempFrontLeft: f(L.mBrakeTempCelsius + 0),
    TirePressureFrontLeft: f(L.mAirPressure + 0) / 6.894757,
    BrakeTempFrontRight: f(L.mBrakeTempCelsius + 4),
    TirePressureFrontRight: f(L.mAirPressure + 4) / 6.894757,
    BrakeTempRearLeft: f(L.mBrakeTempCelsius + 8),
    TirePressureRearLeft: f(L.mAirPressure + 8) / 6.894757,
    BrakeTempRearRight: f(L.mBrakeTempCelsius + 12),
    TirePressureRearRight: f(L.mAirPressure + 12) / 6.894757,
    IsRaceOn: active ? 1 : 0,
    TimestampMS: frame.timestampMs,
    EngineMaxRpm: f(L.mMaxRPM),
    EngineIdleRpm: 0,
    CurrentEngineRpm: f(L.mRpm),
    AccelerationX: f(L.mLocalAcceleration + 0),
    AccelerationY: f(L.mLocalAcceleration + 4),
    AccelerationZ: -f(L.mLocalAcceleration + 8),
    VelocityX: f(L.mLocalVelocity + 0),
    VelocityY: f(L.mLocalVelocity + 4),
    VelocityZ: -f(L.mLocalVelocity + 8),
    AngularVelocityX: f(L.mAngularVelocity + 0),
    AngularVelocityY: f(L.mAngularVelocity + 4),
    AngularVelocityZ: f(L.mAngularVelocity + 8),
    Yaw: Math.atan2(-Math.sin(f(L.mOrientation + 4)), -Math.cos(f(L.mOrientation + 4))),
    Pitch: f(L.mOrientation + 0),
    Roll: f(L.mOrientation + 8),
    NormSuspensionTravelFL: 0,
    NormSuspensionTravelFR: 0,
    NormSuspensionTravelRL: 0,
    NormSuspensionTravelRR: 0,
    TireSlipRatioFL: 0,
    TireSlipRatioFR: 0,
    TireSlipRatioRL: 0,
    TireSlipRatioRR: 0,
    WheelRotationSpeedFL: f(L.mTyreRPS + 0) * Math.PI * 2,
    WheelRotationSpeedFR: f(L.mTyreRPS + 4) * Math.PI * 2,
    WheelRotationSpeedRL: f(L.mTyreRPS + 8) * Math.PI * 2,
    WheelRotationSpeedRR: f(L.mTyreRPS + 12) * Math.PI * 2,
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
    TireTempFL: f(L.mTyreTemp + 0),
    TireTempFR: f(L.mTyreTemp + 4),
    TireTempRL: f(L.mTyreTemp + 8),
    TireTempRR: f(L.mTyreTemp + 12),
    Boost: 0,
    Fuel: f(L.mFuelLevel) * f(L.mFuelCapacity),
    DistanceTraveled: memory.readUInt32LE(p + 88) * f(L.mTrackLength) + f(p + 80),
    BestLap: f(L.mBestLapTime),
    LastLap: f(L.mLastLapTime),
    CurrentLap: f(L.mCurrentTime),
    CurrentRaceTime: 0,
    LapNumber: Math.max(1, memory.readUInt32LE(p + 92)),
    RacePosition: memory.readUInt32LE(p + 84),
    Accel: input255(f(L.mUnfilteredThrottle)),
    Brake: input255(f(L.mUnfilteredBrake)),
    Clutch: input255(f(L.mUnfilteredClutch)),
    HandBrake: 0,
    Gear: canonicalGear(memory.readInt32LE(L.mGear)),
    Steer: Math.round(clamp(f(L.mUnfilteredSteering), -1, 1) * 127),
    NormDrivingLine: 0,
    NormAIBrakeDiff: 0,
    TireWearFL: f(L.mTyreWear + 0),
    TireWearFR: f(L.mTyreWear + 4),
    TireWearRL: f(L.mTyreWear + 8),
    TireWearRR: f(L.mTyreWear + 12),
    SurfaceRumbleFL: 0,
    SurfaceRumbleFR: 0,
    SurfaceRumbleRL: 0,
    SurfaceRumbleRR: 0,
    TireSlipAngleFL: 0,
    TireSlipAngleFR: 0,
    TireSlipAngleRL: 0,
    TireSlipAngleRR: 0,
    TireCombinedSlipFL: 0,
    TireCombinedSlipFR: 0,
    TireCombinedSlipRL: 0,
    TireCombinedSlipRR: 0,
    SuspensionTravelMFL: f(L.mSuspensionTravel + 0),
    SuspensionTravelMFR: f(L.mSuspensionTravel + 4),
    SuspensionTravelMRL: f(L.mSuspensionTravel + 8),
    SuspensionTravelMRR: f(L.mSuspensionTravel + 12),
    CarOrdinal: carOrdinal,
    CarClass: 0,
    CarPerformanceIndex: 0,
    DrivetrainType: 0,
    NumCylinders: 0,
    PositionX: f(p + 68),
    PositionY: f(p + 72),
    PositionZ: f(p + 76),
    Speed: f(L.mSpeed),
    Power: 0,
    Torque: 0,
    TrackOrdinal: trackOrdinal,
  };
}
