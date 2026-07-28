import { z } from "zod";

export const KNOWN_GAME_IDS = ["fm-2023", "f1-2025", "acc", "ac-evo"] as const;

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
  /**
   * Per-lap completed sector times from the F1 SessionHistory packet, keyed by
   * 1-indexed lap number. Each entry is `{ s1, s2, s3, lapTime }` in seconds.
   * Prefer this over `lastS1/lastS2/lastS3` for specific-lap queries — the
   * "last" fields track whatever lap is currently in progress in the game, so
   * they reset to 0 the moment a new lap starts.
   */
  lapSectors?: Record<number, { s1: number; s2: number; s3: number; lapTime: number }>;
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
  /**
   * Middle-band surface temp per tire (°C, FL/FR/RL/RR). Read from physics
   * offsets 384-396. With inner/outer this gives the 3-point lateral temp
   * profile the tire symptom module uses for a camber-direction recommendation.
   */
  tireMiddleTemp?: [number, number, number, number];
  tireOuterTemp: [number, number, number, number];
  tireCamber: [number, number, number, number]; // radians, FL/FR/RL/RR
  /**
   * Vertical wheel load per tire (N, FL/FR/RL/RR). Physics offsets 72-84,
   * previously skipped. Recovered retroactively from the raw .bin. Used by the
   * weight-transfer module as a direct load-distribution signal.
   */
  wheelLoad?: [number, number, number, number];
  /**
   * Ride height (m). ACC exposes a 2-element array (front, rear) at offsets
   * 268-272. Used by the weight-transfer module's aero-vs-mechanical split.
   */
  rideHeight?: [number, number];
  /** Center-of-gravity height (m). Physics offset 220, previously skipped. */
  cgHeight?: number;
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
  /**
   * Ambient air / track surface temp (°C), read from SPageFilePhysics
   * (airTemp @288, roadTemp @292 — base-struct fields from the official
   * SharedFileOut.h). Optional: null when the source buffer predates wiring
   * or is truncated before offset 292.
   */
  airTempC?: number | null;
  roadTempC?: number | null;

  // Race state
  flagStatus: string;
  drsAvailable: boolean;
  drsEnabled: boolean;
  pitStatus: string;
  /**
   * ACC's own lap-validity flag (graphics struct, offset 1408).
   * true = clean, false = invalidated (track cut / pit speed / etc).
   * null = not available in source recording (legacy V2 bins, buffer truncated before offset 1408).
   */
  isValidLap: boolean | null;

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

  /**
   * AC Evo-only extras read from the v0.6 shared-memory pages. Optional so the
   * ACC parser (which shares this type) can omit it. Every field maps 1:1 to a
   * struct field the parser previously ignored — the raw bytes were already in
   * the recorded .bin (full physics/graphics/static pages), so reprocessing old
   * AC Evo sessions surfaces these without a re-record.
   */
  acEvo?: AcEvoExtendedData;
}

export interface AcEvoExtendedData {
  // Frame identity / staleness — packet IDs increment each shm write.
  physicsPacketId: number;
  graphicsPacketId: number;
  acEvoVersion: string;

  // Session context (STATIC_EVO)
  sessionType: string;          // "time_attack" | "race" | "hot_stint" | "cruise" | "unknown"
  sessionName: string;
  startingGrip: string;         // "green" | "fast" | "optimum" | "unknown"
  isStaticWeather: boolean;
  isTimedRace: boolean;
  isOnline: boolean;
  numberOfSessions: number;

  // Live environment (PHYSICS — distinct from STATIC starting temps)
  airTempC: number;
  roadTempC: number;

  // Live timing (GRAPHICS_EVO — the fields v0.5 froze)
  deltaTimeMs: number;          // live delta vs reference lap
  predictedLapTimeMs: number;
  deltaCurrent: string;         // preformatted from TIMING_STATE (e.g. "-0.234")
  deltaLast: string;
  idealLapTime: string;
  timingIsInvalid: boolean;

  // Session-state block (GRAPHICS_EVO embedded SESSION_STATE)
  sessionTimeLeftMs: number;
  sessionTotalLaps: number;
  sessionCurrentLap: number;
  lapLengthKm: number;

  // Electronics setting levels not already on the acc object
  escLevel: number;
  engineMapLevel: number;
  isDrsOpen: boolean;

  // Engine health (GRAPHICS_EVO)
  clutchPercent: number;        // 0..1
  handbrakePercent: number;     // 0..1
  waterTempC: number;
  oilTempC: number;
  oilPressureBar: number;
  exhaustTempC: number;
  turboBoost: number;
  currentTorque: number;
  currentBhp: number;
  isWrongWay: boolean;

  // Fuel economy (GRAPHICS_EVO)
  fuelLiters: number;
  fuelPercent: number;
  fuelLitersPerLap: number;
  fuelLitersUsed: number;
  lapsPossibleWithFuel: number;
  kmPerFuelLiter: number;
  instantaneousKmPerLiter: number;

  // Brake disc life + tyre middle-tread temps (PHYSICS — pad life & inner/outer
  // already exposed on the packet; these complete the picture)
  brakeDiscLife: [number, number, number, number];  // FL/FR/RL/RR
  tyreMiddleTempC: [number, number, number, number]; // FL/FR/RL/RR

  // Car-frame velocity (PHYSICS localVelocity — distinct from world VelocityXYZ)
  localVelocity: [number, number, number]; // x, y, z

  // Race gaps (GRAPHICS_EVO)
  gapAheadMs: number;
  gapBehindMs: number;

  // Odometry (GRAPHICS_EVO)
  sessionKm: number;
  totalDrivingTimeS: number;

  // Time of day (GRAPHICS_EVO)
  timeOfDayHours: number;
  timeOfDayMinutes: number;
  timeOfDaySeconds: number;
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
  /**
   * Raw car name/model string from telemetry when CarOrdinal is -1 (car not
   * in the game's cars.csv). Lets the session layer register the car in
   * discovered_cars instead of storing an unresolvable -1. AC Evo only.
   */
  carModelName?: string;
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
  // Explicit tuning-session link (migration v25). Stamped at insert from the
  // active tuning session; null for laps recorded outside a tuning session.
  tuningSessionId?: number | null;
  // Explicit tuning-test (setup version) link (migration v29). Null when the lap
  // predates head tracking or was driven with no head set.
  tuningTestId?: number | null;
  // User flag (migration v30): true = manually excluded from the tuning
  // aggregate. Undefined/false = included.
  tuningExcluded?: boolean;
  // Source of the tuningExcluded decision (migration v34): 'auto' = the
  // fastest-5 curation pass (server/tuning-auto-exclude.ts) owns this lap's
  // state and may revise it on a later lap save; 'manual' = user/AI decided,
  // pinned against the auto pass. Undefined/null = not yet reconciled.
  tuningExcludedSource?: "auto" | "manual" | null;
  // Persisted per-lap metrics (migration v32), derived once from telemetry and
  // cached on the lap row. Null/undefined = not yet computed or no usable
  // telemetry channel.
  fuelPerLap?: number | null;
  tyreWear?: number | null;
  // Number of raw telemetry frames stored for this lap (`laps.raw_frame_count`).
  // One integer on the row, so a caller can budget decode cost WITHOUT decoding
  // anything — see FRAME_BUDGET_PER_ARM in server/ai/arm-stream.ts. Only
  // populated by queries that ask for it; undefined means "not selected", not
  // "no frames".
  rawFrameCount?: number | null;
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

/**
 * Post-session summary shown on the recap card. Every field is derived from laps
 * we already store — see server/recap.ts for the rules. Nullable fields mean
 * "not computable for this session" and render as a hidden tile, never as a zero.
 */
export interface SessionRecap {
  sessionId: number;
  gameId: GameId;
  carName: string;
  trackName: string;
  /** Raw ordinals, for deep-linking into the analyse view. */
  carOrdinal: number;
  trackOrdinal: number;
  createdAt: string;

  /** Laps with isValid && lapTime > 0. */
  lapsValid: number;
  /** Every lap row, including invalid ones. Display only ("valid/total"). */
  lapsTotal: number;
  /** Fastest valid lap, seconds. Null when no valid laps. */
  bestLapSec: number | null;
  /** Lap id of the fastest valid lap, for deep-linking. Null when no valid laps. */
  bestLapId: number | null;
  /** Sum of lapTime over VALID laps only — invalid laps are often detector artifacts. */
  timeOnTrackSec: number;
  /** trackLength * lapsValid, metres. Null when the track has no outline. */
  distanceM: number | null;

  /** Pace trend, in lap order. */
  sparkline: { lapNumber: number; lapTimeSec: number; isValid: boolean }[];

  /** Best sectors across valid laps, possibly from different laps. Null when no valid lap has all three. */
  theoretical: {
    bestS1: number;
    bestS2: number;
    bestS3: number;
    sumSec: number;
    /** bestLapSec - sumSec, clamped >= 0. The time left on the table. */
    deltaToBestSec: number;
  } | null;

  /** First valid lap minus best lap, clamped >= 0. Null when fewer than 2 valid laps. */
  improvementSec: number | null;
  /** Population stddev of valid lap times, rated relative to best lap. Null when fewer than 3 valid laps. */
  consistency: {
    stdDevSec: number;
    rating: 1 | 2 | 3 | 4 | 5;
  } | null;
  /** Compared against other sessions with the same track + car + game. Null when bestLapSec is null. */
  personalBest: {
    isNew: boolean;
    /** Null when this is the first ever session on this track + car. */
    previousBestSec: number | null;
  } | null;

  /**
   * Per-sector breakdown of the session, for the sector-coloured track map.
   * Null when no valid lap has a complete set of sectors (same condition as `theoretical`).
   */
  sectors:
    | {
        /** 1, 2 or 3. */
        index: 1 | 2 | 3;
        /** This sector's time on the session's BEST lap. */
        bestLapSec: number;
        /** Fastest time in this sector across all valid laps this session (feeds `theoretical`). */
        sessionBestSec: number;
        /** Fastest ever in this sector for this track+car+game, EXCLUDING this session. Null if none. */
        allTimeBestSec: number | null;
        /**
         * record       = sessionBestSec beat allTimeBestSec (or there is no all-time yet) — a new record
         * session-best = the best lap's sector equals this session's best in that sector
         * lost         = the best lap lost time in this sector vs this session's own best
         */
        status: "record" | "session-best" | "lost";
      }[]
    | null;
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

// ── Live Tuning Dashboard: unified issue model ──────────────────────────────
// Shared by the per-lap issue feed (server/ai/tune-issues.ts::symptomsToIssues)
// and the live transient detector (server/ai/tune-issues.ts::detectLiveIssues).
export type TuneIssueKind =
  | "understeer"
  | "oversteer"
  | "brake-lockup"
  | "bottoming"
  | "tyre-pressure"
  | "tyre-temp";

export type TuneIssueSeverity = "info" | "warn" | "critical";

export interface TuneIssue {
  kind: TuneIssueKind;
  severity: TuneIssueSeverity;
  /** Corner label when corner-scoped (e.g. "T4"); omitted for lap-wide issues. */
  corner?: string;
  /** Distance fraction 0..1 for track-map placement; omitted when not applicable. */
  distanceFrac?: number;
  /** Human-readable one-liner, e.g. "FL locking under braking (-0.22 slip)". */
  detail: string;
  /** Present on per-lap issues; absent on live transients. */
  lapNumber?: number;
}

// ── Tuning tests as experiments (issue #120, migration v37) ─────────────────
// A tuning_test node varies exactly one of two things, and `kind` says which.
// Both shapes are serialised into tuning_tests.applied_changes as a JSON array.

/** A setup knob edit — the original meaning of an applied change. */
export interface SetupChange {
  kind: "setup";
  /** Knob name as shown to the driver, e.g. "Front anti-roll bar". */
  component: string;
  /** Every JSON setup path this knob wrote (1 for scalars, 2 for axle pairs). */
  paths: string[];
  from: number;
  to: number;
  /**
   * Optional because pre-v37 rows were written without it. Absent means "no
   * direction word was recorded", not "no direction" — callers fall back to
   * the signed from→to delta. Mirrors TuneDirection in server/ai/schemas.ts.
   */
  direction?: "increase" | "decrease";
  reason: string;
}

/** A driving change — a drill the driver runs, with no setup file behind it. */
export interface DrillChange {
  kind: "drill";
  /** Short imperative name, e.g. "Brake 10m later into T4". */
  title: string;
  /** What the driver actually does, in enough detail to repeat it. */
  instruction: string;
  /** Corner labels the drill targets (e.g. ["T4"]); empty = lap-wide. */
  corners: string[];
  reason: string;
}

export type TestChange = SetupChange | DrillChange;

/** What a tuning test varies. Mirrors tuning_tests.kind. */
export type TuningTestKind = TestChange["kind"];

/** Outcome of an experiment once laps have run against it. */
export type TuningTestVerdict =
  | "better"
  | "worse"
  | "neutral"
  | "inconclusive";

/** Who decided the verdict — an auto call can be overridden by the driver. */
export type TuningTestVerdictSource = "auto" | "manual";
