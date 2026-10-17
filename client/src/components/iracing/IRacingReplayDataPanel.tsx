import type { TelemetryVariableId } from "@raceiq/shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { SemanticAnalysisFrame } from "../analyse/track-map/types";
import { formatLapTime } from "@/lib/format";
import { controlInputPercent } from "@/lib/vehicle-dynamics";
import { m } from "@/paraglide/messages";
import { WheelTable } from "../analyse/WheelTable";

interface ReplayUnits {
  speed(value: number): number;
  speedLabel: string;
  temp(value: number): number;
  tempLabel: string;
}
interface Row { label: string; value: string | null }
function usable(frame: SemanticAnalysisFrame, id: TelemetryVariableId, snapshot = false): boolean {
  const state = frame.states[id];
  return (state === undefined || state === "ok" || (snapshot && state === "stale")) && (snapshot || frame.freshness[id] !== "stale");
}
function number(frame: SemanticAnalysisFrame, id: TelemetryVariableId): number | null {
  const value = frame.values[id];
  return usable(frame, id) && typeof value === "number" && Number.isFinite(value) ? value : null;
}
function wheels(frame: SemanticAnalysisFrame, id: TelemetryVariableId, snapshot = false): readonly number[] | null {
  const value = frame.values[id];
  return usable(frame, id, snapshot) && Array.isArray(value) && value.length === 4 && value.every(item => typeof item === "number" && Number.isFinite(item)) ? value : null;
}
function Group({ title, rows }: { title: string; rows: readonly Row[] }) {
  const visible = rows.filter(row => row.value !== null);
  if (!visible.length) return null;
  return <section className="rounded-lg border border-app-border bg-app-surface/40 p-3">
    <h3 className="mb-3 text-xs font-semibold text-app-text-secondary">{title}</h3>
    <dl className="space-y-2">{visible.map(row => <div key={row.label} className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="min-w-0 text-app-text-muted">{row.label}</dt><dd className="shrink-0 font-mono tabular-nums text-app-text">{row.value}</dd>
    </div>)}</dl>
  </section>;
}
function InputMeter({ label, value, color }: { label: string; value: number | null; color: string }) {
  if (value === null) return null;
  const percent = controlInputPercent(value);
  return <div className="space-y-1">
    <div className="flex justify-between text-xs"><span className="text-app-text-muted">{label}</span><span className="font-mono tabular-nums text-app-text">{percent.toFixed(0)}%</span></div>
    <div className="h-1.5 overflow-hidden rounded-full bg-app-border"><div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: color }} /></div>
  </div>;
}

/** Recorded channels only. Pit snapshots are deliberately separate from cursor telemetry. */
export function IRacingReplayDataPanel({ frame, startFuel, units }: { frame: SemanticAnalysisFrame; startFuel?: number; units: ReplayUnits }) {
  const read = (id: TelemetryVariableId) => number(frame, id);
  const formatted = (id: TelemetryVariableId, format: (value: number) => string) => { const value = read(id); return value === null ? null : format(value); };
  const fixed = (digits: number, unit: string) => (value: number) => `${value.toFixed(digits)} ${unit}`;
  const temperature = (value: number) => `${units.temp(value).toFixed(1)}${units.tempLabel}`;
  const angle = (value: number) => `${(value * 180 / Math.PI).toFixed(1)}°`;
  const speed = read("motion.speed"), rpm = read("engine.current-engine-rpm"), gear = read("inputs.gear");
  const throttle = read("inputs.accel"), brake = read("inputs.brake"), clutch = read("inputs.clutch");
  const fuel = read("fuel.fuel");
  const fuelUsed = startFuel !== undefined && Number.isFinite(startFuel) && fuel !== null && startFuel >= fuel ? startFuel - fuel : null;
  const onPitRoad = usable(frame, "race.on-pit-road") && typeof frame.values["race.on-pit-road"] === "boolean" ? frame.values["race.on-pit-road"] as boolean : null;
  const surface = read("identity.player-track-surface");
  const surfaceText = surface === -1 ? m.analyse_surface_not_in_world() : surface === 0 ? m.analyse_surface_off_track() : surface === 1 ? m.analyse_surface_pit_stall() : surface === 2 ? m.analyse_surface_approaching_pits() : surface === 3 ? m.analyse_surface_on_track() : null;
  const counter = read("race.player-incident-count");
  const engineRows: Row[] = [
    { label: m.iracing_live_fuel_remaining(), value: fuel === null ? null : `${fuel.toFixed(1)} L` },
    { label: m.iracing_replay_fuel_used(), value: fuelUsed === null ? null : `${fuelUsed.toFixed(2)} L` },
    { label: m.iracing_replay_coolant(), value: formatted("engine.coolant-temperature", temperature) },
    { label: m.iracing_replay_oil_temp(), value: formatted("engine.oil-temperature", temperature) },
    { label: m.iracing_replay_oil_pressure(), value: formatted("engine.oil-pressure", fixed(2, "bar")) },
    { label: m.iracing_replay_fuel_pressure(), value: formatted("fuel.fuel-press", fixed(2, "bar")) },
    { label: m.iracing_replay_voltage(), value: formatted("engine.voltage", fixed(1, "V")) },
  ];
  const motionRows: Row[] = [
    { label: m.iracing_live_lateral_g(), value: formatted("motion.acceleration-x", value => `${(value / 9.80665).toFixed(2)} g`) },
    { label: m.iracing_live_longitudinal_g(), value: formatted("motion.acceleration-z", value => `${(value / 9.80665).toFixed(2)} g`) },
    { label: m.iracing_replay_yaw_rate(), value: formatted("motion.angular-velocity-y", fixed(2, "rad/s")) },
    { label: m.iracing_live_roll(), value: formatted("motion.roll", angle) },
    { label: m.iracing_live_pitch(), value: formatted("motion.pitch", angle) },
  ];
  const sessionRows: Row[] = [
    { label: m.iracing_replay_session_time(), value: formatted("timing.current-race-time", value => value < 0 ? "—" : value === 0 ? "0:00.000" : formatLapTime(value)) },
    { label: m.iracing_live_lap_progress(), value: formatted("timing.lap-fraction", value => `${(value * 100).toFixed(1)}%`) },
    { label: m.iracing_replay_personal_counter(), value: counter !== null && counter >= 0 && Number.isInteger(counter) ? String(counter) : null },
    { label: m.label_surface(), value: surfaceText },
    { label: m.iracing_replay_pit_road(), value: onPitRoad === null ? null : onPitRoad ? m.common_yes() : m.common_no() },
  ];
  const conditionRows: Row[] = [
    { label: m.analyse_air(), value: formatted("weather.air-temp", temperature) },
    { label: m.analyse_track(), value: formatted("weather.track-temp", temperature) },
    { label: m.iracing_replay_wind(), value: formatted("weather.wind-vel", value => `${units.speed(value).toFixed(1)} ${units.speedLabel}`) },
    { label: m.iracing_replay_wind_direction(), value: formatted("weather.wind-dir", angle) },
    { label: m.iracing_replay_humidity(), value: formatted("weather.relative-humidity", fixed(1, "%")) },
  ];
  const travel = wheels(frame, "suspension.suspension-travel-m");
  const velocity = wheels(frame, "suspension.shock-vel");
  const pressure = wheels(frame, "brakes.brake-line-press");
  const wheelRow = (label: string, values: readonly number[], format: (value: number) => string) => ({ label, fl: format(values[0]), fr: format(values[1]), rl: format(values[2]), rr: format(values[3]) });
  const wheelRows = [
    ...(travel ? [wheelRow(`${m.dataguide_travel()} (mm)`, travel, value => (value * 1000).toFixed(0))] : []),
    ...(velocity ? [wheelRow(`${m.iracing_replay_shock_velocity()} (m/s)`, velocity, value => value.toFixed(2))] : []),
    ...(pressure ? [wheelRow(`${m.iracing_replay_brake_line_pressure()} (bar)`, pressure, value => value.toFixed(1))] : []),
  ];
  const pitTemps = wheels(frame, "tire.temperature.carcass.middle", true);
  const pitWear = wheels(frame, "tires.tire-wear", true);
  const coldPressure = wheels(frame, "tires.tire-pressure", true);
  const snapshotRows = [
    ...(pitTemps && pitTemps.every(value => value > 0) ? [wheelRow(`${m.analyse_wheels_pit_temp()} (${units.tempLabel})`, pitTemps, value => units.temp(value).toFixed(0))] : []),
    ...(pitWear && pitWear.every(value => value >= 0 && value <= 1) ? [wheelRow(`${m.analyse_wheels_pit_health()} (%)`, pitWear, value => ((1 - value) * 100).toFixed(1))] : []),
    ...(coldPressure && coldPressure.every(value => value > 0) ? [wheelRow(`${m.analyse_wheels_cold_pressure()} (psi)`, coldPressure, value => value.toFixed(1))] : []),
  ];
  const hasData = [speed, rpm, gear, throttle, brake, clutch].some(value => value !== null) || [...engineRows, ...motionRows, ...sessionRows, ...conditionRows].some(row => row.value !== null) || wheelRows.length > 0 || snapshotRows.length > 0;
  return <div data-iracing-replay-data className="space-y-3">
    <p className="text-xs leading-relaxed text-app-text-muted">{m.iracing_replay_source_note()}</p>
    {!hasData && <p className="text-sm text-app-text-muted">{m.iracing_replay_empty()}</p>}
    {(speed !== null || rpm !== null || gear !== null) && <dl className="grid grid-cols-3 gap-2">
      {[
        { label: m.dataguide_speed(), value: speed === null ? null : units.speed(speed).toFixed(0), unit: units.speedLabel },
        { label: m.dataguide_rpm(), value: rpm === null ? null : rpm.toFixed(0), unit: "rpm" },
        { label: m.dataguide_gear(), value: gear === null ? null : gear === 0 ? "R" : gear === 11 ? "N" : String(gear), unit: "" },
      ].filter(metric => metric.value !== null).map(metric => <div key={metric.label} className="min-w-0 rounded-lg border border-app-border bg-app-surface/60 p-2.5">
        <dt className="text-app-caption text-app-text-muted">{metric.label}</dt><dd className="mt-1 font-mono text-xl font-semibold tabular-nums text-app-text">{metric.value}<span className="ml-1 text-app-caption font-normal text-app-text-muted">{metric.unit}</span></dd>
      </div>)}
    </dl>}
    {(throttle !== null || brake !== null || clutch !== null || read("inputs.steer") !== null || read("inputs.steering-wheel-torque") !== null) && <section className="space-y-2.5 rounded-lg border border-app-border bg-app-surface/40 p-3">
      <h3 className="text-xs font-semibold text-app-text-secondary">{m.iracing_live_inputs()}</h3>
      <InputMeter label={m.chart_throttle()} value={throttle} color="var(--ch-throttle)" />
      <InputMeter label={m.chart_brake()} value={brake} color="var(--ch-brake)" />
      <InputMeter label={m.streaming_clutch()} value={clutch} color="var(--app-accent)" />
      {read("inputs.steer") !== null && <div className="flex justify-between text-xs"><span className="text-app-text-muted">{m.analyse_chart_steering()}</span><span className="font-mono tabular-nums text-app-text">{(read("inputs.steer")! / 127 * 100).toFixed(0)}%</span></div>}
      {read("inputs.steering-wheel-torque") !== null && <div className="flex justify-between gap-2 text-xs"><span className="text-app-text-muted">{m.iracing_replay_steering_torque()}</span><span className="shrink-0 font-mono tabular-nums text-app-text">{read("inputs.steering-wheel-torque")!.toFixed(2)} N·m</span></div>}
    </section>}
    <Group title={`${m.label_engine()} · ${m.label_fuel()}`} rows={engineRows} />
    <Group title={m.iracing_live_motion()} rows={motionRows} />
    {wheelRows.length > 0 && <section className="rounded-lg border border-app-border bg-app-surface/40 p-3"><WheelTable title={m.dataguide_suspension()} rows={wheelRows} /></section>}
    <Group title={m.iracing_replay_session()} rows={sessionRows} />
    <Group title={m.iracing_replay_conditions()} rows={conditionRows} />
    {snapshotRows.length > 0 && <details className="rounded-lg border border-app-border bg-app-surface/30 p-3">
      <summary className="cursor-pointer rounded text-xs font-medium text-app-text-secondary focus-visible:outline-2 focus-visible:outline-app-accent">{m.iracing_replay_pit_snapshots()}</summary>
      <p className="my-3 text-xs leading-relaxed text-app-text-muted">{m.iracing_live_snapshot_note()}</p>
      <WheelTable rows={snapshotRows} />
    </details>}
  </div>;
}
