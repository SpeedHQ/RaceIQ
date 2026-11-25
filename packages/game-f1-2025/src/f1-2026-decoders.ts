import { decodeF1Session, type F1CarStatusData, type F1CarTelemetryData, type F1MotionData, type F1ParticipantData, type F1SessionData } from "./f1-packet-decoders";
import type { F1CarTelemetry2Data } from "@raceiq/shared/telemetry/f1-2025";

// Internal decoders: the accumulator validates exact packet sizes and player
// bounds before selecting this versioned layout. Do not call on unchecked UDP.

export function decode2026Session(data: Buffer): F1SessionData {
  return {
    ...decodeF1Session(data)!,
    pitStopWindowIdealLap: data[653], pitStopWindowLatestLap: data[654],
    sector2LapDistanceStart: data.readFloatLE(716), sector3LapDistanceStart: data.readFloatLE(720),
  };
}

/** The 2026 layout compresses g-force to signed thousandths of g. */
export function decode2026Motion(data: Buffer, index: number): F1MotionData {
  const o = index * 54;
  return {
    posX: data.readFloatLE(o), posY: data.readFloatLE(o + 4), posZ: data.readFloatLE(o + 8),
    velX: data.readFloatLE(o + 12), velY: data.readFloatLE(o + 16), velZ: data.readFloatLE(o + 20),
    gForceX: data.readInt16LE(o + 36) / 1000,
    gForceY: data.readInt16LE(o + 40) / 1000,
    gForceZ: data.readInt16LE(o + 38) / 1000,
    yaw: data.readFloatLE(o + 42), pitch: data.readFloatLE(o + 46), roll: data.readFloatLE(o + 50),
  };
}

/** Engine temperature is now u8; following pressure/surface offsets shift by 1. */
export function decode2026CarTelemetry(data: Buffer, index: number): F1CarTelemetryData {
  const o = index * 59;
  return {
    speed: data.readUInt16LE(o), throttle: data.readFloatLE(o + 2),
    steer: data.readFloatLE(o + 6), brake: data.readFloatLE(o + 10),
    clutch: data[o + 14], gear: data.readInt8(o + 15), rpm: data.readUInt16LE(o + 16), drs: data[o + 18] === 1,
    brakeTempRL: data.readUInt16LE(o + 22), brakeTempRR: data.readUInt16LE(o + 24),
    brakeTempFL: data.readUInt16LE(o + 26), brakeTempFR: data.readUInt16LE(o + 28),
    tyreTempRL: data[o + 30], tyreTempRR: data[o + 31], tyreTempFL: data[o + 32], tyreTempFR: data[o + 33],
    tyresInnerTempRL: data[o + 34], tyresInnerTempRR: data[o + 35],
    tyresInnerTempFL: data[o + 36], tyresInnerTempFR: data[o + 37], engineTemperature: data[o + 38],
    tyrePressureRL: data.readFloatLE(o + 39), tyrePressureRR: data.readFloatLE(o + 43),
    tyrePressureFL: data.readFloatLE(o + 47), tyrePressureFR: data.readFloatLE(o + 51),
    surfaceTypeRL: data[o + 55], surfaceTypeRR: data[o + 56], surfaceTypeFL: data[o + 57], surfaceTypeFR: data[o + 58],
    suggestedGear: data.readInt8(24 * 59 + 2),
  };
}

export function decode2026Participants(data: Buffer): F1ParticipantData[] {
  const count = Math.min(data[0], 24);
  return Array.from({ length: count }, (_, i) => {
    const o = 1 + i * 60;
    const bytes = data.subarray(o + 10, o + 42);
    const end = bytes.indexOf(0);
    return {
      driverId: data.readUInt16LE(o + 1), teamId: data.readUInt16LE(o + 5),
      name: bytes.subarray(0, end < 0 ? 32 : end).toString("utf8"),
    };
  });
}

export function decode2026CarStatus(data: Buffer, index: number): F1CarStatusData {
  const o = index * 59;
  return {
    tractionControl: data[o], antiLockBrakes: data[o + 1], fuelMix: data[o + 2], frontBrakeBias: data[o + 3],
    pitLimiterStatus: data[o + 4], fuelRemaining: data.readFloatLE(o + 5), fuelCapacity: data.readFloatLE(o + 9),
    fuelRemainingLaps: data.readFloatLE(o + 13), maxRPM: data.readUInt16LE(o + 17), idleRPM: data.readUInt16LE(o + 19),
    maxGears: data[o + 21], drsAllowed: data[o + 22] === 1, drsActivationDistance: data.readUInt16LE(o + 23),
    actualTyreCompound: data[o + 25], tyreCompound: data[o + 25], tyreVisualCompound: data[o + 26], tyreAge: data[o + 27],
    vehicleFIAFlags: data.readInt8(o + 28), enginePowerICE: data.readFloatLE(o + 29), enginePowerMGUK: data.readFloatLE(o + 33),
    ersStore: data.readFloatLE(o + 37), ersDeployMode: data[o + 41],
    ersHarvestedThisLap: data.readFloatLE(o + 42) + data.readFloatLE(o + 46),
    ersHarvestLimitPerLap: data.readFloatLE(o + 50), ersDeployedThisLap: data.readFloatLE(o + 54),
    allCars: Array.from({ length: 24 }, (_, i) => ({
      tyreCompound: data[i * 59 + 25], tyreVisualCompound: data[i * 59 + 26], tyreAge: data[i * 59 + 27],
    })),
  };
}

export function decode2026CarTelemetry2(data: Buffer, index: number): F1CarTelemetry2Data {
  const o = index * 10;
  return {
    activeAeroMode: data[o], activeAeroAvailable: data[o + 1] === 1,
    activeAeroActivationDistance: data.readUInt16LE(o + 2),
    overtakeAvailable: data[o + 4] === 1, overtakeActive: data[o + 5] === 1,
    overtakeActivationDistance: data.readUInt16LE(o + 6),
    regulations2026: data[o + 8] === 1, drivingWrongWay: data[o + 9] === 1,
  };
}
