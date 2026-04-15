import { z } from "zod";

export const KNOWN_GAME_IDS = ["fm-2023", "f1-2025", "acc"] as const;
export const GameIdSchema = z.enum(KNOWN_GAME_IDS);
export type GameId = z.infer<typeof GameIdSchema>;

export interface F1GridEntry {
  position: number;
  driverId: number;
  teamId: number;
  name: string;
  currentLapTime: number;
  lastLapTime: number;
  bestLapTime: number;
  gapToLeader: number;
  gapToCarAhead: number;
  pitStatus: number;
  numPitStops: number;
  tyreCompound: string;
  tyreAge: number;
  penalties: number;
  // Sector times from session history (seconds, 0 if unavailable)
  bestS1: number;
  bestS2: number;
  bestS3: number;
  lastS1: number;
  lastS2: number;
  lastS3: number;
}

export interface F1ExtendedData {
  drsAllowed: boolean;
  drsActivated: boolean;
  drsZoneApproaching: boolean;
  ersStoreEnergy: number;
  ersDeployMode: number;
  ersDeployedThisLap: number;
  ersHarvestedThisLap: number;
  tyreCompound: string;
  tyreVisualCompound: number;
  tyreAge: number;
  weather: number;
  trackTemperature: number;
  airTemperature: number;
  rainPercentage: number;
  sessionType: string;
  totalLaps: number;
  currentSector: number; // 0=S1, 1=S2, 2=S3
  sector1Time: number; // seconds (0 if not completed this lap)
  sector2Time: number; // seconds (0 if not completed this lap)
  lastS1: number; // definitive sector times from SessionHistory (0 if not yet received)
  lastS2: number;
  lastS3: number;
  // Damage (0-100, 0=no damage)
  // Brake temps (Celsius)
  brakeTempFL: number;
  brakeTempFR: number;
  brakeTempRL: number;
  brakeTempRR: number;
  // Tyre pressures (PSI)
  tyrePressureFL: number;
  tyrePressureFR: number;
  tyrePressureRL: number;
  tyrePressureRR: number;
  // Damage (0-100, 0=no damage)
  frontLeftWingDamage: number;
  frontRightWingDamage: number;
  rearWingDamage: number;
  floorDamage: number;
  diffuserDamage: number;
  sidepodDamage: number;
  // Extended CarStatus fields
  tractionControl?: number;
  antiLockBrakes?: number;
  fuelMix?: number;
  frontBrakeBias?: number;
  pitLimiterStatus?: number;
  fuelRemainingLaps?: number;
  drsActivationDistance?: number;
  actualTyreCompound?: number;
  vehicleFIAFlags?: number;
  enginePowerICE?: number;
  enginePowerMGUK?: number;
  // Extended CarDamage fields
  tyresDamageFL?: number;
  tyresDamageFR?: number;
  tyresDamageRL?: number;
  tyresDamageRR?: number;
  brakesDamageFL?: number;
  brakesDamageFR?: number;
  brakesDamageRL?: number;
  brakesDamageRR?: number;
  tyreBlistersFL?: number;
  tyreBlistsFR?: number;
  tyreBlistersRL?: number;
  tyreBlistersRR?: number;
  drsFault?: number;
  ersFault?: number;
  gearBoxDamage?: number;
  engineDamage?: number;
  engineMGUHWear?: number;
  engineESWear?: number;
  engineCEWear?: number;
  engineICEWear?: number;
  engineMGUKWear?: number;
  engineTCWear?: number;
  // Extended CarTelemetry fields
  tyresInnerTempFL?: number;
  tyresInnerTempFR?: number;
  tyresInnerTempRL?: number;
  tyresInnerTempRR?: number;
  engineTemperature?: number;
  surfaceTypeFL?: number;
  surfaceTypeFR?: number;
  surfaceTypeRL?: number;
  surfaceTypeRR?: number;
  suggestedGear?: number;
  // Extended LapData fields
  currentLapInvalid?: number;
  penalties?: number;
  totalWarnings?: number;
  cornerCuttingWarnings?: number;
  driverStatus?: number;
  pitLaneTimerActive?: number;
  pitLaneTimeInLaneInMS?: number;
  speedTrapFastestSpeed?: number;
  gridPosition?: number;
  // Extended Session fields
  safetyCarStatus?: number;
  trackLength?: number;
  pitSpeedLimit?: number;
  formula?: number;
  sector2LapDistanceStart?: number;
  sector3LapDistanceStart?: number;
  pitStopWindowIdealLap?: number;
  pitStopWindowLatestLap?: number;
  grid: F1GridEntry[];
  // Car setup (from PacketCarSetupData, packet ID 5)
  setup?: F1CarSetup;
  // MotionEx — per-packet detailed physics
  motionEx?: {
    wheelSlipAngleFL: number; wheelSlipAngleFR: number;
    wheelSlipAngleRL: number; wheelSlipAngleRR: number;
    wheelLatForceFL: number; wheelLatForceFR: number;
    wheelLatForceRL: number; wheelLatForceRR: number;
    wheelLongForceFL: number; wheelLongForceFR: number;
    wheelLongForceRL: number; wheelLongForceRR: number;
    wheelVertForceFL: number; wheelVertForceFR: number;
    wheelVertForceRL: number; wheelVertForceRR: number;
    frontWheelsAngle: number;
    frontAeroHeight: number; rearAeroHeight: number;
    frontRollAngle: number; rearRollAngle: number;
    chassisYaw: number; chassisPitch: number;
    heightOfCOGAboveGround: number;
  };
}

export interface F1CarSetup {
  frontWing: number;
  rearWing: number;
  onThrottle: number;       // differential on-throttle %
  offThrottle: number;      // differential off-throttle %
  frontCamber: number;      // degrees (negative)
  rearCamber: number;       // degrees (negative)
  frontToe: number;         // degrees
  rearToe: number;          // degrees
  frontSuspension: number;  // 1-11
  rearSuspension: number;   // 1-11
  frontAntiRollBar: number; // 1-11
  rearAntiRollBar: number;  // 1-11
  frontRideHeight: number;  // 1-50
  rearRideHeight: number;   // 1-50
  brakePressure: number;    // %
  brakeBias: number;        // %
  engineBraking: number;    // %
  rearLeftTyrePressure: number;   // PSI
  rearRightTyrePressure: number;  // PSI
  frontLeftTyrePressure: number;  // PSI
  frontRightTyrePressure: number; // PSI
  fuelLoad: number;         // kg
}

/** ACC-specific extended telemetry data from shared memory */
export interface AccExtendedData {
  // Tire detail
  tireCompound: string;
  tireCoreTemp: [number, number, number, number];
  tireInnerTemp: [number, number, number, number];
  tireOuterTemp: [number, number, number, number];
  tireCamber: [number, number, number, number]; // radians, FL/FR/RL/RR
  tireRadius: [number, number, number, number]; // metres, FL/FR/RL/RR (from STATIC)
  // Per-tire forward-rolling heading unit vector in world space (FL/FR/RL/RR, [x,y,z])
  tireContactHeading: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];

  // Brake detail
  brakePadCompound: number;
  brakePadWear: [number, number, number, number];

  // Electronics — driver settings (level values)
  tc: number;
  tcCut: number;
  abs: number;
  engineMap: number;
  brakeBias: number;
  // Electronics — runtime intervention. tc@204 and abs@252 are the canonical
  // aid floats; slipVibrations@788 and absVibrations@796 are fallbacks that
  // some ACC versions populate instead. `tcIntervention`/`absIntervention`
  // are 1 when any of the sources indicates activity.
  tcIntervention: number;
  absIntervention: number;
  tcRaw: number;
  absRaw: number;
  slipVibrations: number;
  absVibrations: number;

  // Weather
  rainIntensity: number;
  trackGripStatus: string;
  windSpeed: number;
  windDirection: number;

  // Race state
  flagStatus: string;
  drsAvailable: boolean;
  drsEnabled: boolean;
  pitStatus: string;

  // Fuel
  fuelPerLap: number;

  // Sector timing (native from game)
  currentSectorIndex: number;  // 0=S1, 1=S2, 2=S3
  lastSectorTime: number;       // ms, time of last completed sector

  // Damage
  carDamage: {
    front: number;
    rear: number;
    left: number;
    right: number;
    centre: number;
  };
}

export interface TelemetryPacket {
  gameId: GameId;
  f1?: F1ExtendedData;
  acc?: AccExtendedData;

  // Game session UID (F1 only — used for session boundary detection)
  sessionUID?: string;

  // Race status
  IsRaceOn: number; // s32

  // Timing
  TimestampMS: number; // u32

  // Engine
  EngineMaxRpm: number;
  EngineIdleRpm: number;
  CurrentEngineRpm: number;

  // Acceleration (g-force)
  AccelerationX: number;
  AccelerationY: number;
  AccelerationZ: number;

  // Velocity (m/s)
  VelocityX: number;
  VelocityY: number;
  VelocityZ: number;

  // Angular velocity (rad/s)
  AngularVelocityX: number;
  AngularVelocityY: number;
  AngularVelocityZ: number;

  // Orientation (radians)
  Yaw: number;
  Pitch: number;
  Roll: number;

  // Normalized suspension travel (0.0 = full extension, 1.0 = full compression)
  NormSuspensionTravelFL: number;
  NormSuspensionTravelFR: number;
  NormSuspensionTravelRL: number;
  NormSuspensionTravelRR: number;

  // Tire slip ratio
  TireSlipRatioFL: number;
  TireSlipRatioFR: number;
  TireSlipRatioRL: number;
  TireSlipRatioRR: number;

  // Wheel rotation speed (rad/s)
  WheelRotationSpeedFL: number;
  WheelRotationSpeedFR: number;
  WheelRotationSpeedRL: number;
  WheelRotationSpeedRR: number;

  // Wheel on rumble strip
  WheelOnRumbleStripFL: number;
  WheelOnRumbleStripFR: number;
  WheelOnRumbleStripRL: number;
  WheelOnRumbleStripRR: number;

  // Wheel in puddle depth
  WheelInPuddleDepthFL: number;
  WheelInPuddleDepthFR: number;
  WheelInPuddleDepthRL: number;
  WheelInPuddleDepthRR: number;

  // Surface rumble (set 2)
  SurfaceRumbleFL_2: number;
  SurfaceRumbleFR_2: number;
  SurfaceRumbleRL_2: number;
  SurfaceRumbleRR_2: number;

  // Tire slip combined (set 2)
  TireSlipCombinedFL_2: number;

  // Tire temps (F)
  TireTempFL: number;
  TireTempFR: number;
  TireTempRL: number;
  TireTempRR: number;

  // Engine/fuel
  Boost: number;
  Fuel: number;

  // Distance & lap times
  DistanceTraveled: number;
  BestLap: number;
  LastLap: number;
  CurrentLap: number;
  CurrentRaceTime: number;


  // Lap/position
  LapNumber: number; // u16
  RacePosition: number; // u8

  // Inputs (0-255)
  Accel: number;
  Brake: number;
  Clutch: number;
  HandBrake: number;
  Gear: number;
  Steer: number; // signed int8: 0 = center, -128 = full left, 127 = full right

  // Normalized driving line / AI
  NormDrivingLine: number; // s8
  NormAIBrakeDiff: number; // s8

  // Tire wear
  TireWearFL: number;
  TireWearFR: number;
  TireWearRL: number;
  TireWearRR: number;

  // Surface rumble (s32)
  SurfaceRumbleFL: number;
  SurfaceRumbleFR: number;
  SurfaceRumbleRL: number;
  SurfaceRumbleRR: number;

  // Tire slip angle
  TireSlipAngleFL: number;
  TireSlipAngleFR: number;
  TireSlipAngleRL: number;
  TireSlipAngleRR: number;

  // Tire combined slip
  TireCombinedSlipFL: number;
  TireCombinedSlipFR: number;
  TireCombinedSlipRL: number;
  TireCombinedSlipRR: number;

  // Suspension travel (meters)
  SuspensionTravelMFL: number;
  SuspensionTravelMFR: number;
  SuspensionTravelMRL: number;
  SuspensionTravelMRR: number;

  // Car info
  CarOrdinal: number; // s32
  CarClass: number; // s32 (0-7)
  CarPerformanceIndex: number; // s32
  DrivetrainType: number; // s32 (0=FWD, 1=RWD, 2=AWD)
  NumCylinders: number; // s32

  // Dash extension — position, speed, power
  PositionX: number; // f32 world space
  PositionY: number; // f32
  PositionZ: number; // f32
  Speed: number; // f32 meters/sec
  Power: number; // f32 watts
  Torque: number; // f32 newton meters

  // Track ID
  TrackOrdinal: number; // s32

  // Brake temps (ACC only)
  BrakeTempFrontLeft?: number;
  BrakeTempFrontRight?: number;
  BrakeTempRearLeft?: number;
  BrakeTempRearRight?: number;

  // Tire pressures (ACC only)
  TirePressureFrontLeft?: number;
  TirePressureFrontRight?: number;
  TirePressureRearLeft?: number;
  TirePressureRearRight?: number;

  // DRS/ERS (F1 only)
  DrsActive?: number;       // 1 = open, 0 = closed
  ErsStoreEnergy?: number;  // joules
  ErsDeployMode?: number;   // 0=none, 1=low, 2=medium, 3=high, 4=overtake
  ErsDeployed?: number;     // joules deployed this lap
  ErsHarvested?: number;    // joules harvested this lap

  // Weather/track conditions (F1/ACC)
  WeatherType?: number;     // 0=clear, 1=light cloud, 2=overcast, 3=light rain, 4=heavy rain, 5=storm
  TrackTemp?: number;       // °C
  AirTemp?: number;         // °C
  RainPercent?: number;     // 0-100

  // Tyre compound (F1: visual compound number, ACC: string via acc.tireCompound)
  TyreCompound?: number;    // F1 visual: 16=soft, 17=medium, 18=hard, 7=inter, 8=wet
}

/** Server-computed live sector timing, broadcast via WebSocket. */
export interface LiveSectorData {
  currentSector: number;
  currentSectorTime: number;
  currentTimes: [number, number, number];
  lastTimes: [number, number, number];
  bestTimes: [number, number, number];
  lastLapTime: number;
  bestLapTime: number;
  estimatedLap: number;
  deltaToBest: number;
  deltaToLast: number;
}

/** Server-computed pit strategy data, broadcast via WebSocket. */
export interface LivePitData {
  fuelPerLap: number;
  fuelLapsRemaining: number | null;
  currentLapFuelUsed: number;
  /** Laps until worst tire hits the game's "bad health" threshold (yellow). */
  tireLapsToBad: number | null;
  /** Laps until worst tire hits 20% health (critical / near-dead). */
  tireLapsToCritical: number | null;
  /** Per-tire laps to cliff and to dead, and wear rate per lap. */
  tireEstimates: {
    toCliff: [number | null, number | null, number | null, number | null]; // FL, FR, RL, RR
    toDead: [number | null, number | null, number | null, number | null];
    wearPerLap: [number, number, number, number];
  };
  /** Wear per lap from last completed lap (worst tire). */
  tireWearPerLap: number;
  pitInLaps: number | null;
  limitedBy: "fuel" | "tires" | null;
  trackLength: number;
  /** Whether estimates are from historical data or current session laps. */
  estimateSource: "history" | "session" | null;
  /** Health threshold percentages used for cliff and dead. */
  cliffPct: number;
  deadPct: number;
  // Deprecated — use tireLapsToBad
  tireLapsRemaining: number | null;
}

export interface LapMeta {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  invalidReason?: string;
  notes?: string;
  createdAt: string;
  pi?: number;
  gameId?: GameId;
  // Joined from session
  carOrdinal?: number;
  trackOrdinal?: number;
  // Car setup snapshot (JSON string of F1CarSetup)
  carSetup?: string;
  // Tune assignment
  tuneId?: number;
  tuneName?: string;
  // Sector times (stored at save time)
  s1Time?: number;
  s2Time?: number;
  s3Time?: number;
}

export interface SessionMeta {
  id: number;
  carOrdinal: number;
  trackOrdinal: number;
  createdAt: string;
  lapCount?: number;
  bestLapTime?: number;
  sessionType?: string;
  notes?: string;
  gameId?: GameId;
}

export interface ServerStatus {
  udpReceiving: boolean;
  packetsPerSec: number;
  connectedClients: number;
  droppedPackets: number;
  currentSession: SessionMeta | null;
}

// Phase 2: Comparison types

export interface AlignedTrace {
  distance: number[];
  speedA: number[];
  speedB: number[];
  throttleA: number[];
  throttleB: number[];
  brakeA: number[];
  brakeB: number[];
  rpmA: number[];
  rpmB: number[];
  tireWearA?: number[];
  tireWearB?: number[];
}

export interface CornerDelta {
  label: string;
  deltaSeconds: number;
  timeA: number; // section time for lap A in seconds
  timeB: number; // section time for lap B in seconds
}

export interface ComparisonData {
  lapA: LapMeta;
  lapB: LapMeta;
  traces: AlignedTrace;
  timeDelta: number[]; // cumulative time gain/loss at each distance point
  corners: CornerDelta[];
  telemetryA: TelemetryPacket[];
  telemetryB: TelemetryPacket[];
}

// Tune types

export type TuneCategory = 'circuit' | 'wet' | 'low-drag' | 'stable' | 'track-specific';

export interface TuneSettings {
  tires: {
    frontPressure: number;
    rearPressure: number;
    compound?: string;
  };
  gearing: {
    finalDrive: number;
    ratios?: number[];
    topSpeedKph?: number;
    description?: string;
  };
  alignment: {
    frontCamber: number;
    rearCamber: number;
    frontToe: number;
    rearToe: number;
    frontCaster?: number;
  };
  antiRollBars: {
    front: number;
    rear: number;
  };
  springs: {
    frontRate: number;
    rearRate: number;
    frontHeight: number;
    rearHeight: number;
    unit?: string;
  };
  damping: {
    frontRebound: number;
    rearRebound: number;
    frontBump: number;
    rearBump: number;
  };
  rollCenterHeight: {
    front: number;
    rear: number;
  };
  antiGeometry: {
    antiDiveFront: number;
    antiSquatRear: number;
  };
  aero: {
    frontDownforce: number;
    rearDownforce: number;
    unit?: string;
  };
  drivetrain?: "rwd" | "fwd" | "awd";
  differential: {
    frontAccel?: number;
    frontDecel?: number;
    rearAccel: number;
    rearDecel: number;
    center?: number;
  };
  brakes: {
    balance: number;
    pressure: number;
  };
}

export interface RaceStrategy {
  condition: "Dry" | "Wet";
  totalLaps: number;
  fuelLoadPercent: number;
  tireCompound: string;
  pitStops: number;
  pitLaps?: number[];
  notes?: string;
}

export interface Tune {
  id: number;
  name: string;
  author: string;
  carOrdinal: number;
  category: TuneCategory;
  trackOrdinal?: number;
  description: string;
  strengths: string[];
  weaknesses: string[];
  bestTracks?: string[];
  strategies?: RaceStrategy[];
  settings: TuneSettings;
  unitSystem: 'metric' | 'imperial';
  source: 'user' | 'catalog-clone';
  catalogId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TuneAssignment {
  carOrdinal: number;
  trackOrdinal: number;
  tuneId: number;
  tuneName?: string;
}
