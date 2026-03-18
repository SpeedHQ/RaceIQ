import type { TelemetryPacket } from "../shared/types";

const PACKET_LENGTH = 331;

/**
 * Parse a 331-byte Forza Car Dash binary packet into a structured object.
 * Returns null if packet is wrong length or IsRaceOn == 0.
 * All values are little-endian.
 */
export function parsePacket(buf: Buffer): TelemetryPacket | null {
  if (buf.length !== PACKET_LENGTH) {
    return null;
  }

  const isRaceOn = buf.readInt32LE(0);
  if (isRaceOn === 0) {
    return null;
  }

  const packet: TelemetryPacket = {
    IsRaceOn: isRaceOn,
    TimestampMS: buf.readUInt32LE(4),

    EngineMaxRpm: buf.readFloatLE(8),
    EngineIdleRpm: buf.readFloatLE(12),
    CurrentEngineRpm: buf.readFloatLE(16),

    AccelerationX: buf.readFloatLE(20),
    AccelerationY: buf.readFloatLE(24),
    AccelerationZ: buf.readFloatLE(28),

    VelocityX: buf.readFloatLE(32),
    VelocityY: buf.readFloatLE(36),
    VelocityZ: buf.readFloatLE(40),

    AngularVelocityX: buf.readFloatLE(44),
    AngularVelocityY: buf.readFloatLE(48),
    AngularVelocityZ: buf.readFloatLE(52),

    Yaw: buf.readFloatLE(56),
    Pitch: buf.readFloatLE(60),
    Roll: buf.readFloatLE(64),

    NormSuspensionTravelFL: buf.readFloatLE(68),
    NormSuspensionTravelFR: buf.readFloatLE(72),
    NormSuspensionTravelRL: buf.readFloatLE(76),
    NormSuspensionTravelRR: buf.readFloatLE(80),

    TireSlipRatioFL: buf.readFloatLE(84),
    TireSlipRatioFR: buf.readFloatLE(88),
    TireSlipRatioRL: buf.readFloatLE(92),
    TireSlipRatioRR: buf.readFloatLE(96),

    WheelRotationSpeedFL: buf.readFloatLE(100),
    WheelRotationSpeedFR: buf.readFloatLE(104),
    WheelRotationSpeedRL: buf.readFloatLE(108),
    WheelRotationSpeedRR: buf.readFloatLE(112),

    WheelOnRumbleStripFL: buf.readFloatLE(116),
    WheelOnRumbleStripFR: buf.readFloatLE(120),
    WheelOnRumbleStripRL: buf.readFloatLE(124),
    WheelOnRumbleStripRR: buf.readFloatLE(128),

    WheelInPuddleDepthFL: buf.readFloatLE(132),
    WheelInPuddleDepthFR: buf.readFloatLE(136),
    WheelInPuddleDepthRL: buf.readFloatLE(140),
    WheelInPuddleDepthRR: buf.readFloatLE(144),

    SurfaceRumbleFL_2: buf.readFloatLE(148),
    SurfaceRumbleFR_2: buf.readFloatLE(152),
    SurfaceRumbleRL_2: buf.readFloatLE(156),
    SurfaceRumbleRR_2: buf.readFloatLE(160),

    TireSlipCombinedFL_2: buf.readFloatLE(164),

    TireTempFL: buf.readFloatLE(168),
    TireTempFR: buf.readFloatLE(172),
    TireTempRL: buf.readFloatLE(176),
    TireTempRR: buf.readFloatLE(180),

    Boost: buf.readFloatLE(184),
    Fuel: buf.readFloatLE(188),

    DistanceTraveled: buf.readFloatLE(192),
    BestLap: buf.readFloatLE(196),
    LastLap: buf.readFloatLE(200),
    CurrentLap: buf.readFloatLE(204),
    CurrentRaceTime: buf.readFloatLE(208),

    LapNumber: buf.readUInt16LE(212),
    RacePosition: buf.readUInt8(214),

    Accel: buf.readUInt8(215),
    Brake: buf.readUInt8(216),
    Clutch: buf.readUInt8(217),
    HandBrake: buf.readUInt8(218),
    Gear: buf.readUInt8(219),
    Steer: buf.readUInt8(220),

    NormDrivingLine: buf.readInt8(221),
    NormAIBrakeDiff: buf.readInt8(222),

    TireWearFL: buf.readFloatLE(224),
    TireWearFR: buf.readFloatLE(228),
    TireWearRL: buf.readFloatLE(232),
    TireWearRR: buf.readFloatLE(236),

    SurfaceRumbleFL: buf.readInt32LE(240),
    SurfaceRumbleFR: buf.readInt32LE(244),
    SurfaceRumbleRL: buf.readInt32LE(248),
    SurfaceRumbleRR: buf.readInt32LE(252),

    TireSlipAngleFL: buf.readFloatLE(256),
    TireSlipAngleFR: buf.readFloatLE(260),
    TireSlipAngleRL: buf.readFloatLE(264),
    TireSlipAngleRR: buf.readFloatLE(268),

    TireCombinedSlipFL: buf.readFloatLE(272),
    TireCombinedSlipFR: buf.readFloatLE(276),
    TireCombinedSlipRL: buf.readFloatLE(280),
    TireCombinedSlipRR: buf.readFloatLE(284),

    SuspensionTravelMetersFL: buf.readFloatLE(288),
    SuspensionTravelMetersFR: buf.readFloatLE(292),
    SuspensionTravelMetersRL: buf.readFloatLE(296),
    SuspensionTravelMetersRR: buf.readFloatLE(300),

    CarOrdinal: buf.readInt32LE(304),
    CarClass: buf.readInt32LE(308),
    CarPerformanceIndex: buf.readInt32LE(312),
    DrivetrainType: buf.readInt32LE(316),
    NumCylinders: buf.readInt32LE(320),
    CarCategory: buf.readInt32LE(324),

    Unknown1: buf.readUInt8(328),
    Unknown2: buf.readUInt8(329),
    Unknown3: buf.readUInt8(330),
  };

  return packet;
}
