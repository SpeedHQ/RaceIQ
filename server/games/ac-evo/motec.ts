import type { LdLog } from "../../motec/ld";
import type { MotecCarTrack } from "../../motec/types";
import { prepareKunosMotecCapture, MOTEC_STEER_LOCK_DEG } from "../../motec/kunos-synthesis";
import type { MotecConversionResult } from "../../motec/types";
import type { TelemetryPacket } from "../../../shared/telemetry/types";


export function convertAcEvoMotecToPackets(log: LdLog, beacons: number[], carTrack: MotecCarTrack): MotecConversionResult {
  const prepared = prepareKunosMotecCapture(log, beacons, { gameId: "ac-evo", trackOrdinal: carTrack.trackOrdinal });
  const packets = new Array<TelemetryPacket>(prepared.frameCount);
  let bestLap = 0;
  for (let i = 0; i < prepared.frameCount; i++) {
    const lap = prepared.lapIndexOf[i]!;
    const [start] = prepared.windows[lap]!;
    const lastLap = lap > 0 ? Math.round((prepared.windows[lap - 1]![1] - prepared.windows[lap - 1]![0]) * 1000) : 0;
    if (lastLap > 0 && (bestLap === 0 || lastLap < bestLap)) bestLap = lastLap;
    const speed = prepared.speedKmh[i]! / 3.6;
    const susp = prepared.suspensionTravel.map((v) => v[i]!);
    const pressure = prepared.tyrePressure.map((v) => v[i]!);
    const temp = prepared.tyreTemperature.map((v) => v[i]!);
    const brakeTemp = prepared.brakeTemperature.map((v) => v[i]!);
    const wheels = prepared.wheelSpeed.map((v) => v[i]!);
    const lapTime = Math.round((i * prepared.dt - start) * 1000);
    const packet = {
      gameId: "ac-evo", TimestampMS: Date.now(), IsRaceOn: true,
      EngineMaxRpm: 0, EngineIdleRpm: 0, CurrentEngineRpm: prepared.rpm[i]!,
      AccelerationX: prepared.lateralG[i]! * 9.81, AccelerationY: 0, AccelerationZ: prepared.longitudinalG[i]! * 9.81,
      VelocityX: prepared.path.vx[i]!, VelocityY: 0, VelocityZ: prepared.path.vz[i]!,
      AngularVelocityX: 0, AngularVelocityY: prepared.yawRate[i]!, AngularVelocityZ: 0,
      Yaw: -prepared.path.heading[i]!, Pitch: 0, Roll: 0,
      Accel: prepared.throttle[i]! * 255, Brake: prepared.brake[i]! * 255, Clutch: prepared.clutch[i]! * 255, Gear: Math.round(prepared.gear[i]!), Steer: Math.max(-127, Math.min(127, -prepared.steerDegrees[i]! / MOTEC_STEER_LOCK_DEG * 127)),
      TireSlipRatioFL: NaN, TireSlipRatioFR: NaN, TireSlipRatioRL: NaN, TireSlipRatioRR: NaN,
      WheelRotationSpeedFL: wheels[0]!, WheelRotationSpeedFR: wheels[1]!, WheelRotationSpeedRL: wheels[2]!, WheelRotationSpeedRR: wheels[3]!,
      TireTempFL: temp[0]!, TireTempFR: temp[1]!, TireTempRL: temp[2]!, TireTempRR: temp[3]!, TireCarcassTempFL: temp[0]!, TireCarcassTempFR: temp[1]!, TireCarcassTempRL: temp[2]!, TireCarcassTempRR: temp[3]!,
      Fuel: prepared.fuel[i]!, DistanceTraveled: prepared.sessionDistanceM[i]!, BestLap: bestLap / 1000, LastLap: lastLap / 1000, CurrentLap: lapTime / 1000, CurrentRaceTime: lapTime / 1000, LapNumber: lap + 1,
      CarOrdinal: carTrack.carOrdinal, TrackOrdinal: carTrack.trackOrdinal, ...(carTrack.carOrdinal < 0 ? { carModelName: carTrack.carModel } : {}), CarClass: 0, CarPerformanceIndex: 0, DrivetrainType: 1, NumCylinders: 0, PositionX: prepared.path.x[i]!, PositionY: 0, PositionZ: prepared.path.z[i]!, Speed: speed, Power: 0, Torque: 0, WeatherType: 0, TrackTemp: 0, AirTemp: 0, RainPercent: 0,
      SuspensionTravelMFL: susp[0]!, SuspensionTravelMFR: susp[1]!, SuspensionTravelMRL: susp[2]!, SuspensionTravelMRR: susp[3]!, TirePressureFrontLeft: pressure[0]!, TirePressureFrontRight: pressure[1]!, TirePressureRearLeft: pressure[2]!, TirePressureRearRight: pressure[3]!, BrakeTempFrontLeft: brakeTemp[0]!, BrakeTempFrontRight: brakeTemp[1]!, BrakeTempRearLeft: brakeTemp[2]!, BrakeTempRearRight: brakeTemp[3]!,
      acc: { tireCompound: "dry_compound", tireCoreTemp: temp, tireInnerTemp: temp, tireMiddleTemp: temp, tireOuterTemp: temp, tireCamber: [0,0,0,0], wheelLoad: [0,0,0,0], tireRadius: [0,0,0,0], tireContactHeading: [0,0,0,0], brakePadCompound: 0, brakePadWear: [-1,-1,-1,-1], tc: prepared.tc[i]!, tcCut: 0, abs: prepared.abs[i]!, absIntervention: false, tcIntervention: false, trackGripStatus: "unknown", windSpeed: 0, windDirection: 0, rainIntensity: 0, drsAvailable: false, drsEnabled: false, currentSectorIndex: -1, lastSectorTime: 0, carDamage: { front: 0, rear: 0, left: 0, right: 0, centre: 0 }, isValidLap: true, acEvo: {} },
    };
    const canonical = Object.assign({} as TelemetryPacket, packet);
    packets[i] = canonical;
  }
  return { packets, frameCount: prepared.frameCount, lapCount: prepared.windows.length, carTrack, missingChannels: prepared.missingChannels, sampleRates: log.channels.map((c) => ({ name: c.name, hz: c.effectiveFreq })), yawFromLateralG: prepared.path.yawFromLateralG };
}
