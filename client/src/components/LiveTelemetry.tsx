import { getGame, tryGetGame } from "@shared/games/registry";
import { WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { useEffect, useState } from "react";
import { m } from "@/paraglide/messages";
import { useUnits } from "../hooks/useUnits";
import type { LiveTelemetryView } from "../lib/live-telemetry-view";
import { client } from "../lib/rpc";
import { controlInputPercent } from "../lib/vehicle-dynamics";
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
  const pitFromStore = useTelemetryStore((s) => s.pit);
  const [carName, setCarName] = useState<string>("");
  const gameId = view?.simulator ?? null;
  const carOrdinal = view?.identity.carOrdinal;

  useEffect(() => {
    if (gameId == null || carOrdinal == null) return;
    let active = true;
    client.api["car-name"][":ordinal"]
      .$get({ param: { ordinal: String(carOrdinal) }, query: { gameId } })
      .then((response) => (response.ok ? response.text() : `Car #${carOrdinal}`))
      .then((name) => {
        if (active) setCarName(name);
      })
      .catch(() => {
        if (active) setCarName(`Car #${carOrdinal}`);
      });
    return () => {
      active = false;
    };
  }, [carOrdinal, gameId]);

  const units = useUnits();
  if (!view) {
    return <div className="flex items-center justify-center h-full text-app-text-dim">{m.live_waiting_data()}</div>;
  }

  const unavailable = "—";
  const speed = view.motion.speedMps === undefined ? undefined : units.speed(view.motion.speedMps);
  const throttlePct = view.inputs.throttle === undefined ? undefined : controlInputPercent(view.inputs.throttle);
  const brakePct = view.inputs.brake === undefined ? undefined : controlInputPercent(view.inputs.brake);
  const currentRpm = view.engine.rpm;
  const idleRpm = view.engine.idleRpm;
  const maxRpm = view.engine.maxRpm;
  const rpmPct = currentRpm !== undefined && maxRpm !== undefined && maxRpm > 0 ? (currentRpm / maxRpm) * 100 : undefined;
  const pit = view.context?.pit ?? pitFromStore;
  const adapter = getGame(view.simulator);
  const telemetryModel = adapter.telemetry;
  const analysis = resolveAnalysisTelemetry(adapter);
  const pitTemperature = analysis.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "pit-snapshot";
  const pitHealth = analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "pit-snapshot";
  const temperatureAvailable = view.tires.temperatureC !== undefined;
  const healthAvailable = view.tires.wear !== undefined;
  const tireFreshnessNote =
    pitTemperature && pitHealth
      ? `${m.analyse_wheels_pit_temp()} · ${m.analyse_wheels_pit_health()}`
      : pitTemperature
        ? m.analyse_wheels_pit_temp()
        : pitHealth
          ? m.analyse_wheels_pit_health()
          : undefined;
  const showPerWheelSurface = analysis.surface.source !== "unavailable" && analysis.surface.display !== "vehicle";
  const hp = view.engine.powerW === undefined ? undefined : view.engine.powerW / WATTS_PER_HORSEPOWER;
  const boostVal = view.engine.boost;
  const carClassId = view.identity.carClass;
  const drivetrainId = view.identity.drivetrainType;
  const carClassName = carClassId === undefined ? undefined : tryGetGame(view.simulator)?.carClassNames?.[carClassId];
  const drivetrainName = drivetrainId === undefined ? undefined : tryGetGame(view.simulator)?.drivetrainNames?.[drivetrainId];

  // ── Shared hero: Speed + Gear + RPM ──────────────────────────
  const heroSection = (
    <div className="p-3 pb-2">
      {carName && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-semibold text-app-text truncate">{carName}</span>
          <span className="text-app-caption font-mono font-semibold px-1.5 py-px rounded text-app-accent shrink-0">
            {carClassName ?? unavailable}
            {view.identity.performanceIndex === undefined ? unavailable : view.identity.performanceIndex}
          </span>
          <span className="text-app-caption text-app-text-dim shrink-0">{drivetrainName ?? unavailable}</span>
        </div>
      )}
      <div className="flex items-end justify-between mb-1">
        <div className="flex items-baseline gap-1">
          <span className="text-5xl font-mono font-black text-app-text tabular-nums leading-none tracking-tighter">{speed === undefined ? unavailable : speed.toFixed(0)}</span>
          <span className="text-sm text-app-text-muted font-mono">{units.speedLabel}</span>
        </div>
        <div className="flex items-baseline gap-2">
          {telemetryModel.power && hp !== undefined && <span className="text-app-caption text-app-text-dim font-mono">{hp.toFixed(0)}hp</span>}
          <span className="text-5xl font-mono font-black tabular-nums leading-none tracking-tighter" style={{ color: rpmPct !== undefined && rpmPct > 90 ? "var(--rev-limit)" : "var(--app-accent)" }}>
            {view.inputs.gear === undefined ? unavailable : view.inputs.gear === 0 ? "R" : view.inputs.gear === 11 ? "N" : view.inputs.gear}
          </span>
        </div>
      </div>
      {rpmPct === undefined ? (
        <div className="text-center text-app-caption text-app-text-dim font-mono">{unavailable}</div>
      ) : (
        <div className="flex gap-[2px] mb-1">
          {Array.from({ length: 30 }, (_, i) => {
            const segPct = ((i + 1) / 30) * 100;
            const lit = rpmPct >= segPct;
            const color = segPct <= 60 ? "var(--rev-normal)" : segPct <= 80 ? "var(--rev-high)" : "var(--rev-limit)";
            return <div key={segPct} className={`flex-1 h-4 rounded-sm ${lit && segPct > 90 ? "animate-pulse" : ""}`} style={{ backgroundColor: color, opacity: lit ? 1 : 0.08 }} />;
          })}
        </div>
      )}
      <div className="flex justify-between text-app-micro text-app-text-dim font-mono tabular-nums">
        <span>{idleRpm === undefined ? unavailable : idleRpm.toFixed(0)}</span>
        <span>{currentRpm === undefined ? unavailable : `${currentRpm.toFixed(0)} rpm`}</span>
        <span>{maxRpm === undefined ? unavailable : maxRpm.toFixed(0)}</span>
      </div>
    </div>
  );

  // ── DRIVER MODE ──────────────────────────────────────────────
  if (mode === "driver") {
    return (
      <div className="grid gap-0 p-0">
        <div className="border-b border-app-border">
          <TireGrid
            fl={{ tempC: view.tires.temperatureC?.fl === undefined ? undefined : units.toTempC(view.tires.temperatureC.fl), wear: view.tires.wear?.fl }}
            fr={{ tempC: view.tires.temperatureC?.fr === undefined ? undefined : units.toTempC(view.tires.temperatureC.fr), wear: view.tires.wear?.fr }}
            rl={{ tempC: view.tires.temperatureC?.rl === undefined ? undefined : units.toTempC(view.tires.temperatureC.rl), wear: view.tires.wear?.rl }}
            rr={{ tempC: view.tires.temperatureC?.rr === undefined ? undefined : units.toTempC(view.tires.temperatureC.rr), wear: view.tires.wear?.rr }}
            healthThresholds={(gameId ? tryGetGame(gameId) : null)?.tireHealthThresholds ?? { green: 0.7, yellow: 0.4 }}
            tempThresholds={{ blue: 60, orange: 85, red: 100 }}
            freshnessNote={tireFreshnessNote}
            temperatureAvailable={temperatureAvailable}
            healthAvailable={healthAvailable}
          />
        </div>
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
                {throttlePct === undefined ? unavailable : throttlePct.toFixed(0)}
              </span>
              <div className="flex-1 h-3 rounded-full overflow-hidden">
                {throttlePct !== undefined && <div className="h-full rounded-full transition-all" style={{ backgroundColor: "var(--ch-throttle)", width: `${throttlePct}%` }} />}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-app-micro font-mono font-bold w-6 text-right tabular-nums" style={{ color: "var(--ch-brake)" }}>
                {brakePct === undefined ? unavailable : brakePct.toFixed(0)}
              </span>
              <div className="flex-1 h-3 rounded-full overflow-hidden">
                {brakePct !== undefined && <div className="h-full rounded-full transition-all" style={{ backgroundColor: "var(--ch-brake)", width: `${brakePct}%` }} />}
              </div>
            </div>
          </div>
          {(telemetryModel.power || telemetryModel.torque || (telemetryModel.boost && boostVal !== undefined)) && (
            <div className="flex gap-1 shrink-0">
              <PowerTorque view={view} />
              {telemetryModel.boost && boostVal !== undefined && <ArcGauge value={boostVal} max={30} label={m.live_boost()} unit="psi" color="var(--app-accent)" />}
            </div>
          )}
        </div>
      </div>
      {/* G-Force + Steering + Fuel */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="flex items-center gap-3">
          <GForceCircle view={view} />
          <SteeringWheel steer={view.inputs.steer} rpm={currentRpm} maxRpm={maxRpm} />
          <div className="flex-1">
            <FuelGauge view={view} />
          </div>
        </div>
      </div>

      {/* Full tire diagram with suspension */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="text-app-caption text-app-text-muted uppercase tracking-wider font-semibold mb-2">{m.label_tires()}</div>
        <TireDiagram view={view} />
      </div>

      {/* Surface conditions */}
      {showPerWheelSurface && (
        <div className="px-3 py-2 border-b border-app-border/50">
          <SurfaceConditions view={view} />
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
        <TelemetryCharts view={view} />
      </div>
    </div>
  );
}
