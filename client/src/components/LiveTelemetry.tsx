import { useEffect, useRef, useState } from "react";
import { tryGetGame } from "@shared/games/registry";
import type { DisplayPacket } from "../lib/convert-packet";
import { SteeringWheel } from "./SteeringWheel";
import { useUnits } from "../hooks/useUnits";
import { client } from "../lib/rpc";
import { useGameId } from "../stores/game";

import { GripHistory } from "./telemetry/GripHistory";
import { PitEstimate } from "./telemetry/PitEstimate";
import { TireDiagram } from "./telemetry/TireDiagram";
import { SurfaceConditions } from "./telemetry/SurfaceConditions";
import { GForceCircle } from "./telemetry/GForceCircle";
import { ArcGauge, FuelGauge, PowerTorque } from "./telemetry/Gauges";
import { TelemetryCharts } from "./telemetry/TelemetryCharts";
import { TireRaceView } from "./telemetry/TireRaceView";

// Re-export for backward compatibility
export { formatLapTime } from "../lib/format";

export type DashboardMode = "driver" | "pitcrew";

interface Props {
  packet: DisplayPacket | null;
  mode?: DashboardMode;
}

export function LiveTelemetry({ packet, mode = "driver" }: Props) {
  const gameId = useGameId();
  const [carName, setCarName] = useState<string>("");
  const lastCarOrdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!packet) return;
    const ord = packet.CarOrdinal;
    if (ord === lastCarOrdRef.current) return;
    lastCarOrdRef.current = ord;

    client.api["car-name"][":ordinal"].$get({ param: { ordinal: String(ord) }, query: { gameId: gameId! } })
      .then((r) => r.ok ? r.text() : `Car #${ord}`)
      .then((name) => setCarName(name))
      .catch(() => setCarName(`Car #${ord}`));
  }, [packet?.CarOrdinal, gameId]);

  const units = useUnits();

  if (!packet) {
    return (
      <div className="flex items-center justify-center h-full text-app-text-dim">
        Waiting for telemetry data...
      </div>
    );
  }

  const speed = packet.DisplaySpeed;
  const throttlePct = (packet.Accel / 255) * 100;
  const brakePct = (packet.Brake / 255) * 100;
  const rpmPct = packet.EngineMaxRpm > 0 ? (packet.CurrentEngineRpm / packet.EngineMaxRpm) * 100 : 0;
  const hp = packet.Power / 745.7;
  const boostVal = packet.Boost;

  // ── Shared hero: Speed + Gear + RPM ──────────────────────────
  const heroSection = (
    <div className="bg-app-surface-alt/20 p-3 pb-2">
      {carName && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-semibold text-app-text truncate">{carName}</span>
          <span className="text-[10px] font-mono font-semibold px-1.5 py-px rounded bg-app-surface-alt text-app-accent shrink-0">
            {(gameId && tryGetGame(gameId)?.carClassNames?.[packet.CarClass]) ?? "?"}{packet.CarPerformanceIndex}
          </span>
          <span className="text-[10px] text-app-text-dim shrink-0">
            {(gameId && tryGetGame(gameId)?.drivetrainNames?.[packet.DrivetrainType]) ?? "?"}
          </span>
        </div>
      )}
      <div className="flex items-end justify-between mb-1">
        <div className="flex items-baseline gap-1">
          <span className="text-5xl font-mono font-black text-app-text tabular-nums leading-none tracking-tighter">
            {speed.toFixed(0)}
          </span>
          <span className="text-sm text-app-text-muted font-mono">{units.speedLabel}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] text-app-text-dim font-mono">{hp.toFixed(0)}hp</span>
          <span className={`text-5xl font-mono font-black tabular-nums leading-none tracking-tighter ${rpmPct > 90 ? "text-red-400" : "text-app-accent"}`}>
            {packet.Gear === 0 ? "R" : packet.Gear === 11 ? "N" : packet.Gear}
          </span>
        </div>
      </div>
      <div className="flex gap-[2px] mb-1">
        {Array.from({ length: 30 }, (_, i) => {
          const segPct = ((i + 1) / 30) * 100;
          const lit = rpmPct >= segPct;
          let color: string;
          if (segPct <= 60) color = lit ? "bg-cyan-400" : "bg-cyan-400/8";
          else if (segPct <= 80) color = lit ? "bg-amber-400" : "bg-amber-400/8";
          else color = lit ? "bg-red-500" : "bg-red-500/8";
          return (
            <div key={i} className={`flex-1 h-4 rounded-sm ${color} ${lit && segPct > 90 ? "animate-pulse" : ""}`} />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-app-text-dim font-mono tabular-nums">
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
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Tire Health</h2>
          </div>
          <div className="p-3">
            <TireRaceView packet={packet} />
          </div>
        </div>

        {/* Pit Window */}
        <div className="border-b border-app-border">
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Pit Window</h2>
          </div>
          <div className="p-3">
            <PitEstimate packet={packet} />
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
              <span className="text-[9px] font-mono text-emerald-400 font-bold w-6 text-right tabular-nums">{throttlePct.toFixed(0)}</span>
              <div className="flex-1 h-3 bg-app-surface-alt rounded-full overflow-hidden">
                <div className="h-full bg-emerald-400 rounded-full transition-all" style={{ width: `${throttlePct}%` }} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-red-400 font-bold w-6 text-right tabular-nums">{brakePct.toFixed(0)}</span>
              <div className="flex-1 h-3 bg-app-surface-alt rounded-full overflow-hidden">
                <div className="h-full bg-red-500 rounded-full transition-all" style={{ width: `${brakePct}%` }} />
              </div>
            </div>
          </div>
          <div className="flex gap-1 shrink-0">
            <PowerTorque packet={packet} />
            <ArcGauge value={boostVal} max={30} label="Boost" unit="psi" color="#22d3ee" />
          </div>
        </div>
      </div>

      {/* G-Force + Steering + Fuel */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="flex items-center gap-3">
          <GForceCircle packet={packet} />
          <SteeringWheel steer={packet.Steer} />
          <div className="flex-1">
            <FuelGauge packet={packet} />
          </div>
        </div>
      </div>

      {/* Full tire diagram with suspension */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="text-[10px] text-app-text-muted uppercase tracking-wider font-semibold mb-2">Tires</div>
        <TireDiagram packet={packet} />
      </div>

      {/* Surface conditions */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <SurfaceConditions packet={packet} />
      </div>

      {/* Grip history */}
      <div className="px-3 py-2 border-b border-app-border/50">
        <div className="text-[10px] text-app-text-muted uppercase tracking-wider font-semibold mb-2">Grip (60s)</div>
        <GripHistory packet={packet} />
      </div>

      {/* Telemetry charts */}
      <div className="px-3 py-2">
        <div className="text-[10px] text-app-text-muted uppercase tracking-wider font-semibold mb-2">Telemetry (60s)</div>
        <TelemetryCharts packet={packet} />
      </div>
    </div>
  );
}
