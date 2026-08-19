import { getGame } from "@shared/games/registry";
import { getFuelDisplaySemantic, WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import type { GameId } from "@shared/games/ids";
import type { SemanticAnalysisFrame } from "../track-map/types";
import { useUnits } from "../../hooks/useUnits";
import { getSteeringLock } from "@/lib/settings-storage";
import { operatingRangeColor, severityRangeColor } from "../../lib/colors";
import { controlInputPercent } from "../../lib/vehicle-dynamics";
import { m } from "../../paraglide/messages";

const number = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"]): number | null => { const value = frame.values[id];
return typeof value === "number" && Number.isFinite(value) ? value : null; }

export interface SemanticFuelValues {
  remainingVolumeL?: number;
  remainingFraction?: number;
}

export function MetricsPanel({ frame, startFuel, gameId }: { frame: SemanticAnalysisFrame; startFuel?: SemanticFuelValues; gameId: GameId }) {
  const units = useUnits();
  const telemetry = getGame(gameId).telemetry;
  const speedMps = number(frame, "motion.speed");
  const speed = speedMps == null ? null : units.speed(speedMps);
  const throttle = number(frame, "inputs.throttle");
  const brake = number(frame, "inputs.brake");
  const steering = number(frame, "inputs.steering");
  const rpm = number(frame, "engine.current-engine-rpm");
  const gear = number(frame, "inputs.gear");
  const boost = number(frame, "engine.boost");
  const power = number(frame, "engine.power");
  const torque = number(frame, "engine.torque");
  const remainingVolumeL = number(frame, "fuel.remaining-volume") ?? undefined;
  const remainingFraction = number(frame, "fuel.remaining-fraction") ?? undefined;
  const capacityL = number(frame, "fuel.capacity") ?? undefined;
  const fuelDisplay = remainingVolumeL === undefined && remainingFraction === undefined
    ? null
    : getFuelDisplaySemantic({ remainingVolumeL, remainingFraction, capacityL });
  const usedVolumeL = startFuel?.remainingVolumeL !== undefined && remainingVolumeL !== undefined
    ? startFuel.remainingVolumeL - remainingVolumeL
    : undefined;
  const usedFraction = startFuel?.remainingFraction !== undefined && remainingFraction !== undefined
    ? startFuel.remainingFraction - remainingFraction
    : undefined;
  const fuelUsed = usedVolumeL === undefined && usedFraction === undefined
    ? null
    : getFuelDisplaySemantic({ remainingVolumeL: usedVolumeL, remainingFraction: usedFraction, capacityL });
  const value = (n: number | null) => n == null ? "—" : `${n.toFixed(0)}`;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
      <MetricRow label={m.dataguide_speed()} value={speed == null ? "—" : `${speed.toFixed(0)} ${units.speedLabel}`} />
      <MetricRow label={m.dataguide_rpm()} value={value(rpm)} />
      <MetricRow label={m.dataguide_gear()} value={value(gear)} />
      <MetricRow label={m.dataguide_throttle()} value={throttle == null ? "—" : `${controlInputPercent(throttle).toFixed(0)}%`} color={throttle != null && throttle > 0 ? "var(--ch-throttle)" : undefined} />
      <MetricRow label={m.dataguide_brake()} value={brake == null ? "—" : `${controlInputPercent(brake).toFixed(0)}%`} color={brake != null && brake > 0 ? "var(--ch-brake)" : undefined} />
      <MetricRow label={m.dataguide_steer()} value={steering == null ? "—" : `${steering > 0 ? "+" : ""}${(steering * (getSteeringLock() / 2)).toFixed(0)}°`} />
      {telemetry.boost && <MetricRow label={m.dataguide_boost()} value={boost == null ? "—" : `${boost.toFixed(1)} psi`} />}
      {telemetry.power && <MetricRow label={m.dataguide_power()} value={power == null ? "—" : `${(power / WATTS_PER_HORSEPOWER).toFixed(0)} hp`} />}
      {telemetry.torque && <MetricRow label={m.dataguide_torque()} value={torque == null ? "—" : `${torque.toFixed(0)} Nm`} />}
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
export function brakeBarColor(brakeRatio: number): string { const t = Math.min(1, Math.max(0, brakeRatio)); return `color-mix(in srgb, var(--brake-warm) ${(1 - t) * 100}%, var(--brake-hot))`; }
export function SuspValue({ label, value }: { label: string; value: number }) { const color = operatingRangeColor(value, [0.25, 0.65, 0.85]); return <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{(value * 100).toFixed(0)}%</span></span>; }
