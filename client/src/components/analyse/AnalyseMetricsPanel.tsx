import { getGame } from "@shared/games/registry";
import { getFuelAmount, getFuelDisplay, WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import { getSteeringLock } from "@/lib/settings-storage";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";
import { useUnits } from "../../hooks/useUnits";
import { operatingRangeColor, severityRangeColor } from "../../lib/colors";
import { m } from "../../paraglide/messages";

export function MetricsPanel({ pkt, startFuel }: { pkt: TelemetryPacket & { DisplaySpeed?: number }; startFuel?: number }) {
  const units = useUnits();
  const telemetryModel = getGame(pkt.gameId).telemetry;
  const speed = pkt.DisplaySpeed ?? units.speed(pkt.Speed);
  const throttlePct = ((pkt.Accel / 255) * 100).toFixed(0);
  const brakePct = ((pkt.Brake / 255) * 100).toFixed(0);
  const lock = getSteeringLock();
  const steerDeg = (pkt.Steer / 127) * (lock / 2);
  const fuel = getFuelDisplay(pkt, telemetryModel.fuel);
  const fuelUsed = startFuel === undefined ? null : getFuelAmount(startFuel - pkt.Fuel, telemetryModel.fuel);

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
      <MetricRow label={m.dataguide_speed()} value={`${speed.toFixed(0)} ${units.speedLabel}`} />
      <MetricRow label={m.dataguide_rpm()} value={`${pkt.CurrentEngineRpm.toFixed(0)}`} />
      <MetricRow label={m.dataguide_gear()} value={`${pkt.Gear}`} />
      <MetricRow label={m.dataguide_throttle()} value={`${throttlePct}%`} color={Number(throttlePct) > 0 ? "var(--ch-throttle)" : undefined} />
      <MetricRow label={m.dataguide_brake()} value={`${brakePct}%`} color={Number(brakePct) > 0 ? "var(--ch-brake)" : undefined} />
      <MetricRow label={m.dataguide_steer()} value={`${steerDeg > 0 ? "+" : ""}${steerDeg.toFixed(0)}°`} />
      {telemetryModel.boost && <MetricRow label={m.dataguide_boost()} value={`${pkt.Boost.toFixed(1)} psi`} />}
      {telemetryModel.power && <MetricRow label={m.dataguide_power()} value={`${(pkt.Power / WATTS_PER_HORSEPOWER).toFixed(0)} hp`} />}
      {telemetryModel.torque && <MetricRow label={m.dataguide_torque()} value={`${pkt.Torque.toFixed(0)} Nm`} />}
      <div className="col-span-2 flex justify-between">
        <span className="text-app-text-muted">{m.dataguide_fuel()}</span>
        <span className="tabular-nums">
          <span style={{ color: "var(--metric-fuel)" }}>{fuelUsed ? `${fuelUsed.amount.toFixed(1)}${fuelUsed.unit}` : "?"}</span>
          <span className="text-app-text-dim"> used </span>
          <span className="text-app-text">
            {fuel.amount.toFixed(1)}
            {fuel.unit}
          </span>
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
  const color = severityRangeColor(1 - health, [0.3, 0.6]);
  return (
    <span className="text-app-text-secondary">
      {label}:{" "}
      <span className="tabular-nums" style={{ color }}>
        {pct}%
      </span>
    </span>
  );
}

export function SlipValue({ label, value }: { label: string; value: number }) {
  const color = severityRangeColor(Math.abs(value), [0.5, 1.5]);
  return (
    <span className="text-app-text-secondary">
      {label}:{" "}
      <span className="tabular-nums" style={{ color }}>
        {value.toFixed(2)}
      </span>
    </span>
  );
}

export function SlipAngleValue({ label, value, speedMph }: { label: string; value: number; speedMph?: number }) {
  const deg = value * (180 / Math.PI);
  const a = Math.abs(deg);
  // Scale thresholds by speed — high slip angles are normal at low speed
  const speedFactor = speedMph != null ? Math.max(0.3, Math.min(1, speedMph / 80)) : 1;
  const t1 = 4 / speedFactor; // nominal -> caution: 4° at 80mph, ~13° at 25mph
  const t2 = 8 / speedFactor; // caution -> warning
  const t3 = 14 / speedFactor; // warning -> critical
  const color = severityRangeColor(a, [t1, t2, t3]);
  return (
    <span className="text-app-text-secondary">
      {label}:{" "}
      <span className="tabular-nums" style={{ color }}>
        {deg.toFixed(1)}°
      </span>
    </span>
  );
}

export function WheelSpeedValue({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-app-text-secondary">
      {label}: <span className="tabular-nums">{value.toFixed(1)}</span>
    </span>
  );
}

export function brakeBarColor(brake: number): string {
  const t = Math.min(1, Math.max(0, brake / 255));
  return `color-mix(in srgb, var(--brake-warm) ${(1 - t) * 100}%, var(--brake-hot))`;
}

export function SuspValue({ label, value }: { label: string; value: number }) {
  const pct = (value * 100).toFixed(0);
  const color = operatingRangeColor(value, [0.25, 0.65, 0.85]);
  return (
    <span className="text-app-text-secondary">
      {label}:{" "}
      <span className="tabular-nums" style={{ color }}>
        {pct}%
      </span>
    </span>
  );
}
