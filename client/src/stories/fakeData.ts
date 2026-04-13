/**
 * Fake telemetry data for Storybook stories.
 * All values are plausible real-world racing data.
 */
import type { TelemetryPacket, LiveSectorData, LivePitData, LapMeta } from "@shared/types";
import type { DisplayPacket } from "../lib/convert-packet";

// ── Shared base packet fields ────────────────────────────────────────────────

const basePacket = {
  IsRaceOn: 1,
  TimestampMS: 123456789,
  EngineMaxRpm: 18000,
  EngineIdleRpm: 3000,
  CurrentEngineRpm: 14200,
  AccelerationX: 0.12,
  AccelerationY: 9.81,
  AccelerationZ: 0.05,
  VelocityX: 1.2,
  VelocityY: 0.0,
  VelocityZ: 65.5,
  AngularVelocityX: 0.01,
  AngularVelocityY: 0.03,
  AngularVelocityZ: -0.02,
  Yaw: 0.15,
  Pitch: -0.02,
  Roll: 0.01,
  NormSuspensionTravelFL: 0.42,
  NormSuspensionTravelFR: 0.44,
  NormSuspensionTravelRL: 0.48,
  NormSuspensionTravelRR: 0.46,
  TireSlipRatioFL: 0.02,
  TireSlipRatioFR: 0.02,
  TireSlipRatioRL: 0.04,
  TireSlipRatioRR: 0.04,
  WheelRotationSpeedFL: 180.5,
  WheelRotationSpeedFR: 181.2,
  WheelRotationSpeedRL: 183.4,
  WheelRotationSpeedRR: 182.8,
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
  Boost: 0.6,
  Fuel: 42.5, // litres remaining (F1/ACC treat as litres; Forza overrides below)
  DistanceTraveled: 3240,
  BestLap: 92.341,
  LastLap: 92.341,     // lap 4
  CurrentLap: 61.645,  // S1 29.845 + S2 31.8 elapsed so far
  CurrentRaceTime: 445.2,
  LapNumber: 5,
  RacePosition: 3,
  Accel: 220,
  Brake: 0,
  Clutch: 0,
  HandBrake: 0,
  Gear: 7,
  Steer: 4,
  NormDrivingLine: 0,
  NormAIBrakeDiff: 0,
  // TireWear is 0–1 fraction worn (0 = new, 1 = dead)
  TireWearFL: 0.18,
  TireWearFR: 0.19,
  TireWearRL: 0.22,
  TireWearRR: 0.21,
  SurfaceRumbleFL: 0,
  SurfaceRumbleFR: 0,
  SurfaceRumbleRL: 0,
  SurfaceRumbleRR: 0,
  TireSlipAngleFL: 0.5,
  TireSlipAngleFR: 0.5,
  TireSlipAngleRL: 0.8,
  TireSlipAngleRR: 0.8,
  TireCombinedSlipFL: 0.6,
  TireCombinedSlipFR: 0.6,
  TireCombinedSlipRL: 0.9,
  TireCombinedSlipRR: 0.9,
  SuspensionTravelMFL: 0.025,
  SuspensionTravelMFR: 0.026,
  SuspensionTravelMRL: 0.028,
  SuspensionTravelMRR: 0.027,
  CarOrdinal: 42,
  CarClass: 6,
  CarPerformanceIndex: 900,
  DrivetrainType: 1,
  NumCylinders: 4,
  PositionX: 120.5,
  PositionY: 0.0,
  PositionZ: 340.2,
  Speed: 72.3, // m/s ≈ 260 km/h
  Power: 550000,
  Torque: 380,
  TrackOrdinal: 7,
};

// ── F1 2025 Fake Packet ──────────────────────────────────────────────────────

export const fakeF1Packet: TelemetryPacket = {
  ...basePacket,
  gameId: "f1-2025",
  CurrentEngineRpm: 14200,
  EngineMaxRpm: 15000,
  EngineIdleRpm: 4000,
  TireTempFL: 96,
  TireTempFR: 98,
  TireTempRL: 101,
  TireTempRR: 99,
  DrsActive: 0,
  ErsStoreEnergy: 2800000,
  ErsDeployMode: 1,
  ErsDeployed: 800000,
  ErsHarvested: 400000,
  WeatherType: 0,
  TrackTemp: 42,
  AirTemp: 28,
  RainPercent: 15,
  TyreCompound: 16, // soft
  BrakeTempFrontLeft: 580,
  BrakeTempFrontRight: 575,
  BrakeTempRearLeft: 420,
  BrakeTempRearRight: 418,
  TirePressureFrontLeft: 23.1,
  TirePressureFrontRight: 23.0,
  TirePressureRearLeft: 21.5,
  TirePressureRearRight: 21.4,
  f1: {
    drsAllowed: true,
    drsActivated: false,
    drsZoneApproaching: true,
    ersStoreEnergy: 2800000,
    ersDeployMode: 1,
    ersDeployedThisLap: 800000,
    ersHarvestedThisLap: 400000,
    tyreCompound: "soft",
    tyreVisualCompound: 16,
    tyreAge: 8,
    weather: 0,
    trackTemperature: 42,
    airTemperature: 28,
    rainPercentage: 15,
    sessionType: "Race",
    totalLaps: 57,
    currentSector: 2,   // in sector 2 (1-indexed)
    sector1Time: 29.845,
    sector2Time: 0,     // not yet completed
    brakeTempFL: 580,
    brakeTempFR: 575,
    brakeTempRL: 420,
    brakeTempRR: 418,
    tyrePressureFL: 23.1,
    tyrePressureFR: 23.0,
    tyrePressureRL: 21.5,
    tyrePressureRR: 21.4,
    frontLeftWingDamage: 0,
    frontRightWingDamage: 0,
    rearWingDamage: 0,
    floorDamage: 2,
    diffuserDamage: 0,
    sidepodDamage: 0,
    tractionControl: 2,
    antiLockBrakes: 4,
    fuelMix: 1,
    frontBrakeBias: 57,
    pitLimiterStatus: 0,
    fuelRemainingLaps: 15.2,
    drsActivationDistance: 48,
    actualTyreCompound: 19,
    vehicleFIAFlags: 0,
    enginePowerICE: 455000,
    enginePowerMGUK: 120000,
    tyresDamageFL: 0,
    tyresDamageFR: 0,
    tyresDamageRL: 0,
    tyresDamageRR: 0,
    brakesDamageFL: 0,
    brakesDamageFR: 0,
    brakesDamageRL: 0,
    brakesDamageRR: 0,
    tyreBlistersFL: 0,
    tyreBlistsFR: 0,
    tyreBlistersRL: 0,
    tyreBlistersRR: 0,
    drsFault: 0,
    ersFault: 0,
    gearBoxDamage: 0,
    engineDamage: 0,
    engineMGUHWear: 12,
    engineESWear: 8,
    engineCEWear: 5,
    engineICEWear: 3,
    engineMGUKWear: 10,
    engineTCWear: 7,
    tyresInnerTempFL: 102,
    tyresInnerTempFR: 104,
    tyresInnerTempRL: 108,
    tyresInnerTempRR: 106,
    engineTemperature: 105,
    surfaceTypeFL: 0,
    surfaceTypeFR: 0,
    surfaceTypeRL: 0,
    surfaceTypeRR: 0,
    suggestedGear: 7,
    currentLapInvalid: 0,
    penalties: 0,
    totalWarnings: 0,
    cornerCuttingWarnings: 0,
    driverStatus: 1,
    pitLaneTimerActive: 0,
    pitLaneTimeInLaneInMS: 0,
    speedTrapFastestSpeed: 342.5,
    gridPosition: 3,
    safetyCarStatus: 0,
    trackLength: 5412,
    pitSpeedLimit: 80,
    formula: 0,
    sector2LapDistanceStart: 1890,
    sector3LapDistanceStart: 3540,
    pitStopWindowIdealLap: 28,
    pitStopWindowLatestLap: 34,
    grid: [
      { position: 1, driverId: 1, teamId: 1, name: "M. VERSTAPPEN", currentLapTime: 28.1, lastLapTime: 92.841, bestLapTime: 92.341, gapToLeader: 0, gapToCarAhead: 0, pitStatus: 0, numPitStops: 0, tyreCompound: "medium", tyreAge: 12, penalties: 0, bestS1: 28.4, bestS2: 32.1, bestS3: 31.8, lastS1: 28.6, lastS2: 32.3, lastS3: 31.9 },
      { position: 2, driverId: 4, teamId: 6, name: "C. LECLERC", currentLapTime: 28.4, lastLapTime: 92.905, bestLapTime: 92.680, gapToLeader: 0.3, gapToCarAhead: 0.3, pitStatus: 0, numPitStops: 0, tyreCompound: "medium", tyreAge: 12, penalties: 0, bestS1: 28.5, bestS2: 32.2, bestS3: 32.0, lastS1: 28.7, lastS2: 32.4, lastS3: 31.8 },
      { position: 3, driverId: 44, teamId: 1, name: "L. HAMILTON", currentLapTime: 28.5, lastLapTime: 93.105, bestLapTime: 92.990, gapToLeader: 0.8, gapToCarAhead: 0.5, pitStatus: 0, numPitStops: 0, tyreCompound: "soft", tyreAge: 8, penalties: 0, bestS1: 29.8, bestS2: 32.4, bestS3: 31.7, lastS1: 29.8, lastS2: 32.4, lastS3: 30.9 },
      { position: 4, driverId: 16, teamId: 6, name: "G. RUSSELL", currentLapTime: 29.1, lastLapTime: 93.421, bestLapTime: 93.100, gapToLeader: 1.4, gapToCarAhead: 0.6, pitStatus: 0, numPitStops: 0, tyreCompound: "soft", tyreAge: 8, penalties: 0, bestS1: 29.5, bestS2: 32.5, bestS3: 31.1, lastS1: 29.8, lastS2: 32.6, lastS3: 31.0 },
      { position: 5, driverId: 55, teamId: 3, name: "C. SAINZ", currentLapTime: 29.3, lastLapTime: 93.812, bestLapTime: 93.400, gapToLeader: 2.1, gapToCarAhead: 0.7, pitStatus: 0, numPitStops: 1, tyreCompound: "hard", tyreAge: 4, penalties: 0, bestS1: 29.7, bestS2: 32.7, bestS3: 31.0, lastS1: 30.0, lastS2: 32.8, lastS3: 31.0 },
    ],
  },
};

// ── Forza Motorsport Fake Packet ─────────────────────────────────────────────

export const fakeForzaPacket: TelemetryPacket = {
  ...basePacket,
  gameId: "fm-2023",
  CurrentEngineRpm: 6850,
  EngineMaxRpm: 8200,
  EngineIdleRpm: 950,
  // Forza sends tire temps in Fahrenheit
  TireTempFL: 205, // ~96°C
  TireTempFR: 208,
  TireTempRL: 215,
  TireTempRR: 212,
  Accel: 230,
  Brake: 0,
  Gear: 4,
  Speed: 55.6, // m/s ≈ 200 km/h
  Power: 380000,
  Torque: 520,
  CarOrdinal: 1742, // BMW M4
  CarClass: 5,
  CarPerformanceIndex: 820,
  DrivetrainType: 1, // RWD
  NumCylinders: 6,
  Fuel: 0.68, // Forza: 0–1 fraction of tank
  LapNumber: 3,
  RacePosition: 1,
  TireWearFL: 0.08,
  TireWearFR: 0.09,
  TireWearRL: 0.12,
  TireWearRR: 0.11,
};

// ── ACC Fake Packet ──────────────────────────────────────────────────────────

export const fakeAccPacket: TelemetryPacket = {
  ...basePacket,
  gameId: "acc",
  CurrentEngineRpm: 7800,
  EngineMaxRpm: 9000,
  EngineIdleRpm: 1200,
  // ACC sends tire temps in Celsius
  TireTempFL: 88,
  TireTempFR: 91,
  TireTempRL: 86,
  TireTempRR: 89,
  BrakeTempFrontLeft: 380,
  BrakeTempFrontRight: 375,
  BrakeTempRearLeft: 280,
  BrakeTempRearRight: 275,
  TirePressureFrontLeft: 27.8,
  TirePressureFrontRight: 27.6,
  TirePressureRearLeft: 26.2,
  TirePressureRearRight: 26.0,
  WeatherType: 0,
  TrackTemp: 36,
  AirTemp: 22,
  Speed: 66.7, // m/s ≈ 240 km/h
  Power: 430000,
  Torque: 580,
  CarOrdinal: 301, // Lamborghini Huracan GT3
  CarClass: 0,
  Gear: 5,
  Accel: 200,
  Brake: 0,
  Fuel: 38.2, // ACC: litres remaining
  LapNumber: 8,
  RacePosition: 2,
  TireWearFL: 0.25,
  TireWearFR: 0.26,
  TireWearRL: 0.30,
  TireWearRR: 0.29,
  acc: {
    tireCompound: "DHF",
    tireCoreTemp: [88, 91, 86, 89],
    tireInnerTemp: [92, 95, 90, 93],
    tireOuterTemp: [84, 87, 82, 85],
    tireCamber: [-0.052, -0.052, -0.035, -0.035],
    tireRadius: [0.330, 0.330, 0.330, 0.330],
    tireContactHeading: [
      [0.0, 0.0, 1.0],
      [0.0, 0.0, 1.0],
      [0.0, 0.0, 1.0],
      [0.0, 0.0, 1.0],
    ],
    brakePadCompound: 1,
    brakePadWear: [28.4, 28.2, 28.6, 28.5], // mm remaining (new = 29mm → ~98% health)
    tc: 3,
    tcCut: 0,
    abs: 4,
    engineMap: 2,
    brakeBias: 58.5,
    tcIntervention: 0,
    absIntervention: 0,
    tcRaw: 0.0,
    absRaw: 0.0,
    slipVibrations: 0.0,
    absVibrations: 0.0,
    rainIntensity: 0,
    trackGripStatus: "Green",
    windSpeed: 8.2,
    windDirection: 245,
    flagStatus: "Green",
    drsAvailable: false,
    drsEnabled: false,
    pitStatus: "None",
    fuelPerLap: 3.2,
    currentSectorIndex: 0,
    lastSectorTime: 42350,
    carDamage: {
      front: 0,
      rear: 0,
      left: 0,
      right: 0,
      centre: 0,
    },
  },
};

// ── Converted Display Packets ────────────────────────────────────────────────

function makeDisplayPacket(raw: TelemetryPacket): DisplayPacket {
  const isForza = raw.gameId === "fm-2023";
  const fahrenheitToC = (f: number) => (f - 32) / 1.8;
  return {
    ...raw,
    DisplaySpeed: Math.round(raw.Speed * 3.6), // m/s → km/h
    DisplayTireTempFL: isForza ? fahrenheitToC(raw.TireTempFL) : raw.TireTempFL,
    DisplayTireTempFR: isForza ? fahrenheitToC(raw.TireTempFR) : raw.TireTempFR,
    DisplayTireTempRL: isForza ? fahrenheitToC(raw.TireTempRL) : raw.TireTempRL,
    DisplayTireTempRR: isForza ? fahrenheitToC(raw.TireTempRR) : raw.TireTempRR,
  };
}

export const fakeF1DisplayPacket: DisplayPacket = makeDisplayPacket(fakeF1Packet);
export const fakeForzaDisplayPacket: DisplayPacket = makeDisplayPacket(fakeForzaPacket);
export const fakeAccDisplayPacket: DisplayPacket = makeDisplayPacket(fakeAccPacket);

// ── Sector Data ──────────────────────────────────────────────────────────────
// We are on lap 5, partway through S2.
// Last completed lap = lap 4: S1=29.845 S2=32.21 S3=30.286 → 92.341
// Best sectors across all laps: S1=29.8 (lap3), S2=32.21 (lap4), S3=30.286 (lap4)
// Current lap: S1=29.845 done, S2 running at ~31.8 (on pace for purple)

export const fakeSectors: LiveSectorData = {
  currentSector: 1,          // 0-indexed: in sector 2
  currentSectorTime: 31.8,   // elapsed time in current sector (S2)
  currentTimes: [29.845, 31.8, 0],          // S1 done, S2 in progress
  lastTimes: [29.845, 32.210, 30.286],      // lap 4 sectors (sum = 92.341)
  bestTimes: [29.800, 32.210, 30.286],      // best S1 from lap3, S2+S3 from lap4
  lastLapTime: 92.341,                      // lap 4
  bestLapTime: 92.341,                      // lap 4 is best
  estimatedLap: 92.686,                     // S1=29.845 + S2~31.8 + bestS3=30.286 est → ≈91.9 optimistic; use 92.686
  deltaToBest: 0.345,                       // on track for +0.345 vs best
  deltaToLast: 0.345,                       // same as best this session
};

// ── Pit Data ─────────────────────────────────────────────────────────────────

export const fakePit: LivePitData = {
  fuelPerLap: 2.8,
  fuelLapsRemaining: 15.2,  // 42.5L ÷ 2.8L/lap
  currentLapFuelUsed: 1.4,
  tireLapsToBad: 12,
  tireLapsToCritical: 22,
  tireEstimates: {
    toCliff: [13, 13, 11, 12],
    toDead: [23, 23, 21, 22],
    wearPerLap: [0.028, 0.029, 0.032, 0.031], // fraction per lap (×100 = % per lap)
  },
  tireWearPerLap: 0.032,
  pitInLaps: 12,
  limitedBy: "tires",
  trackLength: 5412,
  estimateSource: "session",
  cliffPct: 40,
  deadPct: 20,
  tireLapsRemaining: 12,
};

// ── Session Laps ─────────────────────────────────────────────────────────────

export const fakeSessionLaps: LapMeta[] = [
  { id: 1, sessionId: 1, lapNumber: 1, lapTime: 95.420, isValid: true, createdAt: "2026-04-13T10:00:00Z", carOrdinal: 42, trackOrdinal: 7, s1Time: 30.1, s2Time: 33.5, s3Time: 31.82 },
  { id: 2, sessionId: 1, lapNumber: 2, lapTime: 93.841, isValid: true, createdAt: "2026-04-13T10:02:00Z", carOrdinal: 42, trackOrdinal: 7, s1Time: 29.9, s2Time: 32.6, s3Time: 31.34 },
  { id: 3, sessionId: 1, lapNumber: 3, lapTime: 93.105, isValid: true, createdAt: "2026-04-13T10:04:00Z", carOrdinal: 42, trackOrdinal: 7, s1Time: 29.8, s2Time: 32.4, s3Time: 30.9 },
  { id: 4, sessionId: 1, lapNumber: 4, lapTime: 92.341, isValid: true, createdAt: "2026-04-13T10:06:00Z", carOrdinal: 42, trackOrdinal: 7, s1Time: 29.845, s2Time: 32.21, s3Time: 30.286 },
];
