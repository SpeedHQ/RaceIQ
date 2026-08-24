import type { TelemetryPacket } from "../../../shared/telemetry/types";
import {
  createIRacingSourceDecoderState,
  type IRacingSourceDecoderState,
  type IRacingSourceFrame,
  type IRacingValue,
} from "./source-frame";
import { parseIRacingDrivers, type IRacingDriverSnapshot, parseIRacingFuelCapacity } from "./session-info";
import type { IRacingCompetitor } from "../../../shared/telemetry/iracing";
import {
  startsAtIRacingSectorOrigin,
  warnInvalidIRacingSectorLayout,
} from "./sector-layout";

const KPA_TO_PSI = 0.1450377377;
export interface IRacingParserState {
  source: IRacingSourceDecoderState;
  sessionKey: string | null;
  rawLap: number | null;
  lapStartSessionTime: number;
  fuelCapacitySessionInfo: string | null;
  fuelCapacityL: number | undefined;
  sessionInfo: string | null;
  drivers: readonly IRacingDriverSnapshot[];
}

export function createIRacingParserState(): IRacingParserState {
  return {
    source: createIRacingSourceDecoderState(),
    sessionKey: null,
    rawLap: null,
    lapStartSessionTime: 0,
    fuelCapacitySessionInfo: null,
    fuelCapacityL: undefined,
    sessionInfo: null,
    drivers: [],
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
function numberArray(values: Record<string, IRacingValue>, name: string): number[] | undefined {
  const value = values[name];
  if (!Array.isArray(value)) return undefined;
  const output = value.map((entry) => typeof entry === "number" && Number.isFinite(entry) ? entry : Number.NaN);
  return output.some(Number.isNaN) ? undefined : output;
}
function booleanArray(values: Record<string, IRacingValue>, name: string): boolean[] | undefined {
  const value = values[name];
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => entry === true || (typeof entry === "number" && entry !== 0));
}

function bool(values: Record<string, IRacingValue>, name: string): boolean {
  const value = values[name];
  return value === true || (typeof value === "number" && value !== 0);
}
function buildCompetitors(
  values: Record<string, IRacingValue>,
  drivers: readonly IRacingDriverSnapshot[],
): readonly IRacingCompetitor[] {
  const positions = numberArray(values, "CarIdxPosition");
  const classPositions = numberArray(values, "CarIdxClassPosition");
  const laps = numberArray(values, "CarIdxLapCompleted");
  const pits = booleanArray(values, "CarIdxOnPitRoad");
  const lastLaps = numberArray(values, "CarIdxLastLapTime");
  const bestLaps = numberArray(values, "CarIdxBestLapTime");
  const locations = numberArray(values, "CarIdxTrackSurface");
  if (!positions || !classPositions || !laps || !pits || !lastLaps || !bestLaps || !locations) return [];
  const rows: IRacingCompetitor[] = [];
  for (const driver of drivers) {
    const i = driver.carIndex;
    const row = { position: positions[i], classPosition: classPositions[i], lapsComplete: laps[i], onPitRoad: pits[i], lastLapTime: lastLaps[i], bestLapTime: bestLaps[i], trackLocation: locations[i] };
    if (![row.position, row.classPosition, row.lapsComplete, row.lastLapTime, row.bestLapTime, row.trackLocation].every((value) => typeof value === "number" && Number.isFinite(value)) || row.onPitRoad === undefined) continue;
    rows.push({ ...driver, ...row });
  }
  return rows.sort((a, b) => a.carIndex - b.carIndex);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function input255(value: number): number {
  return Math.round(clamp(value, 0, 1) * 255);
}

/**
 * The shared dashboard retains Forza's canonical gear encoding (0 = reverse,
 * 11 = neutral). Translate iRacing's native -1/0 values at the source boundary.
 */
function canonicalGear(value: number): number {
  const nativeGear = Math.trunc(value);
  if (nativeGear < 0) return 0;
  if (nativeGear === 0) return 11;
  return nativeGear;
}

interface TireCarcassTemperature {
  left?: number;
  middle?: number;
  right?: number;
  average?: number;
}

function tireCarcassTemperature(
  values: Record<string, IRacingValue>,
  corner: "LF" | "RF" | "LR" | "RR",
): TireCarcassTemperature {
  const raw = {
    left: scalar(values, `${corner}tempCL`, Number.NaN),
    middle: scalar(values, `${corner}tempCM`, Number.NaN),
    right: scalar(values, `${corner}tempCR`, Number.NaN),
  };
  const result: TireCarcassTemperature = {};
  const samples: number[] = [];
  for (const [band, value] of Object.entries(raw)) {
    if (!Number.isFinite(value)) continue;
    result[band as keyof typeof raw] = value;
    samples.push(value);
  }
  if (samples.length > 0) {
    result.average =
      samples.reduce((sum, value) => sum + value, 0) / samples.length;
  }
  return result;
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
  if (!nativeStarts) return [];
  const starts = [...nativeStarts].sort((a, b) => a - b);
  if (
    starts.length >= 2 &&
    startsAtIRacingSectorOrigin(starts[0]) &&
    starts.every(
      (value, index) =>
        Number.isFinite(value) &&
        value >= 0 &&
        value < 1 &&
        (index === 0 || value > starts[index - 1]),
    )
  ) {
    return starts;
  }
  if (starts.length > 0) warnInvalidIRacingSectorLayout(starts);
  return [];
}

export function normalizeIRacingFrame(
  frame: IRacingSourceFrame,
  state?: IRacingParserState | null,
): TelemetryPacket {
  const { session, values } = frame;

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
  let fuelCapacityL: number | undefined;
  if ("sessionInfo" in frame) {
    if (!state) {
      fuelCapacityL = parseIRacingFuelCapacity(frame.sessionInfo);
    } else {
      if (state.fuelCapacitySessionInfo !== frame.sessionInfo) {
        state.fuelCapacitySessionInfo = frame.sessionInfo;
        state.fuelCapacityL = parseIRacingFuelCapacity(frame.sessionInfo);
      }
      fuelCapacityL = state.fuelCapacityL;
    }
  }
  let drivers: readonly IRacingDriverSnapshot[] = state?.drivers ?? [];
  if ("sessionInfo" in frame && state) {
    if (state.sessionInfo !== frame.sessionInfo) {
      state.sessionInfo = frame.sessionInfo;
      state.drivers = parseIRacingDrivers(frame.sessionInfo);
    }
    drivers = state.drivers;
  } else if ("sessionInfo" in frame) {
    drivers = parseIRacingDrivers(frame.sessionInfo);
  }
  const competitors = buildCompetitors(values, drivers);
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
  // Canonical Steer is negative-left/positive-right. Captured iRacing
  // controller angles use the opposite sign.
  const steer = steeringMax > 0
    ? Math.round(clamp(-steeringAngle / steeringMax, -1, 1) * 127)
    : 0;
  const trackLengthM = Math.max(0, session.trackLengthM);
  const distanceTraveled =
    trackLengthM > 0 ? rawLap * trackLengthM + lapDistanceM : lapDistanceM;
  const onTrack = bool(values, "IsOnTrack");
  const wetness = clamp(scalar(values, "TrackWetness", 0), 0, 7);
  const tireTemps = {
    LF: tireCarcassTemperature(values, "LF"),
    RF: tireCarcassTemperature(values, "RF"),
    LR: tireCarcassTemperature(values, "LR"),
    RR: tireCarcassTemperature(values, "RR"),
  };
  const pitTireTemperatureAvailable = Object.values(tireTemps).every(
    (temperature) => temperature.average !== undefined,
  );
  const pitTireWearAvailable = (["LF", "RF", "LR", "RR"] as const).every(
    (corner) =>
      ["wearL", "wearM", "wearR"].every((band) =>
        Number.isFinite(scalar(values, `${corner}${band}`, Number.NaN)),
      ),
  );

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
      sessionFlags: Math.trunc(scalar(values, "SessionFlags", 0)),
      sessionState: Math.trunc(scalar(values, "SessionState", 0)),
      sessionTimeRemain: scalar(values, "SessionTimeRemain", 0),
      carIdxPosition: numberArray(values, "CarIdxPosition"),
      carIdxClassPosition: numberArray(values, "CarIdxClassPosition"),
      carIdxLapCompleted: numberArray(values, "CarIdxLapCompleted"),
      carIdxOnPitRoad: booleanArray(values, "CarIdxOnPitRoad"),
      sectorStarts,
      onPitRoad: bool(values, "OnPitRoad"),
      playerTrackSurface: Math.trunc(scalar(values, "PlayerTrackSurface", 0)),
      carLeftRight: Math.trunc(scalar(values, "CarLeftRight", 0)),
      carIdxLap: numberArray(values, "CarIdxLap"),
      carIdxLastLapTime: numberArray(values, "CarIdxLastLapTime"),
      carIdxBestLapTime: numberArray(values, "CarIdxBestLapTime"),
      carIdxTrackSurface: numberArray(values, "CarIdxTrackSurface"),
      competitors,
      incidents: Math.trunc(scalar(values, "PlayerIncidents", 0)),
      trackWetness: Math.trunc(wetness),
      pitTireTemperatureAvailable,
      pitTireWearAvailable,
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
    // iRacing yaw increases through left turns. RaceIQ's canonical heading
    // increases through right turns, matching its mirrored canvas coordinates.
    AngularVelocityY: -scalar(values, "YawRate", 0),
    AngularVelocityZ: scalar(values, "RollRate", 0),

    Yaw: -scalar(values, "Yaw", 0),
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

    TireTempFL: tireTemps.LF.average ?? 0,
    TireTempFR: tireTemps.RF.average ?? 0,
    TireTempRL: tireTemps.LR.average ?? 0,
    TireTempRR: tireTemps.RR.average ?? 0,
    TireCarcassTempFL: tireTemps.LF.average,
    TireCarcassTempFR: tireTemps.RF.average,
    TireCarcassTempRL: tireTemps.LR.average,
    TireCarcassTempRR: tireTemps.RR.average,
    TireCarcassTempLeftFL: tireTemps.LF.left,
    TireCarcassTempLeftFR: tireTemps.RF.left,
    TireCarcassTempLeftRL: tireTemps.LR.left,
    TireCarcassTempLeftRR: tireTemps.RR.left,
    TireCarcassTempMiddleFL: tireTemps.LF.middle,
    TireCarcassTempMiddleFR: tireTemps.RF.middle,
    TireCarcassTempMiddleRL: tireTemps.LR.middle,
    TireCarcassTempMiddleRR: tireTemps.RR.middle,
    TireCarcassTempRightFL: tireTemps.LF.right,
    TireCarcassTempRightFR: tireTemps.RF.right,
    TireCarcassTempRightRL: tireTemps.LR.right,
    TireCarcassTempRightRR: tireTemps.RR.right,

    Boost: 0,
    Fuel: Math.max(0, scalar(values, "FuelLevel", 0)),
    ...(fuelCapacityL !== undefined ? { FuelCapacity: fuelCapacityL } : {}),
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
    Gear: canonicalGear(scalar(values, "Gear", 0)),
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
    // RaceIQ's canonical field is a numeric percentage. TrackWetness is a
    // categorical surface-state enum, so use iRacing's real precipitation
    // channel instead of pretending the category is a linear percentage.
    RainPercent: Math.round(clamp(scalar(values, "Precipitation", 0), 0, 1) * 100),
  };
}
