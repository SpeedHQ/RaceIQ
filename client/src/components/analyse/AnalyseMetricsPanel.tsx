import type { TelemetryPacket, GameId } from "@shared/types";
import { useUnits } from "../../hooks/useUnits";
import { getSteeringLock } from "../Settings";

export function MetricsPanel({ pkt, startFuel, gameId }: { pkt: TelemetryPacket & { DisplaySpeed?: number }; startFuel?: number; gameId?: GameId }) {
  const units = useUnits();
  const speed = pkt.DisplaySpeed ?? units.speed(pkt.Speed);
  const throttlePct = ((pkt.Accel / 255) * 100).toFixed(0);
  const brakePct = ((pkt.Brake / 255) * 100).toFixed(0);
  const lock = getSteeringLock();
  const steerDeg = (pkt.Steer / 127) * (lock / 2);

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
      <MetricRow label="Speed" value={`${speed.toFixed(0)} ${units.speedLabel}`} />
      <MetricRow label="RPM" value={`${pkt.CurrentEngineRpm.toFixed(0)}`} />
      <MetricRow label="Gear" value={`${pkt.Gear}`} />
      <MetricRow label="Throttle" value={`${throttlePct}%`} color={Number(throttlePct) > 50 ? "#34d399" : undefined} />
      <MetricRow label="Brake" value={`${brakePct}%`} color={Number(brakePct) > 10 ? "#ef4444" : undefined} />
      <MetricRow label="Steer" value={`${steerDeg > 0 ? "+" : ""}${steerDeg.toFixed(0)}°`} />
      {(gameId === "fm-2023" || pkt.Boost > 0) && <MetricRow label="Boost" value={`${pkt.Boost.toFixed(1)} psi`} />}
      {(gameId === "fm-2023" || pkt.Power > 0) && <MetricRow label="Power" value={`${(pkt.Power / 745.7).toFixed(0)} hp`} />}
      {(gameId === "fm-2023" || pkt.Torque > 0) && <MetricRow label="Torque" value={`${pkt.Torque.toFixed(0)} Nm`} />}
      <div className="col-span-2 flex justify-between">
        <span className="text-app-text-muted">Fuel</span>
        <span className="tabular-nums">
          <span className="text-amber-400">{startFuel != null ? ((startFuel - pkt.Fuel) * 100).toFixed(1) : "?"}</span>
          <span className="text-app-text-dim"> used </span>
          <span className="text-app-text">{(pkt.Fuel * 100).toFixed(1)}%</span>
          <span className="text-app-text-dim"> left</span>
        </span>
      </div>
    </div>
  );
}

export function MetricRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-app-text-muted">{label}</span>
      <span className={color ? "" : "text-app-text"} style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}

export function WearValue({ label, value }: { label: string; value: number }) {
  const health = 1 - value;
  const pct = (health * 100).toFixed(1);
  const color = health > 0.7 ? "#34d399" : health > 0.4 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{pct}%</span></span>
  );
}

export function SlipValue({ label, value }: { label: string; value: number }) {
  const color = Math.abs(value) < 0.5 ? "#34d399" : Math.abs(value) < 1.5 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{value.toFixed(2)}</span></span>
  );
}

export function SlipAngleValue({ label, value, speedMph }: { label: string; value: number; speedMph?: number }) {
  const deg = value * (180 / Math.PI);
  const a = Math.abs(deg);
  // Scale thresholds by speed — high slip angles are normal at low speed
  const speedFactor = speedMph != null ? Math.max(0.3, Math.min(1, speedMph / 80)) : 1;
  const t1 = 4 / speedFactor;  // green->yellow: 4° at 80mph, ~13° at 25mph
  const t2 = 8 / speedFactor;  // yellow->orange
  const t3 = 14 / speedFactor; // orange->red
  const color = a < t1 ? "#34d399" : a < t2 ? "#fbbf24" : a < t3 ? "#fb923c" : "#ef4444";
  return (
    <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{deg.toFixed(1)}°</span></span>
  );
}

export function WheelSpeedValue({ label, value }: { label: string; value: number }) {
  const abs = Math.abs(value);
  const color = abs < 10 ? "#94a3b8" : abs < 50 ? "#34d399" : abs < 100 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{value.toFixed(1)}</span></span>
  );
}

export function brakeBarColor(brake: number): string {
  const t = Math.min(1, Math.max(0, brake / 255));
  // Lerp from #ff9933 to #cc0000
  const r = Math.round(0xff + (0xcc - 0xff) * t);
  const g = Math.round(0x99 * (1 - t));
  const b = Math.round(0x33 * (1 - t));
  return `rgb(${r},${g},${b})`;
}

export function SuspValue({ label, value }: { label: string; value: number }) {
  const pct = (value * 100).toFixed(0);
  const color = value < 0.25 ? "#3b82f6" : value < 0.65 ? "#34d399" : value < 0.85 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{pct}%</span></span>
  );
}
