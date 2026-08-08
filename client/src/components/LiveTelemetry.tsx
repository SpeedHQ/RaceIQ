import { getGame, tryGetGame } from "@shared/games/registry";
import { WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import { hasTireHealthData, hasTireTemperatureData, resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { useEffect, useState } from "react";
import { m } from "@/paraglide/messages";
import { useUnits } from "../hooks/useUnits";
import type { LiveTelemetryView } from "../lib/live-telemetry-view";
import { client } from "../lib/rpc";
import { useTelemetryStore } from "../stores/telemetry";
import { SteeringWheel } from "./SteeringWheel";
import { ArcGauge, FuelGauge, PowerTorque } from "./telemetry/Gauges";
import { GForceCircle } from "./telemetry/GForceCircle";
import { GripHistory } from "./telemetry/GripHistory";
import { PitEstimate } from "./telemetry/PitEstimate";
import { SurfaceConditions } from "./telemetry/SurfaceConditions";
import { TelemetryCharts } from "./telemetry/TelemetryCharts";
import { TireDiagram } from "./telemetry/TireDiagram";
import { TireGrid } from "./telemetry/TireGrid";

// Re-export for backward compatibility
export { formatLapTime } from "../lib/format";

export type DashboardMode = "driver" | "pitcrew";

interface Props {
  view: LiveTelemetryView | null;
  mode?: DashboardMode;
}

export function LiveTelemetry({ view, mode = "driver" }: Props) {
  const pit = useTelemetryStore((s) => s.pit);
  const [carName, setCarName] = useState<string>("");
  const gameId = view?.simulator ?? null;
  const carOrdinal = view?.identity.carOrdinal;

  useEffect(() => {
    if (gameId == null || carOrdinal == null) return;
    let active = true;
    client.api["car-name"][":ordinal"]
      .$get({ param: { ordinal: String(carOrdinal) }, query: { gameId } })
      .then((response) => (response.ok ? response.text() : `Car #${carOrdinal}`))
      .then((name) => { if (active) setCarName(name); })
      .catch(() => { if (active) setCarName(`Car #${carOrdinal}`); });
    return () => { active = false; };
  }, [carOrdinal, gameId]);

  const units = useUnits();
  if (!view) {
    return <div className="flex items-center justify-center h-full text-app-text-dim">{m.live_waiting_data()}</div>;
  }

  // Legacy child widgets still consume packet-shaped props; semantic values stay canonical SI.
  const packet = {
    gameId: view.simulator, CarOrdinal: view.identity.carOrdinal ?? 0, TrackOrdinal: view.identity.trackOrdinal ?? 0,
    CarClass: view.identity.carClass ?? 0, CarPerformanceIndex: view.identity.performanceIndex ?? 0, DrivetrainType: view.identity.drivetrainType ?? 0,
    DisplaySpeed: units.speed(view.motion.speedMps ?? 0), Accel: (view.inputs.throttle ?? 0) * 255, Brake: (view.inputs.brake ?? 0) * 255,
    CurrentEngineRpm: view.engine.rpm ?? 0, EngineIdleRpm: view.engine.idleRpm ?? 0, EngineMaxRpm: view.engine.maxRpm ?? 0,
    Power: view.engine.powerW ?? 0, Boost: view.engine.boost ?? 0, Gear: view.inputs.gear ?? 0, Steer: view.inputs.steer ?? 0,
    TireTempFL: view.tires.temperatureC?.fl ?? 0, TireTempFR: view.tires.temperatureC?.fr ?? 0, TireTempRL: view.tires.temperatureC?.rl ?? 0, TireTempRR: view.tires.temperatureC?.rr ?? 0,
    TireWearFL: view.tires.wear?.fl ?? 0, TireWearFR: view.tires.wear?.fr ?? 0, TireWearRL: view.tires.wear?.rl ?? 0, TireWearRR: view.tires.wear?.rr ?? 0,
  } as any;


  const speed = packet.DisplaySpeed;
  const throttlePct = (packet.Accel / 255) * 100;
  const brakePct = (packet.Brake / 255) * 100;
  const rpmPct = packet.EngineMaxRpm > 0 ? (packet.CurrentEngineRpm / packet.EngineMaxRpm) * 100 : 0;
  const adapter = getGame(packet.gameId);
  const telemetryModel = adapter.telemetry;
  const analysis = resolveAnalysisTelemetry(adapter);
  const pitTemperature = analysis.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "pit-snapshot";
  const pitHealth = analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "pit-snapshot";
  const temperatureAvailable = hasTireTemperatureData(packet, analysis.tireTemperature);
  const healthAvailable = hasTireHealthData(packet, analysis.tireHealth);
  const tireFreshnessNote =
    pitTemperature && pitHealth
      ? `${m.analyse_wheels_pit_temp()} · ${m.analyse_wheels_pit_health()}`
      : pitTemperature
        ? m.analyse_wheels_pit_temp()
        : pitHealth
          ? m.analyse_wheels_pit_health()
          : undefined;
  const showPerWheelSurface = analysis.surface.source !== "unavailable" && analysis.surface.display !== "vehicle";
  const hp = packet.Power / WATTS_PER_HORSEPOWER;
  const boostVal = packet.Boost;

  // ── Shared hero: Speed + Gear + RPM ──────────────────────────
  const heroSection = (
    <div className="p-3 pb-2">
      {carName && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-semibold text-app-text truncate">{carName}</span>
          <span className="text-app-caption font-mono font-semibold px-1.5 py-px rounded text-app-accent shrink-0">
            {(gameId && tryGetGame(gameId)?.carClassNames?.[packet.CarClass]) ?? "?"}
            {packet.CarPerformanceIndex}
          </span>
          <span className="text-app-caption text-app-text-dim shrink-0">{(gameId && tryGetGame(gameId)?.drivetrainNames?.[packet.DrivetrainType]) ?? "?"}</span>
        </div>
      )}
      <div className="flex items-end justify-between mb-1">
        <div className="flex items-baseline gap-1">
          <span className="text-5xl font-mono font-black text-app-text tabular-nums leading-none tracking-tighter">{speed.toFixed(0)}</span>
          <span className="text-sm text-app-text-muted font-mono">{units.speedLabel}</span>
        </div>
        <div className="flex items-baseline gap-2">
          {telemetryModel.power && <span className="text-app-caption text-app-text-dim font-mono">{hp.toFixed(0)}hp</span>}
          <span className="text-5xl font-mono font-black tabular-nums leading-none tracking-tighter" style={{ color: rpmPct > 90 ? "var(--rev-limit)" : "var(--app-accent)" }}>
            {packet.Gear === 0 ? "R" : packet.Gear === 11 ? "N" : packet.Gear}
          </span>
        </div>
      </div>
      <div className="flex gap-[2px] mb-1">
        {Array.from({ length: 30 }, (_, i) => {
          const segPct = ((i + 1) / 30) * 100;
          const lit = rpmPct >= segPct;
          const color = segPct <= 60 ? "var(--rev-normal)" : segPct <= 80 ? "var(--rev-high)" : "var(--rev-limit)";
          return <div key={segPct} className={`flex-1 h-4 rounded-sm ${lit && segPct > 90 ? "animate-pulse" : ""}`} style={{ backgroundColor: color, opacity: lit ? 1 : 0.08 }} />;
        })}
      </div>
      <div className="flex justify-between text-app-micro text-app-text-dim font-mono tabular-nums">
        <span>{packet.EngineIdleRpm.toFixed(0)}</span>
        <span>{packet.CurrentEngineRpm.toFixed(0)} rpm</span>
        <span>{packet.EngineMaxRpm.toFixed(0)}</span>
      </div>
    </div>
  );

  // ── DRIVER MODE ──────────────────────────────────────────────
  if (mode === "driver") {
    return (
      <div className="grid gap-0 p-0">
        {/* Tire Health */}
        <div className="border-b border-app-border">
          <TireGrid
            fl={{ tempC: units.toTempC(packet.TireTempFL), wear: packet.TireWearFL }}
            fr={{ tempC: units.toTempC(packet.TireTempFR), wear: packet.TireWearFR }}
            rl={{ tempC: units.toTempC(packet.TireTempRL), wear: packet.TireWearRL }}
            rr={{ tempC: units.toTempC(packet.TireTempRR), wear: packet.TireWearRR }}
            healthThresholds={(gameId ? tryGetGame(gameId) : null)?.tireHealthThresholds ?? { green: 0.7, yellow: 0.4 }}
            tempThresholds={{ blue: 60, orange: 85, red: 100 }}
            freshnessNote={tireFreshnessNote}
            temperatureAvailable={temperatureAvailable}
            healthAvailable={healthAvailable}
          />
        </div>

        {/* Pit Window */}
        <div className="border-b border-app-border">
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.live_pit_window()}</h2>
          </div>
          <div className="p-3">
            <PitEstimate view={view} pit={pit} />
          </div>
        </div>
      </div>
    );
  }

  // ── PIT CREW MODE ────────────────────────────────────────────
  return (
    <div className="grid gap-0 p-0">
      {heroSection}

      {/* Inputs: Throttle/Brake + Power/Boost */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="flex gap-3 items-center">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-app-micro font-mono font-bold w-6 text-right tabular-nums" style={{ color: "var(--ch-throttle)" }}>
                {throttlePct.toFixed(0)}
              </span>
              <div className="flex-1 h-3 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ backgroundColor: "var(--ch-throttle)", width: `${throttlePct}%` }} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-app-micro font-mono font-bold w-6 text-right tabular-nums" style={{ color: "var(--ch-brake)" }}>
                {brakePct.toFixed(0)}
              </span>
              <div className="flex-1 h-3 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ backgroundColor: "var(--ch-brake)", width: `${brakePct}%` }} />
              </div>
            </div>
          </div>
          {(telemetryModel.power || telemetryModel.torque || telemetryModel.boost) && (
            <div className="flex gap-1 shrink-0">
              <PowerTorque packet={packet} view={view ?? undefined} />
              {telemetryModel.boost && <ArcGauge value={boostVal} max={30} label={m.live_boost()} unit="psi" color="var(--app-accent)" />}
            </div>
          )}
        </div>
      </div>

      {/* G-Force + Steering + Fuel */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="flex items-center gap-3">
          <GForceCircle view={view} />
          <SteeringWheel steer={packet.Steer} />
          <div className="flex-1">
            <FuelGauge packet={packet} view={view ?? undefined} />
          </div>
        </div>
      </div>

      {/* Full tire diagram with suspension */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="text-app-caption text-app-text-muted uppercase tracking-wider font-semibold mb-2">{m.label_tires()}</div>
        <TireDiagram packet={packet} view={view ?? undefined} />
      </div>

      {/* Surface conditions */}
      {showPerWheelSurface && (
        <div className="px-3 py-2 border-b border-app-border/50">
          <SurfaceConditions packet={packet} view={view ?? undefined} />
        </div>
      )}

      {/* Grip history */}
      {analysis.gripDemand.source !== "unavailable" && (
        <div className="px-3 py-2 border-b border-app-border/50">
          <div className="text-app-caption text-app-text-muted uppercase tracking-wider font-semibold mb-2">{m.live_grip()} (60s)</div>
          <GripHistory view={view} />
        </div>
      )}

      {/* Telemetry charts */}
      <div className="px-3 py-2">
        <div className="text-app-caption text-app-text-muted uppercase tracking-wider font-semibold mb-2">{m.live_telemetry()} (60s)</div>
        <TelemetryCharts packet={packet} view={view ?? undefined} />
      </div>
    </div>
  );
}
