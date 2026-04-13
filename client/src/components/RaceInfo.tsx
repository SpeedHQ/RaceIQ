import { useTelemetryStore } from "../stores/telemetry";
import { LiveTrackMap } from "./LiveTrackMap";
import { LapTimes } from "./telemetry/LapTimes";
import { SectorTimes } from "./SectorTimes";

export function RaceInfo({ packet, trackName, carName, totalLaps, sessionType, showTrackMap = true, showSectors = true }: {
  packet: NonNullable<ReturnType<typeof useTelemetryStore.getState>["packet"]>;
  trackName: string | undefined;
  carName: string | undefined;
  totalLaps?: number;
  sessionType?: string;
  showTrackMap?: boolean;
  showSectors?: boolean;
}) {
  const sectors = useTelemetryStore((s) => s.sectors);
  return (
    <div className="border-b border-app-border">
      <div className={showTrackMap ? "grid grid-cols-1 xl:grid-cols-[1fr_220px]" : ""}>
        {/* Race timing */}
        <div className={showTrackMap ? "border-r border-app-border" : ""}>
          <div className="p-2 border-b border-app-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Race</h2>
              {sessionType && sessionType !== "unknown" && (
                <span className="text-xs font-bold text-app-accent uppercase">{sessionType.replace(/-/g, " ")}</span>
              )}
            </div>
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
                  {packet.LapNumber}{totalLaps && totalLaps > 0 ? `/${totalLaps}` : ""}
                </div>
              </div>
            </div>
            <LapTimes packet={packet} sectors={sectors} />
            <div className="mt-3" />
            {showSectors && <SectorTimes />}
          </div>
        </div>

        {/* Track Map sidebar — only in pit crew mode */}
        {showTrackMap && (
          <div style={{ minHeight: 280 }}>
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
