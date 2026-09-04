import type { GameId } from "../../shared/games/ids";
import type { KunosExtendedData } from "../../shared/telemetry/kunos";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { PreparedKunosMotecCapture } from "./kunos-synthesis";
import { MOTEC_STEER_LOCK_DEG } from "./kunos-synthesis";
import type { MotecCarTrack } from "./types";

type KunosGameId = Extract<GameId, "acc" | "ac-evo">;
type WheelValues = [number, number, number, number];
type ContactHeadings = KunosExtendedData["tireContactHeading"];

export interface KunosMotecPacketProfile {
  gameId: KunosGameId;
  drivetrainType: number;
  currentRaceTime: "lap" | "session";
  tireCompound: string;
  detailedTireTemperatures: boolean;
  brakePadWear: number;
  currentSectorIndex: number;
  trackGripStatus: string;
  includeUnknownCarModel: boolean;
}

const finite = (value: number): number => Number.isFinite(value) ? value : 0;
const zeroWheels = (): WheelValues => [0, 0, 0, 0];
const contactHeadings = (): ContactHeadings => [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

function wheelSample(series: Float64Array[], index: number): WheelValues {
  return [
    finite(series[0]?.[index] ?? 0),
    finite(series[1]?.[index] ?? 0),
    finite(series[2]?.[index] ?? 0),
    finite(series[3]?.[index] ?? 0),
  ];
}

function kunosExtension(
  prepared: PreparedKunosMotecCapture,
  profile: KunosMotecPacketProfile,
  index: number,
  temperatures: WheelValues,
): KunosExtendedData {
  const detailedTemperatures = profile.detailedTireTemperatures
    ? temperatures
    : zeroWheels();
  return {
    tireCompound: profile.tireCompound,
    tireCoreTemp: [...detailedTemperatures],
    tireInnerTemp: [...detailedTemperatures],
    tireMiddleTemp: [...detailedTemperatures],
    tireOuterTemp: [...detailedTemperatures],
    tireCamber: zeroWheels(),
    wheelLoad: zeroWheels(),
    tireRadius: zeroWheels(),
    tireContactHeading: contactHeadings(),
    brakePadCompound: 0,
    brakePadWear: [
      profile.brakePadWear,
      profile.brakePadWear,
      profile.brakePadWear,
      profile.brakePadWear,
    ],
    tc: finite(prepared.tc[index] ?? 0),
    tcCut: 0,
    abs: finite(prepared.abs[index] ?? 0),
    engineMap: 0,
    brakeBias: Number.NaN,
    tcIntervention: 0,
    absIntervention: 0,
    tcRaw: 0,
    absRaw: 0,
    slipVibrations: 0,
    absVibrations: 0,
    rainIntensity: 0,
    trackGripStatus: profile.trackGripStatus,
    windSpeed: 0,
    windDirection: 0,
    flagStatus: "",
    drsAvailable: false,
    drsEnabled: false,
    pitStatus: "",
    isValidLap: true,
    fuelPerLap: 0,
    currentSectorIndex: profile.currentSectorIndex,
    lastSectorTime: 0,
    carDamage: { front: 0, rear: 0, left: 0, right: 0, centre: 0 },
  };
}

export function convertPreparedKunosMotecPackets(
  prepared: PreparedKunosMotecCapture,
  carTrack: MotecCarTrack,
  profile: KunosMotecPacketProfile,
): TelemetryPacket[] {
  const packets = new Array<TelemetryPacket>(prepared.frameCount);
  let bestLapSeconds = 0;

  for (let index = 0; index < prepared.frameCount; index++) {
    const lap = prepared.lapIndexOf[index]!;
    const lapStartSeconds = prepared.windows[lap]![0];
    const lastLapSeconds = lap > 0
      ? prepared.windows[lap - 1]![1] - prepared.windows[lap - 1]![0]
      : 0;
    if (lastLapSeconds > 0 && (bestLapSeconds === 0 || lastLapSeconds < bestLapSeconds)) {
      bestLapSeconds = lastLapSeconds;
    }

    const sessionTimeSeconds = index * prepared.dt;
    const lapTimeSeconds = sessionTimeSeconds - lapStartSeconds;
    const speed = finite(prepared.speedKmh[index] ?? 0) / 3.6;
    const suspension = wheelSample(prepared.suspensionTravel, index);
    const pressure = wheelSample(prepared.tyrePressure, index);
    const temperatures = wheelSample(prepared.tyreTemperature, index);
    const brakeTemperatures = wheelSample(prepared.brakeTemperature, index);
    const wheelSpeed = wheelSample(prepared.wheelSpeed, index);
    const packet: TelemetryPacket = {
      gameId: profile.gameId,
      IsRaceOn: 1,
      TimestampMS: Date.now(),
      EngineMaxRpm: 0,
      EngineIdleRpm: 0,
      CurrentEngineRpm: finite(prepared.rpm[index] ?? 0),
      AccelerationX: finite(prepared.lateralG[index] ?? 0) * 9.80665,
      AccelerationY: 0,
      AccelerationZ: finite(prepared.longitudinalG[index] ?? 0) * 9.80665,
      VelocityX: finite(prepared.path.vx[index] ?? 0),
      VelocityY: 0,
      VelocityZ: finite(prepared.path.vz[index] ?? 0),
      AngularVelocityX: 0,
      AngularVelocityY: finite(prepared.yawRate[index] ?? 0),
      AngularVelocityZ: 0,
      Yaw: finite(-prepared.path.heading[index]!),
      Pitch: 0,
      Roll: 0,
      NormSuspensionTravelFL: 0,
      NormSuspensionTravelFR: 0,
      NormSuspensionTravelRL: 0,
      NormSuspensionTravelRR: 0,
      TireSlipRatioFL: Number.NaN,
      TireSlipRatioFR: Number.NaN,
      TireSlipRatioRL: Number.NaN,
      TireSlipRatioRR: Number.NaN,
      WheelRotationSpeedFL: wheelSpeed[0],
      WheelRotationSpeedFR: wheelSpeed[1],
      WheelRotationSpeedRL: wheelSpeed[2],
      WheelRotationSpeedRR: wheelSpeed[3],
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
      TireTempFL: temperatures[0],
      TireTempFR: temperatures[1],
      TireTempRL: temperatures[2],
      TireTempRR: temperatures[3],
      ...(profile.detailedTireTemperatures ? {
        TireCarcassTempFL: temperatures[0],
        TireCarcassTempFR: temperatures[1],
        TireCarcassTempRL: temperatures[2],
        TireCarcassTempRR: temperatures[3],
      } : {}),
      Boost: 0,
      Fuel: finite(prepared.fuel[index] ?? 0),
      DistanceTraveled: finite(prepared.sessionDistanceM[index] ?? 0),
      BestLap: bestLapSeconds,
      LastLap: lastLapSeconds,
      CurrentLap: lapTimeSeconds,
      CurrentRaceTime: profile.currentRaceTime === "session" ? sessionTimeSeconds : lapTimeSeconds,
      LapNumber: lap + 1,
      RacePosition: 1,
      Accel: Math.round(finite(prepared.throttle[index] ?? 0) * 255),
      Brake: Math.round(finite(prepared.brake[index] ?? 0) * 255),
      Clutch: Math.round(finite(prepared.clutch[index] ?? 0) * 255),
      HandBrake: 0,
      Gear: Math.round(finite(prepared.gear[index] ?? 0)),
      Steer: Math.round(Math.max(-1, Math.min(1, -finite(prepared.steerDegrees[index] ?? 0) / MOTEC_STEER_LOCK_DEG)) * 127),
      NormDrivingLine: 0,
      NormAIBrakeDiff: 0,
      TireWearFL: -1,
      TireWearFR: -1,
      TireWearRL: -1,
      TireWearRR: -1,
      SurfaceRumbleFL: 0,
      SurfaceRumbleFR: 0,
      SurfaceRumbleRL: 0,
      SurfaceRumbleRR: 0,
      TireSlipAngleFL: Number.NaN,
      TireSlipAngleFR: Number.NaN,
      TireSlipAngleRL: Number.NaN,
      TireSlipAngleRR: Number.NaN,
      TireCombinedSlipFL: Number.NaN,
      TireCombinedSlipFR: Number.NaN,
      TireCombinedSlipRL: Number.NaN,
      TireCombinedSlipRR: Number.NaN,
      SuspensionTravelMFL: suspension[0],
      SuspensionTravelMFR: suspension[1],
      SuspensionTravelMRL: suspension[2],
      SuspensionTravelMRR: suspension[3],
      CarOrdinal: carTrack.carOrdinal,
      ...(profile.includeUnknownCarModel && carTrack.carOrdinal < 0
        ? { carModelName: carTrack.carModel }
        : {}),
      CarClass: 0,
      CarPerformanceIndex: 0,
      DrivetrainType: profile.drivetrainType,
      NumCylinders: 0,
      PositionX: finite(prepared.path.x[index] ?? 0),
      PositionY: 0,
      PositionZ: finite(prepared.path.z[index] ?? 0),
      Speed: speed,
      Power: 0,
      Torque: 0,
      TrackOrdinal: carTrack.trackOrdinal,
      BrakeTempFrontLeft: brakeTemperatures[0],
      BrakeTempFrontRight: brakeTemperatures[1],
      BrakeTempRearLeft: brakeTemperatures[2],
      BrakeTempRearRight: brakeTemperatures[3],
      TirePressureFrontLeft: pressure[0],
      TirePressureFrontRight: pressure[1],
      TirePressureRearLeft: pressure[2],
      TirePressureRearRight: pressure[3],
      WeatherType: 0,
      TrackTemp: 0,
      AirTemp: 0,
      RainPercent: 0,
      acc: kunosExtension(prepared, profile, index, temperatures),
    };
    packets[index] = packet;
  }

  return packets;
}
