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
  Steer: number; // 127 = center

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
  CarCategory: number; // s32

  // Unknown trailing bytes
  Unknown1: number; // u8
  Unknown2: number; // u8
  Unknown3: number; // u8
}

export interface LapMeta {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  createdAt: string;
  // Joined from session
  carOrdinal?: number;
  trackOrdinal?: number;
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
