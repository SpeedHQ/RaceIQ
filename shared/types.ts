export interface TelemetryPacket {
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
  SuspensionTravelMetersFL: number;
  SuspensionTravelMetersFR: number;
  SuspensionTravelMetersRL: number;
  SuspensionTravelMetersRR: number;

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
}

export interface LapMeta {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  createdAt: string;
  pi?: number;
  // Joined from session
  carOrdinal?: number;
  trackOrdinal?: number;
  // Tune assignment
  tuneId?: number;
  tuneName?: string;
}

export interface SessionMeta {
  id: number;
  carOrdinal: number;
  trackOrdinal: number;
  createdAt: string;
  lapCount?: number;
}

export interface ServerStatus {
  udpReceiving: boolean;
  packetsPerSec: number;
  connectedClients: number;
  droppedPackets: number;
  currentSession: SessionMeta | null;
}

export const CAR_CLASS_NAMES: Record<number, string> = {
  0: "D",
  1: "C",
  2: "B",
  3: "A",
  4: "S",
  5: "R",
  6: "P",
  7: "X",
};

export const DRIVETRAIN_NAMES: Record<number, string> = {
  0: "FWD",
  1: "RWD",
  2: "AWD",
};

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
  rollCenterHeight?: {
    front: number;
    rear: number;
  };
  antiGeometry?: {
    antiDiveFront: number;
    antiSquatRear: number;
  };
  aero: {
    frontDownforce: number;
    rearDownforce: number;
    unit?: string;
  };
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
