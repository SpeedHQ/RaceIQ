import { rememberIRacingIdentity } from "../../../shared/games/iracing";
import type { TelemetryPacket } from "../../../shared/types";
import type { IRacingSourceFrameV1, IRacingValue } from "./source-frame";

const KPA_TO_PSI = 0.1450377377;

export interface IRacingParserState {
  sessionKey: string | null;
  rawLap: number | null;
  lapStartSessionTime: number;
}

export function createIRacingParserState(): IRacingParserState {
  return {
    sessionKey: null,
    rawLap: null,
    lapStartSessionTime: 0,
  };
}

function scalar(
  values: Record<string, IRacingValue>,
  name: string,
  fallback = 0,
): number {
  const value = values[name];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return fallback;
}

function bool(values: Record<string, IRacingValue>, name: string): boolean {
  const value = values[name];
  return value === true || (typeof value === "number" && value !== 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function input255(value: number): number {
  return Math.round(clamp(value, 0, 1) * 255);
}

function tireTemperature(
  values: Record<string, IRacingValue>,
  corner: "LF" | "RF" | "LR" | "RR",
): number {
  const samples = [
    scalar(values, `${corner}tempCL`, Number.NaN),
    scalar(values, `${corner}tempCM`, Number.NaN),
    scalar(values, `${corner}tempCR`, Number.NaN),
  ].filter(Number.isFinite);
  return samples.length > 0
    ? samples.reduce((sum, value) => sum + value, 0) / samples.length
    : 0;
}

/**
 * iRacing exposes tread remaining (1 = fresh, 0 = gone) at three bands.
 * RaceIQ's canonical TireWear fields use the inverse (0 = fresh, 1 = gone).
 */
function tireWear(
  values: Record<string, IRacingValue>,
  corner: "LF" | "RF" | "LR" | "RR",
): number {
  const remaining = [
    scalar(values, `${corner}wearL`, Number.NaN),
    scalar(values, `${corner}wearM`, Number.NaN),
    scalar(values, `${corner}wearR`, Number.NaN),
  ].filter(Number.isFinite);
  if (remaining.length === 0) return 0;
  return 1 - clamp(Math.min(...remaining), 0, 1);
}

function coldPressurePsi(
  values: Record<string, IRacingValue>,
  corner: "LF" | "RF" | "LR" | "RR",
): number | undefined {
  const kpa = scalar(values, `${corner}coldPressure`, Number.NaN);
  return Number.isFinite(kpa) && kpa > 0 ? kpa * KPA_TO_PSI : undefined;
}

function normalizeSectorStarts(
  nativeStarts: readonly number[] | undefined,
): number[] {
  const starts = nativeStarts
    ?.filter((value) => Number.isFinite(value) && value >= 0 && value < 1)
    .sort((a, b) => a - b);
  if (
    starts &&
    (starts.length === 2 || starts.length === 3) &&
    starts[0] === 0
  ) {
    return starts;
  }
  return [];
}

export function normalizeIRacingFrame(
  frame: IRacingSourceFrameV1,
  state?: IRacingParserState | null,
): TelemetryPacket {
  const { session, values } = frame;
  rememberIRacingIdentity({
    carId: session.carId,
    carName: session.carName,
    trackId: session.trackId,
    trackName: session.trackName,
  });

  const rawLap = Math.max(0, Math.trunc(scalar(values, "Lap", 0)));
  const lapDistanceM = Math.max(0, scalar(values, "LapDist", 0));
  const lapDistancePct = clamp(scalar(values, "LapDistPct", 0), 0, 1);
  const sessionTime = Math.max(0, scalar(values, "SessionTime", 0));
  const sdkCurrentLapTime = Math.max(
    0,
    scalar(values, "LapCurrentLapTime", 0),
  );
  const sdkLastLapTime = Math.max(0, scalar(values, "LapLastLapTime", 0));
  const sessionKey = `${session.subSessionId}:${session.sessionId}:${session.sessionNum}`;
  let currentLapTime = sdkCurrentLapTime;
  if (state) {
    if (state.sessionKey !== sessionKey || state.rawLap === null) {
      state.sessionKey = sessionKey;
      state.rawLap = rawLap;
      state.lapStartSessionTime = sessionTime - sdkCurrentLapTime;
    } else if (state.rawLap !== rawLap) {
      // iRacing's Lap changes at the physical start/finish line, while
      // LapCurrentLapTime rolls over roughly two seconds later. SessionTime is
      // monotonic, so anchor elapsed time at the immediate Lap transition.
      state.rawLap = rawLap;
      state.lapStartSessionTime = sessionTime;
    }
    currentLapTime = Math.max(0, sessionTime - state.lapStartSessionTime);
  }
  const sectorStarts = normalizeSectorStarts(session.sectorStarts);
  const steeringAngle = scalar(values, "SteeringWheelAngle", 0);
  const steeringMax = Math.abs(scalar(values, "SteeringWheelAngleMax", 0));
  const steer = steeringMax > 0
    ? Math.round(clamp(steeringAngle / steeringMax, -1, 1) * 127)
    : 0;
  const trackLengthM = Math.max(0, session.trackLengthM);
  const distanceTraveled =
    trackLengthM > 0 ? rawLap * trackLengthM + lapDistanceM : lapDistanceM;
  const onTrack = bool(values, "IsOnTrack");
  const wetness = clamp(scalar(values, "TrackWetness", 0), 0, 7);

  return {
    gameId: "iracing",
    iracing: {
      sessionTick: Math.trunc(scalar(values, "SessionTick", 0)),
      sessionNum: session.sessionNum,
      driverCarIdx: session.driverCarIdx,
      trackLengthM,
      lapDistanceM,
      lapDistancePct,
      sdkCurrentLapTime,
      sectorStarts,
      onPitRoad: bool(values, "OnPitRoad"),
      playerTrackSurface: Math.trunc(scalar(values, "PlayerTrackSurface", 0)),
      incidents: Math.trunc(scalar(values, "PlayerIncidents", 0)),
      carName: session.carName,
      carClassName: session.carClassName,
      trackName: session.trackName,
    },
    sessionUID: sessionKey,

    IsRaceOn: onTrack ? 1 : 0,
    TimestampMS: Math.round(sessionTime * 1000),

    EngineMaxRpm: session.engineRedlineRpm,
    EngineIdleRpm: session.engineIdleRpm,
    CurrentEngineRpm: scalar(values, "RPM", 0),

    // The iRacing SDK publishes these accelerations in m/s², matching the
    // canonical values consumed by RaceIQ's G-force views.
    AccelerationX: scalar(values, "LatAccel", 0),
    AccelerationY: scalar(values, "VertAccel", 0),
    AccelerationZ: scalar(values, "LongAccel", 0),

    VelocityX: scalar(values, "VelocityX", 0),
    VelocityY: scalar(values, "VelocityY", 0),
    VelocityZ: scalar(values, "VelocityZ", 0),
    AngularVelocityX: scalar(values, "PitchRate", 0),
    AngularVelocityY: scalar(values, "YawRate", 0),
    AngularVelocityZ: scalar(values, "RollRate", 0),

    Yaw: scalar(values, "Yaw", 0),
    Pitch: scalar(values, "Pitch", 0),
    Roll: scalar(values, "Roll", 0),

    NormSuspensionTravelFL: 0,
    NormSuspensionTravelFR: 0,
    NormSuspensionTravelRL: 0,
    NormSuspensionTravelRR: 0,

    TireSlipRatioFL: 0,
    TireSlipRatioFR: 0,
    TireSlipRatioRL: 0,
    TireSlipRatioRR: 0,
    WheelRotationSpeedFL: 0,
    WheelRotationSpeedFR: 0,
    WheelRotationSpeedRL: 0,
    WheelRotationSpeedRR: 0,
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

    TireTempFL: tireTemperature(values, "LF"),
    TireTempFR: tireTemperature(values, "RF"),
    TireTempRL: tireTemperature(values, "LR"),
    TireTempRR: tireTemperature(values, "RR"),

    Boost: 0,
    Fuel: Math.max(0, scalar(values, "FuelLevel", 0)),
    DistanceTraveled: distanceTraveled,
    BestLap: Math.max(0, scalar(values, "LapBestLapTime", 0)),
    LastLap: sdkLastLapTime,
    CurrentLap: currentLapTime,
    CurrentRaceTime: sessionTime,

    // Preserve iRacing's displayed current-lap number. LapCompleted trails it
    // by one while the lap is in progress; adding one here mislabels results.
    LapNumber: rawLap,
    RacePosition: Math.max(0, Math.trunc(scalar(values, "PlayerCarPosition", 0))),

    Accel: input255(scalar(values, "Throttle", 0)),
    Brake: input255(scalar(values, "Brake", 0)),
    Clutch: input255(scalar(values, "Clutch", 0)),
    HandBrake: 0,
    Gear: Math.max(0, Math.trunc(scalar(values, "Gear", 0))),
    Steer: steer,
    NormDrivingLine: 0,
    NormAIBrakeDiff: 0,

    TireWearFL: tireWear(values, "LF"),
    TireWearFR: tireWear(values, "RF"),
    TireWearRL: tireWear(values, "LR"),
    TireWearRR: tireWear(values, "RR"),

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

    SuspensionTravelMFL: scalar(values, "LFshockDefl", 0),
    SuspensionTravelMFR: scalar(values, "RFshockDefl", 0),
    SuspensionTravelMRL: scalar(values, "LRshockDefl", 0),
    SuspensionTravelMRR: scalar(values, "RRshockDefl", 0),

    CarOrdinal: Math.max(0, Math.trunc(session.carId)),
    CarClass: Math.max(0, Math.trunc(session.carClassId)),
    CarPerformanceIndex: 0,
    DrivetrainType: 1,
    NumCylinders: Math.max(0, Math.trunc(session.engineCylinderCount)),

    // The public SDK row does not provide stable world coordinates. LapDist
    // and LapDistPct above are the authoritative track-position signals.
    PositionX: 0,
    PositionY: 0,
    PositionZ: 0,
    Speed: Math.max(0, scalar(values, "Speed", 0)),
    Power: 0,
    Torque: 0,
    TrackOrdinal: Math.max(0, Math.trunc(session.trackId)),

    TirePressureFrontLeft: coldPressurePsi(values, "LF"),
    TirePressureFrontRight: coldPressurePsi(values, "RF"),
    TirePressureRearLeft: coldPressurePsi(values, "LR"),
    TirePressureRearRight: coldPressurePsi(values, "RR"),
    TrackTemp: scalar(values, "TrackTemp", 0),
    AirTemp: scalar(values, "AirTemp", 0),
    RainPercent: Math.round((wetness / 7) * 100),
  };
}
