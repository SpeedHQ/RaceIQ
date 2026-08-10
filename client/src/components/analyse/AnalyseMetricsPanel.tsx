import { getGame } from "@shared/games/registry";
import { getFuelDisplaySemantic, WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import type { GameId } from "@shared/games/ids";
import type { SemanticAnalysisFrame } from "./track-map/types";
import { useUnits } from "../../hooks/useUnits";
import { getSteeringLock } from "@/lib/settings-storage";
import { operatingRangeColor, severityRangeColor } from "../../lib/colors";
import { m } from "../../paraglide/messages";

const number = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"]): number | null => { const value = frame.values[id];
return typeof value === "number" && Number.isFinite(value) ? value : null; }

export function MetricsPanel({ frame, startFuel, gameId }: { frame: SemanticAnalysisFrame; startFuel?: number; gameId: GameId }) {
  const units = useUnits();
  const telemetry = getGame(gameId).telemetry;
  const speedMps = number(frame, "motion.speed");
  const speed = speedMps == null ? null : units.speed(speedMps);
  const accel = number(frame, "inputs.accel");
  const brake = number(frame, "inputs.brake");
  const steer = number(frame, "inputs.steer");
  const rpm = number(frame, "engine.current-engine-rpm");
  const gear = number(frame, "inputs.gear");
  const boost = number(frame, "engine.boost");
  const power = number(frame, "engine.power");
  const torque = number(frame, "engine.torque");
  const fuel = number(frame, "fuel.fuel");
  const capacity = number(frame, "fuel.fuel-capacity") ?? undefined;
  const fuelDisplay = fuel == null ? null : getFuelDisplaySemantic(fuel, capacity, telemetry.fuel);
  const fuelUsed = startFuel != null && fuel != null ? getFuelDisplaySemantic(Math.max(0, startFuel - fuel), capacity, telemetry.fuel) : null;
  const value = (n: number | null) => n == null ? "—" : `${n.toFixed(0)}`;
  const wheels = (id: string) => {
    const values = frame.values[id];
    return Array.isArray(values) ? values.map((value) => typeof value === "number" && Number.isFinite(value) ? value : null) : [];
  };
  const suspension = wheels("suspension.suspension-travel-m");
  const suspensionDisplay = telemetry.analysis?.suspensionTravel;
  const lateralSlip = wheels("tires.normalized-tire-slip-angle");
  const combinedSlip = wheels("tires.tire-combined-slip");
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
      <MetricRow label={m.dataguide_speed()} value={speed == null ? "—" : `${speed.toFixed(0)} ${units.speedLabel}`} />
      <MetricRow label={m.dataguide_rpm()} value={value(rpm)} />
      <MetricRow label={m.dataguide_gear()} value={value(gear)} />
      <MetricRow label={m.dataguide_throttle()} value={accel == null ? "—" : `${((accel / 255) * 100).toFixed(0)}%`} color={accel != null && accel > 0 ? "var(--ch-throttle)" : undefined} />
      <MetricRow label={m.dataguide_steer()} value={steer == null ? "—" : `${steer > 0 ? "+" : ""}${((steer / 127) * (getSteeringLock() / 2)).toFixed(0)}°`} />
      <MetricRow label={m.dataguide_brake()} value={brake == null ? "—" : `${((brake / 255) * 100).toFixed(0)}%`} color={brake != null && brake > 0 ? "var(--ch-brake)" : undefined} />
      {gameId === "fm-2023" && <MetricRow label="Lateral slip" value={lateralSlip.length === 4 && lateralSlip.every((value) => value != null) ? lateralSlip.map((value) => value!.toFixed(3)).join(" / ") : "—"} />}
      {gameId === "fm-2023" && <MetricRow label="Grip Ask" value={combinedSlip.length === 4 && combinedSlip.every((value) => value != null) ? combinedSlip.map((value) => `${(value! * 100).toFixed(0)}%`).join(" / ") : "—"} />}
      {telemetry.boost && boost != null && <MetricRow label={m.dataguide_boost()} value={`${boost.toFixed(1)} psi`} />}
      {telemetry.power && power != null && <MetricRow label={m.dataguide_power()} value={`${(power / WATTS_PER_HORSEPOWER).toFixed(0)} hp`} />}
      {suspensionDisplay?.source !== "unavailable" && <MetricRow label={m.dataguide_suspension()} value={suspension.every((value) => value != null) ? suspension.map((value) => suspensionDisplay?.display === "millimeters" ? `${(value! * 1000).toFixed(2)}mm` : `${(value! * 100).toFixed(0)}%`).join(" / ") : "—"} />}
      {telemetry.torque && torque != null && <MetricRow label={m.dataguide_torque()} value={`${torque.toFixed(0)} Nm`} />}
      <div className="col-span-2 flex justify-between">
        <span className="text-app-text-muted">{m.dataguide_fuel()}</span>
        <span className="tabular-nums">
          <span style={{ color: "var(--metric-fuel)" }}>{fuelUsed == null ? "?" : `${fuelUsed.amount.toFixed(1)}${fuelUsed.unit}`}</span>
          <span className="text-app-text-dim"> used </span>
          <span className="text-app-text">{fuelDisplay == null ? "—" : `${fuelDisplay.amount.toFixed(1)}${fuelDisplay.unit}`}</span>
          <span className="text-app-text-dim"> left</span>
        </span>
      </div>
    </div>
  );
}

export function MetricRow({ label, value, color }: { label: string; value: string; color?: string }) { return <div className="flex justify-between"><span className="text-app-text-muted">{label}</span><span className={color ? "" : "text-app-text"} style={color ? { color } : undefined}>{value}</span></div>; }
export function WearValue({ label, value }: { label: string; value: number }) { const health = 1 - value; const color = severityRangeColor(value, [0.3, 0.6]); return <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{(health * 100).toFixed(1)}%</span></span>; }
export function SlipValue({ label, value }: { label: string; value: number }) { const color = severityRangeColor(Math.abs(value), [0.5, 1.5]); return <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{value.toFixed(2)}</span></span>; }
export function SlipAngleValue({ label, value, speedMph }: { label: string; value: number; speedMph?: number }) { const deg = value * (180 / Math.PI); const speedFactor = speedMph != null ? Math.max(0.3, Math.min(1, speedMph / 80)) : 1; const color = severityRangeColor(Math.abs(deg), [4 / speedFactor, 8 / speedFactor, 14 / speedFactor]); return <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{deg.toFixed(1)}°</span></span>; }
export function WheelSpeedValue({ label, value }: { label: string; value: number }) { return <span className="text-app-text-secondary">{label}: <span className="tabular-nums">{value.toFixed(1)}</span></span>; }
export function brakeBarColor(brake: number): string { const t = Math.min(1, Math.max(0, brake / 255)); return `color-mix(in srgb, var(--brake-warm) ${(1 - t) * 100}%, var(--brake-hot))`; }
export function SuspValue({ label, value }: { label: string; value: number }) { const color = operatingRangeColor(value, [0.25, 0.65, 0.85]); return <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{(value * 100).toFixed(0)}%</span></span>; }
