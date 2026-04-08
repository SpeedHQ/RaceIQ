import type { TelemetryPacket, LapMeta } from "@shared/types";
import type { GameId } from "@shared/types";
import { convertTemp } from "./temperature";
import { formatLapTime } from "./format";
import { getSteeringLock } from "../components/Settings";

/** Build a CSV string from lap telemetry for download. */
export function buildExportCsv(
  telemetry: TelemetryPacket[],
  carName: string,
  trackName: string,
  selectedLap: LapMeta | undefined,
  selectedLapId: number | null,
): string {
  const header = [
    `# Car: ${carName || `Ordinal ${telemetry[0].CarOrdinal}`}`,
    `# Track: ${trackName || `Ordinal ${telemetry[0].TrackOrdinal}`}`,
    `# Lap: ${selectedLap?.lapNumber ?? "?"} | Time: ${selectedLap ? formatLapTime(selectedLap.lapTime) : "?"}`,
  ].join("\n");
  const csv = [
    header,
    Object.keys(telemetry[0]).join(","),
    ...telemetry.map((p) => Object.values(p).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lap-${selectedLapId}-telemetry.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return csv;
}

/** Build a text summary of metrics at the current cursor for clipboard copy. */
export function buildCopyMetricsText(opts: {
  currentPacket: TelemetryPacket;
  currentDisplayPacket: (TelemetryPacket & { DisplaySpeed?: number; DisplayTireTempFL?: number; DisplayTireTempFR?: number; DisplayTireTempRL?: number; DisplayTireTempRR?: number }) | null;
  cursorIdx: number;
  telemetry: TelemetryPacket[];
  totalTime: number;
  trackName: string;
  carName: string;
  selectedLap: LapMeta | undefined;
  units: {
    speedLabel: string;
    tempLabel: string;
    tempUnit: "C" | "F";
    speed: (ms: number) => number;
  };
  gameId: GameId | null | undefined;
}): string {
  const { currentPacket: p, currentDisplayPacket, cursorIdx, telemetry, totalTime, trackName, carName, selectedLap, units, gameId } = opts;
  const lock = getSteeringLock();
  const steerDeg = (p.Steer / 127) * (lock / 2);
  const startFuel = telemetry[0]?.Fuel ?? 0;
  const lines = [
    `Packet ${cursorIdx + 1}/${telemetry.length} | ${formatLapTime(p.CurrentLap)} / ${formatLapTime(totalTime)}`,
    `Track: ${trackName} | Car: ${carName} | Lap: ${selectedLap?.lapNumber ?? "?"}`,
    ``,
    `Speed: ${(currentDisplayPacket?.DisplaySpeed ?? units.speed(p.Speed)).toFixed(0)} ${units.speedLabel}`,
    `RPM: ${p.CurrentEngineRpm.toFixed(0)} / ${p.EngineMaxRpm.toFixed(0)}`,
    `Gear: ${p.Gear}`,
    `Throttle: ${((p.Accel / 255) * 100).toFixed(0)}%`,
    `Brake: ${((p.Brake / 255) * 100).toFixed(0)}%`,
    `Steer: ${steerDeg > 0 ? "+" : ""}${steerDeg.toFixed(0)}°`,
    ...(gameId === "fm-2023" || p.Boost > 0 ? [`Boost: ${p.Boost.toFixed(1)} psi`] : []),
    ...(gameId === "fm-2023" || p.Power > 0 ? [`Power: ${(p.Power / 745.7).toFixed(0)} hp`] : []),
    ...(gameId === "fm-2023" || p.Torque > 0 ? [`Torque: ${p.Torque.toFixed(0)} Nm`] : []),
    `Fuel: ${(p.Fuel * 100).toFixed(1)}% left, ${((startFuel - p.Fuel) * 100).toFixed(1)}% used`,
    ``,
    `Wheel Speed (rad/s): FL=${p.WheelRotationSpeedFL.toFixed(1)} FR=${p.WheelRotationSpeedFR.toFixed(1)} RL=${p.WheelRotationSpeedRL.toFixed(1)} RR=${p.WheelRotationSpeedRR.toFixed(1)}`,
    `Tire Temp (${units.tempLabel}): FL=${(currentDisplayPacket?.DisplayTireTempFL ?? convertTemp(p.TireTempFL, units.tempUnit, gameId === "fm-2023" ? "F" : "C")).toFixed(0)} FR=${(currentDisplayPacket?.DisplayTireTempFR ?? convertTemp(p.TireTempFR, units.tempUnit, gameId === "fm-2023" ? "F" : "C")).toFixed(0)} RL=${(currentDisplayPacket?.DisplayTireTempRL ?? convertTemp(p.TireTempRL, units.tempUnit, gameId === "fm-2023" ? "F" : "C")).toFixed(0)} RR=${(currentDisplayPacket?.DisplayTireTempRR ?? convertTemp(p.TireTempRR, units.tempUnit, gameId === "fm-2023" ? "F" : "C")).toFixed(0)}`,
    `Tire Wear: FL=${(p.TireWearFL*100).toFixed(1)}% FR=${(p.TireWearFR*100).toFixed(1)}% RL=${(p.TireWearRL*100).toFixed(1)}% RR=${(p.TireWearRR*100).toFixed(1)}%`,
    `Slip Combined: FL=${p.TireCombinedSlipFL.toFixed(2)} FR=${p.TireCombinedSlipFR.toFixed(2)} RL=${p.TireCombinedSlipRL.toFixed(2)} RR=${p.TireCombinedSlipRR.toFixed(2)}`,
    `Slip Angle: FL=${(p.TireSlipAngleFL*180/Math.PI).toFixed(1)}° FR=${(p.TireSlipAngleFR*180/Math.PI).toFixed(1)}° RL=${(p.TireSlipAngleRL*180/Math.PI).toFixed(1)}° RR=${(p.TireSlipAngleRR*180/Math.PI).toFixed(1)}°`,
    `Suspension: FL=${(p.NormSuspensionTravelFL*100).toFixed(0)}% FR=${(p.NormSuspensionTravelFR*100).toFixed(0)}% RL=${(p.NormSuspensionTravelRL*100).toFixed(0)}% RR=${(p.NormSuspensionTravelRR*100).toFixed(0)}%`,
  ];
  return lines.join("\n");
}
