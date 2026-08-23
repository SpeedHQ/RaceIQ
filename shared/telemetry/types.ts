import type { GameId } from "../games/ids";
import type { F1ExtendedData } from "./f1-2025";
import type { KunosExtendedData } from "./kunos";
import type { IRacingExtendedData } from "./iracing";
import type { LMUExtendedData } from "./lmu";

export interface TelemetryPacket {
  gameId: GameId;
  f1?: F1ExtendedData;
  acc?: KunosExtendedData;
  iracing?: IRacingExtendedData;
  lmu?: LMUExtendedData;

  // Game session UID (used for reliable session boundary detection)
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

  // Common representative tire temperature. Unit comes from game adapter.
  TireTempFL: number;
  TireTempFR: number;
  TireTempRL: number;
  TireTempRR: number;

  // Detailed tire temperatures (°C). Optional when source lacks this fidelity.
  TireCarcassTempFL?: number;
  TireCarcassTempFR?: number;
  TireCarcassTempRL?: number;
  TireCarcassTempRR?: number;
  TireCarcassTempLeftFL?: number;
  TireCarcassTempLeftFR?: number;
  TireCarcassTempLeftRL?: number;
  TireCarcassTempLeftRR?: number;
  TireCarcassTempMiddleFL?: number;
  TireCarcassTempMiddleFR?: number;
  TireCarcassTempMiddleRL?: number;
  TireCarcassTempMiddleRR?: number;
  TireCarcassTempRightFL?: number;
  TireCarcassTempRightFR?: number;
  TireCarcassTempRightRL?: number;
  TireCarcassTempRightRR?: number;
  TireSurfaceTempInnerFL?: number;
  TireSurfaceTempInnerFR?: number;
  TireSurfaceTempInnerRL?: number;
  TireSurfaceTempInnerRR?: number;
  TireSurfaceTempMiddleFL?: number;
  TireSurfaceTempMiddleFR?: number;
  TireSurfaceTempMiddleRL?: number;
  TireSurfaceTempMiddleRR?: number;
  TireSurfaceTempOuterFL?: number;
  TireSurfaceTempOuterFR?: number;
  TireSurfaceTempOuterRL?: number;
  TireSurfaceTempOuterRR?: number;

  // Engine/fuel
  Boost: number;
  Fuel: number;
  /** Source-provided tank capacity in litres, when available. */
  FuelCapacity?: number;

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
