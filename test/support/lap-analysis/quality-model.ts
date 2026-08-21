import { DEFAULT_LAP_CLASSIFICATION } from "../../../shared/racing/laps/classification";
import { LOCAL_PLAYER_EVIDENCE, type LapQualitySummary } from "../../../shared/racing/quality/contracts";
import { summarizeLapQuality } from "../../../shared/racing/quality/measure";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { TelemetryVersionIdentity } from "../../../shared/telemetry/version";
import { packet } from "../telemetry/resolver";

export const TEST_VERSION_IDENTITY: TelemetryVersionIdentity = {
  catalogVersion: "test-catalog",
  catalogHash: "test-hash",
  catalogSchemaVersion: "test-schema",
  parserVersion: "test-parser",
  resolverVersion: "test-resolver",
  derivationVersion: "test-derivation",
};

export function qualityPackets(count: number, skippedTicks: readonly number[] = []): TelemetryPacket[] {
  const skipped = new Set(skippedTicks);
  const maximumTick = count + skippedTicks.length - 1;
  const packets: TelemetryPacket[] = [];
  for (let tick = 0; tick <= maximumTick; tick += 1) {
    if (skipped.has(tick)) continue;
    const fraction = maximumTick > 0 ? tick / maximumTick : 0;
    packets.push(
      packet("iracing", {
        TimestampMS: tick * 50,
        DistanceTraveled: fraction * 5_000,
        CurrentLap: fraction * 10,
        LastLap: 10,
        PositionX: 100 + fraction * 5,
        PositionZ: 200 + fraction * 5,
        Speed: 50,
        Accel: 180,
        Brake: 0,
        Steer: 0,
        Fuel: 50 - fraction,
        TireTempFL: 80,
        TireTempFR: 80,
        TireTempRL: 80,
        TireTempRR: 80,
        TireWearFL: 0.9,
        TireWearFR: 0.9,
        TireWearRL: 0.9,
        TireWearRR: 0.9,
        TirePressureFrontLeft: 27,
        TirePressureFrontRight: 27,
        TirePressureRearLeft: 27,
        TirePressureRearRight: 27,
        TireSlipRatioFL: 0.01,
        TireSlipRatioFR: 0.01,
        TireSlipRatioRL: 0.01,
        TireSlipRatioRR: 0.01,
        TireSlipAngleFL: 0.01,
        TireSlipAngleFR: 0.01,
        TireSlipAngleRL: 0.01,
        TireSlipAngleRR: 0.01,
        WheelRotationSpeedFL: 100,
        WheelRotationSpeedFR: 100,
        WheelRotationSpeedRL: 100,
        WheelRotationSpeedRR: 100,
        NormSuspensionTravelFL: 0.5,
        NormSuspensionTravelFR: 0.5,
        NormSuspensionTravelRL: 0.5,
        NormSuspensionTravelRR: 0.5,
        iracing: {
          sessionTick: tick,
          sessionNum: 0,
          driverCarIdx: 1,
          trackLengthM: 5_000,
          lapDistanceM: fraction * 5_000,
          lapDistancePct: fraction,
          onPitRoad: false,
          playerTrackSurface: 3,
          incidents: 0,
          trackWetness: 0,
          carName: "Test car",
          carClassName: "Test class",
          trackName: "Test track",
        },
      }),
    );
  }
  return packets;
}

export function summarize(packets: readonly TelemetryPacket[], overrides: Partial<Parameters<typeof summarizeLapQuality>[0]> = {}): LapQualitySummary {
  return summarizeLapQuality({
    packets,
    lapTime: 10,
    timingSource: "simulator-history",
    complete: true,
    structurallyValid: true,
    invalidReason: null,
    classification: DEFAULT_LAP_CLASSIFICATION,
    sourceKind: "native-live",
    participant: LOCAL_PLAYER_EVIDENCE,
    versionIdentity: TEST_VERSION_IDENTITY,
    ...overrides,
  });
}
