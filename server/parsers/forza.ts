import type { TelemetryPacket } from "../../shared/types";

/**
 * Parse a Forza Motorsport "Dash" format UDP packet.
 * Based on the official FM7/FM2023 Data Out documentation.
 * Packet is 324 bytes. All values little-endian.
 *
 * Offsets 0-231: "Sled" base data
 * Offsets 232-323: "Dash" extended data (position, speed, power, torque, temps, etc.)
 *
 * Returns null if IsRaceOn == 0.
 */
export function parseForzaPacket(buf: Buffer): TelemetryPacket | null {
  // Accept both 311 (V1 sled) and 324 (dash) byte packets, and 331 (car dash with extras)
  if (buf.length < 324) {
    return null;
  }

  const isRaceOn = buf.readInt32LE(0);
  if (isRaceOn === 0) {
    return null;
  }

  const packet: TelemetryPacket = {
    gameId: "fm-2023",
    IsRaceOn: isRaceOn,
    TimestampMS: buf.readUInt32LE(4),

    // Engine
    EngineMaxRpm: buf.readFloatLE(8),
    EngineIdleRpm: buf.readFloatLE(12),
    CurrentEngineRpm: buf.readFloatLE(16),

    // Acceleration (local space: X=right, Y=up, Z=forward)
    AccelerationX: buf.readFloatLE(20),
    AccelerationY: buf.readFloatLE(24),
    AccelerationZ: buf.readFloatLE(28),

    // Velocity (local space: X=right, Y=up, Z=forward)
    VelocityX: buf.readFloatLE(32),
    VelocityY: buf.readFloatLE(36),
    VelocityZ: buf.readFloatLE(40),

    // Angular velocity (X=pitch, Y=yaw, Z=roll)
    AngularVelocityX: buf.readFloatLE(44),
    AngularVelocityY: buf.readFloatLE(48),
    AngularVelocityZ: buf.readFloatLE(52),

    // Orientation
    Yaw: buf.readFloatLE(56),
    Pitch: buf.readFloatLE(60),
    Roll: buf.readFloatLE(64),

    // Normalized suspension travel (0=max stretch, 1=max compression)
    NormSuspensionTravelFL: buf.readFloatLE(68),
    NormSuspensionTravelFR: buf.readFloatLE(72),
    NormSuspensionTravelRL: buf.readFloatLE(76),
    NormSuspensionTravelRR: buf.readFloatLE(80),

    // Tire slip ratio (0=100% grip, >1=loss of grip)
    TireSlipRatioFL: buf.readFloatLE(84),
    TireSlipRatioFR: buf.readFloatLE(88),
    TireSlipRatioRL: buf.readFloatLE(92),
    TireSlipRatioRR: buf.readFloatLE(96),

    // Wheel rotation speed (rad/s)
    WheelRotationSpeedFL: buf.readFloatLE(100),
    WheelRotationSpeedFR: buf.readFloatLE(104),
    WheelRotationSpeedRL: buf.readFloatLE(108),
    WheelRotationSpeedRR: buf.readFloatLE(112),

    // Wheel on rumble strip (s32: 1=on, 0=off)
    WheelOnRumbleStripFL: buf.readInt32LE(116),
    WheelOnRumbleStripFR: buf.readInt32LE(120),
    WheelOnRumbleStripRL: buf.readInt32LE(124),
    WheelOnRumbleStripRR: buf.readInt32LE(128),

    // Wheel in puddle depth (0-1)
    WheelInPuddleDepthFL: buf.readFloatLE(132),
    WheelInPuddleDepthFR: buf.readFloatLE(136),
    WheelInPuddleDepthRL: buf.readFloatLE(140),
    WheelInPuddleDepthRR: buf.readFloatLE(144),

    // Surface rumble (set 2)
    SurfaceRumbleFL_2: buf.readFloatLE(148),
    SurfaceRumbleFR_2: buf.readFloatLE(152),
    SurfaceRumbleRL_2: buf.readFloatLE(156),
    SurfaceRumbleRR_2: buf.readFloatLE(160),

    // Tire slip combined (set 2)
    TireSlipCombinedFL_2: buf.readFloatLE(164),

    // Surface rumble (force feedback)
    SurfaceRumbleFL: buf.readFloatLE(148),
    SurfaceRumbleFR: buf.readFloatLE(152),
    SurfaceRumbleRL: buf.readFloatLE(156),
    SurfaceRumbleRR: buf.readFloatLE(160),

    // Tire slip angle (0=100% grip, >1=loss of grip)
    TireSlipAngleFL: buf.readFloatLE(164),
    TireSlipAngleFR: buf.readFloatLE(168),
    TireSlipAngleRL: buf.readFloatLE(172),
    TireSlipAngleRR: buf.readFloatLE(176),

    // Tire combined slip (0=100% grip, >1=loss of grip)
    TireCombinedSlipFL: buf.readFloatLE(180),
    TireCombinedSlipFR: buf.readFloatLE(184),
    TireCombinedSlipRL: buf.readFloatLE(188),
    TireCombinedSlipRR: buf.readFloatLE(192),

    // Suspension travel (meters)
    SuspensionTravelMFL: buf.readFloatLE(196),
    SuspensionTravelMFR: buf.readFloatLE(200),
    SuspensionTravelMRL: buf.readFloatLE(204),
    SuspensionTravelMRR: buf.readFloatLE(208),

    // Car info
    CarOrdinal: buf.readInt32LE(212),
    CarClass: buf.readInt32LE(216),
    CarPerformanceIndex: buf.readInt32LE(220),
    DrivetrainType: buf.readInt32LE(224),
    NumCylinders: buf.readInt32LE(228),

    // === Dash extension (offset 232+) ===

    // Position (world space)
    PositionX: buf.readFloatLE(232),
    PositionY: buf.readFloatLE(236),
    PositionZ: buf.readFloatLE(240),

    // Speed, power, torque
    Speed: buf.readFloatLE(244),
    Power: buf.readFloatLE(248),
    Torque: buf.readFloatLE(252),

    // Tire temps (Forza sends °F — kept as-is, UI handles conversion)
    TireTempFL: buf.readFloatLE(256),
    TireTempFR: buf.readFloatLE(260),
    TireTempRL: buf.readFloatLE(264),
    TireTempRR: buf.readFloatLE(268),

    // Engine/fuel
    Boost: buf.readFloatLE(272),
    Fuel: buf.readFloatLE(276),

    // Distance & lap times
    DistanceTraveled: buf.readFloatLE(280),
    BestLap: buf.readFloatLE(284),
    LastLap: buf.readFloatLE(288),
    CurrentLap: buf.readFloatLE(292),
    CurrentRaceTime: buf.readFloatLE(296),

    // Lap/position/inputs
    LapNumber: buf.readUInt16LE(300),
    RacePosition: buf.readUInt8(302),
    Accel: buf.readUInt8(303),
    Brake: buf.readUInt8(304),
    Clutch: buf.readUInt8(305),
    HandBrake: buf.readUInt8(306),
    Gear: buf.readUInt8(307),
    Steer: buf.readInt8(308),

    // Driving aids
    NormDrivingLine: buf.readInt8(309),
    NormAIBrakeDiff: buf.readInt8(310),

    // Tire wear (after Steer/NormDrivingLine/NormAIBrakeDiff at offset 308-310)
    // Offsets: 311, 315, 319, 323
    TireWearFL: buf.length >= 331 ? buf.readFloatLE(311) : -1,
    TireWearFR: buf.length >= 331 ? buf.readFloatLE(315) : -1,
    TireWearRL: buf.length >= 331 ? buf.readFloatLE(319) : -1,
    TireWearRR: buf.length >= 331 ? buf.readFloatLE(323) : -1,

    // Track ordinal (offset 327)
    TrackOrdinal: buf.length >= 331 ? buf.readInt32LE(327) : 0,
  };

  return packet;
}
