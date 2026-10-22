import { getGame } from "@raceiq/shared/games/registry"
import { getFuelDisplaySemantic, WATTS_PER_HORSEPOWER } from "@raceiq/shared/games/telemetry"
import type { GameId } from "@raceiq/shared/games/ids";
import { semanticNumber, type SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";
import { useUnits } from "../../hooks/useUnits";
import { getSteeringLock } from "@/lib/settings-storage";
import { operatingRangeColor, severityRangeColor } from "@raceiq/scene-3d/colors";
import { m } from "../../paraglide/messages";


export function MetricsPanel({ frame, startFuel, gameId }: { frame: SemanticAnalysisFrame; startFuel?: number; gameId: GameId }) {
  const units = useUnits();
  const telemetry = getGame(gameId).telemetry;
  const speedMps = semanticNumber(frame, "motion.speed");
  const speed = speedMps == null ? null : units.speed(speedMps);
  const accel = semanticNumber(frame, "inputs.accel");
  const brake = semanticNumber(frame, "inputs.brake");
  const steer = semanticNumber(frame, "inputs.steer");
  const rpm = semanticNumber(frame, "engine.current-engine-rpm");
  const gear = semanticNumber(frame, "inputs.gear");
  const boost = semanticNumber(frame, "engine.boost");
  const power = semanticNumber(frame, "engine.power");
  const torque = semanticNumber(frame, "engine.torque");
  const fuel = semanticNumber(frame, "fuel.fuel");
  const capacity = semanticNumber(frame, "fuel.fuel-capacity") ?? undefined;
  const fuelDisplay = fuel == null ? null : getFuelDisplaySemantic(fuel, capacity, telemetry.fuel);
  const fuelUsed = startFuel != null && fuel != null ? getFuelDisplaySemantic(startFuel - fuel, capacity, telemetry.fuel) : null;
  const value = (n: number | null) => (n == null ? "—" : `${n.toFixed(0)}`);
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
      <MetricRow label={m.dataguide_speed()} value={speed == null ? "—" : `${speed.toFixed(0)} ${units.speedLabel}`} />
      <MetricRow label={m.dataguide_rpm()} value={value(rpm)} />
      <MetricRow label={m.dataguide_gear()} value={value(gear)} />
      <MetricRow label={m.dataguide_throttle()} value={accel == null ? "—" : `${((accel / 255) * 100).toFixed(0)}%`} color={accel != null && accel > 0 ? "var(--ch-throttle)" : undefined} />
      <MetricRow label={m.dataguide_brake()} value={brake == null ? "—" : `${((brake / 255) * 100).toFixed(0)}%`} color={brake != null && brake > 0 ? "var(--ch-brake)" : undefined} />
      <MetricRow label={m.dataguide_steer()} value={steer == null ? "—" : `${steer > 0 ? "+" : ""}${((steer / 127) * (getSteeringLock() / 2)).toFixed(0)}°`} />
      {telemetry.boost && <MetricRow label={m.dataguide_boost()} value={boost == null ? "—" : `${boost.toFixed(1)} psi`} />}
      {telemetry.power && <MetricRow label={m.dataguide_power()} value={power == null ? "—" : `${(power / WATTS_PER_HORSEPOWER).toFixed(0)} hp`} />}
      {telemetry.torque && <MetricRow label={m.dataguide_torque()} value={torque == null ? "—" : `${torque.toFixed(0)} Nm`} />}
      {gameId === "lmu" && ([
        ["electronics.traction-control-level", m.lmu_channel_electronics_traction_control_level()],
        ["electronics.abs-level", m.lmu_channel_electronics_abs_level()],
        ["electronics.tc-active", m.lmu_channel_electronics_tc_active()],
        ["electronics.abs-active", m.lmu_channel_electronics_abs_active()],
        ["electronics.tc-cut-level", m.lmu_channel_electronics_tc_cut_level()],
        ["electronics.motor-map", m.lmu_channel_electronics_motor_map()],
      ] as const).map(([id, label]) => {
        const raw = frame.values[id];
        const available = (frame.states[id] === undefined || frame.states[id] === "ok")
          && (frame.freshness[id] === undefined || frame.freshness[id] === "fresh");
        const shown = !available ? "—" : typeof raw === "boolean" && (id === "electronics.tc-active" || id === "electronics.abs-active")
          ? raw ? m.lmu_state_active() : m.lmu_state_inactive()
          : typeof raw === "number" && Number.isFinite(raw) ? raw.toFixed(0) : "—";
        return <MetricRow key={id} label={label} value={shown} color={available && raw === true ? "var(--status-success)" : undefined} />;
      })}
      <div className="col-span-2 flex justify-between">
        <span className="text-app-text-muted">{m.dataguide_fuel()}</span>
        <span className="tabular-nums">
          {m.analyse_fuel_summary({
            consumed: fuelUsed == null ? "?" : `${fuelUsed.amount.toFixed(1)}${fuelUsed.unit}`,
            remaining: fuelDisplay == null ? "—" : `${fuelDisplay.amount.toFixed(1)}${fuelDisplay.unit}`,
          })}
        </span>
      </div>
      {gameId === "lmu" && (
        <table className="col-span-2 mt-1 w-full border-t border-app-border text-left">
          <tbody>
            {([
              ["fuel.state-of-charge", m.lmu_channel_fuel_state_of_charge(), 1, "%"],
              ["fuel.virtual-energy", m.lmu_channel_fuel_virtual_energy(), 100, "%"],
              ["diagnostics.regen-kw", m.lmu_channel_diagnostics_regen_kw(), 1, " kW"],
            ] as const).map(([id, label, scale, suffix]) => {
              const available = (frame.states[id] === undefined || frame.states[id] === "ok")
                && (frame.freshness[id] === undefined || frame.freshness[id] === "fresh");
              const raw = available ? semanticNumber(frame, id) : null;
              return <tr key={id}>
                <th scope="row" className="pt-2 font-normal text-app-text-muted">{label}</th>
                <td className="pt-2 text-right tabular-nums text-app-text">{raw == null ? "—" : `${(raw * scale).toFixed(1)}${suffix}`}</td>
              </tr>;
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function MetricRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-app-text-muted">{label}</span>
      <span className={color ? "" : "text-app-text"} style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}
export function WearValue({ label, value }: { label: string; value: number }) {
  const health = 1 - value;
  const color = severityRangeColor(value, [0.3, 0.6]);
  return (
    <span className="text-app-text-secondary">
      {label}:{" "}
      <span className="tabular-nums" style={{ color }}>
        {(health * 100).toFixed(1)}%
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
  const speedFactor = speedMph != null ? Math.max(0.3, Math.min(1, speedMph / 80)) : 1;
  const color = severityRangeColor(Math.abs(deg), [4 / speedFactor, 8 / speedFactor, 14 / speedFactor]);
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
export function SuspValue({ label, value }: { label: string; value: number }) {
  const color = operatingRangeColor(value, [0.25, 0.65, 0.85]);
  return (
    <span className="text-app-text-secondary">
      {label}:{" "}
      <span className="tabular-nums" style={{ color }}>
        {(value * 100).toFixed(0)}%
      </span>
    </span>
  );
}
