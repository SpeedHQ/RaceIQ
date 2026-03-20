import { useTelemetryStore } from "../stores/telemetry";
import { useStatus, useTrackName } from "../hooks/queries";
import { LiveTelemetry, formatLapTime } from "./LiveTelemetry";
import { CurrentLapStats } from "./CurrentLapStats";
import { LiveTrackMap } from "./LiveTrackMap";
import { LapList } from "./LapList";
import { LapTimeChart } from "./LapTimeChart";
import { SectorTimes } from "./SectorTimes";

export function LivePage() {
  const packet = useTelemetryStore((s) => s.packet);
  const { data: status } = useStatus();
  const trackOrd = (status as any)?.currentSession?.trackOrdinal;
  const { data: trackName } = useTrackName(trackOrd);

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0 h-full">
      <div className="border-r border-app-border overflow-auto">
        <div className="p-2 border-b border-app-border">
          <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">
            Live Telemetry
          </h2>
        </div>
        <LiveTelemetry packet={packet} />
      </div>
      <div className="overflow-auto flex flex-col">
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] border-b border-app-border">
          <div className="border-r border-app-border bg-app-bg" style={{ minHeight: 220 }}>
            <div className="p-2 border-b border-app-border flex items-center justify-between">
              <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">
                Track Map
              </h2>
              {trackName && (
                <span className="text-xs text-app-text-secondary truncate ml-2">{trackName}</span>
              )}
            </div>
            <LiveTrackMap packet={packet} />
          </div>
          <div>
            <div className="p-2 border-b border-app-border">
              <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">
                Current Lap
              </h2>
            </div>
            <CurrentLapStats packet={packet} />
          </div>
        </div>

        {packet && (
          <div className="border-b border-app-border">
            <div className="p-2 border-b border-app-border">
              <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Race Info</h2>
            </div>
            <div className="p-3">
              <div className="flex items-baseline gap-4 mb-2">
                <div>
                  <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Position</div>
                  <div className="text-2xl font-mono font-bold text-app-text tabular-nums">P{packet.RacePosition}</div>
                </div>
                <div>
                  <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Lap</div>
                  <div className="text-2xl font-mono font-bold text-app-text tabular-nums">{packet.LapNumber}</div>
                </div>
                <div className="flex-1">
                  <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Current</div>
                  <div className="text-2xl font-mono font-bold text-app-text tabular-nums">{formatLapTime(packet.CurrentLap)}</div>
                </div>
              </div>
              <div className="flex gap-4">
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
                  <span className="text-sm font-mono text-app-text tabular-nums">{(packet.DistanceTraveled / 1609.34).toFixed(2)} mi</span>
                </div>
              </div>
            </div>
          </div>
        )}

        <SectorTimes packet={packet} />
        <LapTimeChart packet={packet} />

        <div className="flex-1">
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">
              Recorded Laps
            </h2>
          </div>
          <LapList trackOrd={trackOrd} />
        </div>
      </div>
    </div>
  );
}
