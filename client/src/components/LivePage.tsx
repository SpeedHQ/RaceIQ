import { useTelemetryStore } from "../stores/telemetry";
import { Link } from "@tanstack/react-router";
import { useTrackName, useCarName } from "../hooks/queries";
import { useGameRoute } from "../stores/game";
import { LiveTelemetry, type DashboardMode } from "./LiveTelemetry";
import { formatLapTime } from "@/lib/format";
import { LiveTrackMap } from "./LiveTrackMap";
import { LapList } from "./LapList";
import { LapTimeChart } from "./LapTimeChart";
import { SectorTimes } from "./SectorTimes";
import { useDemoMode } from "../hooks/useDemoMode";
import { useUnits } from "../hooks/useUnits";
import { NoDataView } from "./NoDataView";

function PageHeader({ dashMode, demo }: {
  dashMode: DashboardMode;
  demo: ReturnType<typeof useDemoMode>;
}) {
  const prefix = useGameRoute();
  return (
    <div className="p-2 border-b border-app-border flex items-center justify-between">
      <div className="flex items-center gap-1 bg-app-surface-alt rounded p-0.5">
        <Link
          to={
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            `${prefix}/live/driver` as any
          }
          className={`text-[10px] font-semibold px-2 py-0.5 rounded transition-colors ${
            dashMode === "driver"
              ? "bg-app-accent/20 text-app-accent"
              : "text-app-text-muted hover:text-app-text"
          }`}
        >
          Driver
        </Link>
        <Link
          to={
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            `${prefix}/live/pit` as any
          }
          className={`text-[10px] font-semibold px-2 py-0.5 rounded transition-colors ${
            dashMode === "pitcrew"
              ? "bg-app-accent/20 text-app-accent"
              : "text-app-text-muted hover:text-app-text"
          }`}
        >
          Pit Crew
        </Link>
      </div>
      {import.meta.env.DEV && (
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
      )}
    </div>
  );
}

function RaceInfo({ packet, units, trackName, carName, showTrackMap = true, showSectors = true }: {
  packet: NonNullable<ReturnType<typeof useTelemetryStore.getState>["packet"]>;
  units: ReturnType<typeof useUnits>;
  trackName: string | undefined;
  carName: string | undefined;
  showTrackMap?: boolean;
  showSectors?: boolean;
}) {
  return (
    <div className="border-b border-app-border">
      <div className={showTrackMap ? "grid grid-cols-1 xl:grid-cols-[1fr_220px]" : ""}>
        {/* Race timing */}
        <div className={showTrackMap ? "border-r border-app-border" : ""}>
          <div className="p-2 border-b border-app-border flex items-center justify-between">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Race</h2>
            <div className="flex items-center gap-2 truncate ml-2">
              {carName && <span className="text-xs text-app-text-secondary truncate">{carName}</span>}
              {carName && trackName && <span className="text-xs text-app-text-dim">/</span>}
              {trackName && <span className="text-xs text-app-text-secondary truncate">{trackName}</span>}
            </div>
          </div>
          <div className="p-3">
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
            <div className="flex gap-4 mb-3 items-end">
              <div>
                <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Last</div>
                <div className="text-xl font-mono font-bold text-app-text tabular-nums leading-none">{formatLapTime(packet.LastLap)}</div>
              </div>
              <div>
                <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Best</div>
                <div className="text-xl font-mono font-bold text-purple-400 tabular-nums leading-none">{formatLapTime(packet.BestLap)}</div>
              </div>
              <div>
                <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Dist</div>
                <div className="text-xl font-mono font-bold text-app-text tabular-nums leading-none">
                  {units.speedLabel === "km/h"
                    ? `${(packet.DistanceTraveled / 1000).toFixed(2)} km`
                    : `${(packet.DistanceTraveled / 1609.34).toFixed(2)} mi`}
                </div>
              </div>
            </div>
            {showSectors && <SectorTimes />}
          </div>
        </div>

        {/* Track Map sidebar — only in pit crew mode */}
        {showTrackMap && (
          <div className="bg-app-bg" style={{ minHeight: 280 }}>
            <div className="p-2 border-b border-app-border">
              <div className="text-xs font-semibold text-app-text-muted uppercase tracking-wider truncate">
                {trackName || "Track Map"}
              </div>
            </div>
            <LiveTrackMap packet={packet} />
          </div>
        )}
      </div>
    </div>
  );
}

export function LivePage({ mode = "driver" }: { mode?: DashboardMode }) {
  const packet = useTelemetryStore((s) => s.packet);
  const units = useUnits();
  const serverStatus = useTelemetryStore((s) => s.serverStatus);
  const trackOrd = packet?.TrackOrdinal ?? serverStatus?.currentSession?.trackOrdinal;
  const carOrd = packet?.CarOrdinal;
  const { data: trackName } = useTrackName(trackOrd);
  const { data: carName } = useCarName(carOrd);
  const demo = useDemoMode();

  if (!packet) {
    return (
      <div className="flex-1 flex flex-col">
        <PageHeader dashMode={mode} demo={demo} />
        <NoDataView />
      </div>
    );
  }

  if (mode === "driver") {
    return (
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0 h-full">
        {/* Left column: Race + Tire Health + Pit Window */}
        <div className="border-r border-app-border overflow-auto">
          <PageHeader dashMode={mode} demo={demo} />
          <RaceInfo packet={packet} units={units} trackName={trackName} carName={carName} showTrackMap={false} showSectors={false} />
          <LiveTelemetry packet={packet} mode={mode} />
        </div>

        {/* Right column: Sectors + Lap Times + Recorded Laps */}
        <div className="overflow-y-auto overflow-x-hidden flex flex-col">
          <div className="border-b border-app-border">
            <div className="p-2 border-b border-app-border">
              <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Sectors</h2>
            </div>
            <div className="p-3">
              <SectorTimes />
            </div>
          </div>
          <LapTimeChart packet={packet} />
          <div className="flex-1">
            <div className="p-2 border-b border-app-border">
              <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Recorded Laps</h2>
            </div>
            <LapList trackOrd={trackOrd} hasTelemetry={!!packet} />
          </div>
        </div>
      </div>
    );
  }

  // ── PIT CREW MODE ─────────────────────────────────────────────
  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0 h-full">
      {/* Left column: Full telemetry */}
      <div className="border-r border-app-border overflow-auto">
        <PageHeader dashMode={mode} demo={demo} />
        <LiveTelemetry packet={packet} mode={mode} />
      </div>

      {/* Right column: Race HUD + laps */}
      <div className="overflow-auto flex flex-col">
        <RaceInfo packet={packet} units={units} trackName={trackName} carName={carName} showTrackMap={true} showSectors={true} />
        <LapTimeChart packet={packet} />
        <div className="flex-1">
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Recorded Laps</h2>
          </div>
          <LapList trackOrd={trackOrd} hasTelemetry={!!packet} />
        </div>
      </div>
    </div>
  );
}
