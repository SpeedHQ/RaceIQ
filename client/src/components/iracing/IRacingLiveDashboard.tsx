import { m } from "@/paraglide/messages";
import { useCarName } from "../../hooks/catalog-queries";
import { useTrackName } from "../../hooks/track-queries";
import { formatLapTime } from "../../lib/format";
import { controlInputPercent } from "../../lib/vehicle-dynamics";
import { useUnits } from "../../hooks/useUnits";
import { useTelemetryStore } from "../../stores/telemetry";
import { SectorTimes } from "../SectorTimes";
import { getGame } from "@raceiq/shared/games/registry";
import { getFuelAmount } from "@raceiq/shared/games/telemetry";

function Metric({ label, value, unit, prominent = false }: { label: string; value: string; unit?: string; prominent?: boolean }) {
  return <div className="flex min-w-0 flex-col justify-center rounded-lg border border-app-border bg-app-surface/40 p-3">
    <div className="text-xs uppercase tracking-wide text-app-text-muted">{label}</div>
    <div className="mt-1 flex items-baseline gap-1 truncate font-mono tabular-nums text-app-text">
      <span className={`${prominent ? "text-4xl" : "text-xl"} font-semibold`}>{value}</span>{unit && <span className="text-xs text-app-text-dim">{unit}</span>}
    </div>
  </div>;
}

function InputMeter({ label, value, color }: { label: string; value: number | undefined; color: string }) {
  const pct = value === undefined ? undefined : controlInputPercent(value);
  return <div className="space-y-1">
    <div className="flex justify-between text-sm"><span className="text-app-text-secondary">{label}</span><span className="font-mono tabular-nums text-app-text">{pct === undefined ? "—" : `${pct.toFixed(0)}%`}</span></div>
    <div className="h-2 overflow-hidden rounded bg-app-border"><div className="h-full rounded" style={{ width: `${pct ?? 0}%`, backgroundColor: color }} /></div>
  </div>;
}

export function IRacingLiveDashboard() {
  const connected = useTelemetryStore((s) => s.connected);
  const status = useTelemetryStore((s) => s.serverStatus);
  const rawView = useTelemetryStore((s) => s.telemetryView);
  const sectors = useTelemetryStore((s) => s.sectors);
  const view = connected && status !== null && status.telemetryPps > 0 && status.detectedGame?.id === "iracing" && rawView?.simulator === "iracing" ? rawView : null;
  const units = useUnits("iracing");
  const { data: carResolved } = useCarName(view?.identity.carId);
  const { data: trackResolved } = useTrackName(view?.identity.trackId);
  const car = carResolved || view?.identity.carId;
  const track = trackResolved || view?.identity.trackId;
  const fuel = view?.fuel.amount === undefined ? undefined : getFuelAmount(view.fuel.amount, getGame("iracing").telemetry.fuel);

  return <main data-live-dashboard-layout data-live-dashboard-game="iracing" className="mx-auto w-full max-w-7xl flex-1 space-y-4 overflow-y-auto p-3 sm:p-5">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border pb-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-bold text-app-text">{m.iracing_live_title()}</h1><span className={`rounded-full px-2 py-1 text-xs ${view ? "bg-status-success/15 text-status-success" : "bg-app-border text-app-text-muted"}`}>{view ? m.iracing_live_receiving() : connected ? m.iracing_live_waiting_title() : m.iracing_live_disconnected()}</span></div>
        <p className="mt-1 text-sm text-app-text-muted">{m.iracing_live_subtitle()}</p>
      </div>
      {view && <div className="min-w-0 text-right text-sm text-app-text-secondary">{car && <div className="truncate font-medium">{car}</div>}{track && <div className="truncate text-app-text-muted">{track}</div>}</div>}
    </header>

    {!view ? <section className="mx-auto max-w-2xl rounded-xl border border-app-border bg-app-surface p-5 sm:p-8">
      <h2 className="text-lg font-semibold text-app-text">{m.iracing_live_waiting_title()}</h2>
      <p className="mt-2 leading-relaxed text-app-text-secondary">{m.iracing_live_waiting_description()}</p>
      <p className="mt-4 text-sm text-app-text-muted">{m.iracing_live_position_note()}</p>
    </section> : <>
      <section className="grid gap-3 rounded-xl border border-app-border bg-app-surface p-3 sm:grid-cols-3 sm:p-4">
        <div className="flex items-center justify-between gap-2 py-3">
          <div><div className="text-xs uppercase tracking-wide text-app-text-muted">{m.label_speed()}</div><div className="font-mono text-5xl font-black tabular-nums text-app-text">{view.motion.speedMps === undefined ? "—" : units.speed(view.motion.speedMps).toFixed(0)}<span className="ml-2 text-base font-normal">{units.speedLabel}</span></div></div>
          <div className="text-right"><div className="text-xs uppercase tracking-wide text-app-text-muted">{m.dataguide_gear()}</div><div className="font-mono text-5xl font-black tabular-nums text-app-accent">{view.inputs.gear === undefined ? "—" : view.inputs.gear === 0 ? "R" : view.inputs.gear === 11 ? "N" : view.inputs.gear}</div></div>
        </div>
        <Metric prominent label={m.dataguide_rpm()} value={view.engine.rpm === undefined ? "—" : view.engine.rpm.toFixed(0)} unit="rpm" />
        <div className="space-y-3 rounded-lg border border-app-border p-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-app-text-muted">{m.iracing_live_inputs()}</h2>
          <InputMeter label={m.chart_throttle()} value={view.inputs.throttle} color="var(--ch-throttle)" />
          <InputMeter label={m.chart_brake()} value={view.inputs.brake} color="var(--ch-brake)" />
          <InputMeter label={m.streaming_clutch()} value={view.inputs.clutch} color="var(--app-accent)" />
          <div className="flex justify-between text-sm"><span className="text-app-text-secondary">{m.analyse_chart_steering()}</span><span className="font-mono tabular-nums text-app-text">{view.inputs.steer === undefined ? "—" : `${(view.inputs.steer / 127 * 100).toFixed(0)}%`}</span></div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Metric label={m.label_position()} value={view.timing.racePosition !== undefined && view.timing.racePosition > 0 ? `P${view.timing.racePosition}` : "—"} />
        <Metric label={m.race_lap()} value={view.timing.lapNumber === undefined ? "—" : String(view.timing.lapNumber)} />
        <Metric label={m.telemetry_current()} value={view.timing.currentLapS === undefined ? "—" : formatLapTime(view.timing.currentLapS)} />
        <Metric label={m.label_last()} value={view.timing.lastLapS === undefined ? "—" : formatLapTime(view.timing.lastLapS)} />
        <Metric label={m.label_best()} value={view.timing.bestLapS === undefined ? "—" : formatLapTime(view.timing.bestLapS)} />
      </section>
      {view.timing.lapFraction !== undefined && <section className="rounded-xl border border-app-border bg-app-surface p-4">
        <div className="mb-2 flex justify-between text-sm"><h2 className="font-semibold text-app-text">{m.iracing_live_lap_progress()}</h2><span className="font-mono tabular-nums text-app-text-secondary">{(view.timing.lapFraction * 100).toFixed(0)}%</span></div>
        <div className="h-2 overflow-hidden rounded bg-app-border"><div className="h-full bg-app-accent" style={{ width: `${Math.max(0, Math.min(100, view.timing.lapFraction * 100))}%` }} /></div>
      </section>}
      {sectors && <section className="rounded-xl border border-app-border bg-app-surface p-4"><h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-app-text-muted">{m.label_race()}</h2><SectorTimes sectors={sectors} /></section>}

      {fuel && <section className="grid grid-cols-2 gap-3"><Metric label={m.iracing_live_fuel_remaining()} value={fuel.amount.toFixed(1)} unit={fuel.unit} /></section>}
      {(view.motion.acceleration || view.motion.attitude) && <section className="rounded-xl border border-app-border bg-app-surface p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-app-text-muted">{m.iracing_live_motion()}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {view.motion.acceleration && <><Metric label={m.iracing_live_lateral_g()} value={(view.motion.acceleration.x / 9.80665).toFixed(2)} unit="g" /><Metric label={m.iracing_live_longitudinal_g()} value={(view.motion.acceleration.z / 9.80665).toFixed(2)} unit="g" /></>}
          {view.motion.attitude && <><Metric label={m.iracing_live_roll()} value={(view.motion.attitude.roll * 180 / Math.PI).toFixed(1)} unit="°" /><Metric label={m.iracing_live_pitch()} value={(view.motion.attitude.pitch * 180 / Math.PI).toFixed(1)} unit="°" /></>}
        </div>
      </section>}
      {view.tires.suspensionTravelM && <section className="rounded-xl border border-app-border bg-app-surface p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-app-text-muted">{m.iracing_live_suspension()}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{(["fl", "fr", "rl", "rr"] as const).map((wheel) => <Metric key={wheel} label={wheel.toUpperCase()} value={(view.tires.suspensionTravelM![wheel] * 1000).toFixed(1)} unit="mm" />)}</div>
      </section>}
      {(view.weather.airTemperatureC !== undefined || view.weather.trackTemperatureC !== undefined) && <section className="grid grid-cols-2 gap-3">
        {view.weather.airTemperatureC !== undefined && <Metric label={m.analyse_air()} value={units.temp(view.weather.airTemperatureC).toFixed(1)} unit={units.tempLabel} />}
        {view.weather.trackTemperatureC !== undefined && <Metric label={m.analyse_track()} value={units.temp(view.weather.trackTemperatureC).toFixed(1)} unit={units.tempLabel} />}
      </section>}
      <footer className="space-y-1 border-t border-app-border pt-3 text-xs text-app-text-muted">
        <p>{m.iracing_live_snapshot_note()}</p>
        <p>{m.iracing_live_position_note()}</p>
      </footer>
    </>}
  </main>;
}
