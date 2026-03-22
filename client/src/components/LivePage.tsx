import { useState } from "react";
import { useTelemetryStore } from "../stores/telemetry";
import { useStatus, useTrackName } from "../hooks/queries";
import { LiveTelemetry, formatLapTime, type DashboardMode } from "./LiveTelemetry";
import { LiveTrackMap } from "./LiveTrackMap";
import { LapList } from "./LapList";
import { LapTimeChart } from "./LapTimeChart";
import { SectorTimes } from "./SectorTimes";
import { useDemoMode } from "../hooks/useDemoMode";
import { useUnits } from "../hooks/useUnits";

export function LivePage() {
  const packet = useTelemetryStore((s) => s.packet);
  const units = useUnits();
  const { data: status } = useStatus();
  const trackOrd = packet?.TrackOrdinal ?? (status as any)?.currentSession?.trackOrdinal;
  const { data: trackName } = useTrackName(trackOrd);
  const demo = useDemoMode();
  const [dashMode, setDashMode] = useState<DashboardMode>("driver");

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0 h-full">
      {/* Left column: Live Telemetry */}
      <div className="border-r border-app-border overflow-auto">
        <div className="p-2 border-b border-app-border flex items-center justify-between">
          {/* Mode toggle */}
          <div className="flex items-center gap-1 bg-app-surface-alt rounded p-0.5">
            <button
              onClick={() => setDashMode("driver")}
              className={`text-[10px] font-semibold px-2 py-0.5 rounded transition-colors ${
                dashMode === "driver"
                  ? "bg-app-accent/20 text-app-accent"
                  : "text-app-text-muted hover:text-app-text"
              }`}
            >
              Driver
            </button>
            <button
              onClick={() => setDashMode("pitcrew")}
              className={`text-[10px] font-semibold px-2 py-0.5 rounded transition-colors ${
                dashMode === "pitcrew"
                  ? "bg-app-accent/20 text-app-accent"
                  : "text-app-text-muted hover:text-app-text"
              }`}
            >
              Pit Crew
            </button>
          </div>
          <button
            onClick={demo.toggle}
            disabled={demo.loading}
            className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded border transition-colors ${
              demo.active
                ? "bg-amber-500/20 border-amber-500/50 text-amber-400 hover:bg-amber-500/30"
                : demo.loading
                  ? "bg-app-surface-alt border-app-border text-app-text-dim cursor-wait"
                  : "bg-app-surface-alt border-app-border text-app-text-muted hover:text-app-text hover:border-app-border-hover"
            }`}
          >
            {demo.loading ? "Loading..." : demo.active ? "Stop Demo" : "Demo"}
          </button>
        </div>
        <LiveTelemetry packet={packet} mode={dashMode} />
      </div>

      {/* Right column: Race HUD */}
      <div className="overflow-auto flex flex-col">
        {/* Hero: Race timing + Track map sidebar */}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_220px] border-b border-app-border">
          {/* Race Info — hero panel */}
          <div className="border-r border-app-border">
            <div className="p-2 border-b border-app-border">
              <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Race</h2>
            </div>
            {packet ? (
              <div className="p-3">
                {/* Position + Lap + Current time */}
                <div className="flex items-baseline gap-4 mb-2">
                  <div>
                    <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Position</div>
                    <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">
                      P{packet.RacePosition}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Lap</div>
                    <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">
                      {packet.LapNumber}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Current</div>
                    <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">
                      {formatLapTime(packet.CurrentLap)}
                    </div>
                  </div>
                  {/* Delta from best */}
                  {packet.LastLap > 0 && packet.BestLap > 0 && (() => {
                    const delta = packet.LastLap - packet.BestLap;
                    const color = delta <= 0 ? "text-emerald-400" : delta < 1 ? "text-orange-400" : "text-red-400";
                    return (
                      <div className="text-right">
                        <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Delta</div>
                        <div className={`text-3xl font-mono font-bold tabular-nums leading-none ${color}`}>
                          {delta <= 0 ? "" : "+"}{delta.toFixed(3)}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Last / Best / Distance */}
                <div className="flex gap-4 mb-3 items-end">
                  <div>
                    <span className="text-[10px] text-app-text-muted">Last </span>
                    <span className="text-sm font-mono text-app-text tabular-nums">{formatLapTime(packet.LastLap)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-app-text-muted">Best </span>
                    <span className="text-sm font-mono text-purple-400 tabular-nums">{formatLapTime(packet.BestLap)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-app-text-muted">Dist </span>
                    <span className="text-sm font-mono text-app-text tabular-nums">
                      {units.speedLabel === "km/h"
                        ? `${(packet.DistanceTraveled / 1000).toFixed(2)} km`
                        : `${(packet.DistanceTraveled / 1609.34).toFixed(2)} mi`}
                    </span>
                  </div>
                </div>

                {/* Sectors */}
                <SectorTimes packet={packet} />
              </div>
            ) : (
              <div className="flex items-center justify-center h-32 text-app-text-dim text-sm">
                Waiting for telemetry...
              </div>
            )}
          </div>

          {/* Track Map — narrow sidebar */}
          <div className="bg-app-bg" style={{ minHeight: 280 }}>
            <div className="p-2 border-b border-app-border">
              <div className="text-xs font-semibold text-app-text-muted uppercase tracking-wider truncate">
                {trackName || "Track Map"}
              </div>
            </div>
            <LiveTrackMap packet={packet} />
          </div>
        </div>

        {/* Lap Times Chart */}
        <LapTimeChart packet={packet} />

        {/* Recorded Laps */}
        {packet && (
          <div className="flex-1">
            <div className="p-2 border-b border-app-border">
              <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">
                Recorded Laps
              </h2>
            </div>
            <LapList trackOrd={trackOrd} hasTelemetry={!!packet} />
          </div>
        )}
      </div>
    </div>
  );
}
