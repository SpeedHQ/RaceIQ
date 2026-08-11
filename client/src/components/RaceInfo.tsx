import { LiveTrackMap } from "@/components/live-track/LiveTrackMap";
import { m } from "@/paraglide/messages";
import type { LiveSectorData } from "../../../shared/racing/live/types";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { LiveTelemetryView } from "../lib/live-telemetry-view";
import { useMemo } from "react";
import { SectorTimes } from "./SectorTimes";
import { LapTimes } from "./telemetry/LapTimes";
export function RaceInfo({
  view,
  sectors,
  trackName,
  carName,
  totalLaps,
  sessionType,
  showTrackMap = true,
  showSectors = true,
}: {
  view: LiveTelemetryView;
  sectors: LiveSectorData | null;
  trackName: string | undefined;
  carName: string | undefined;
  totalLaps?: number;
  sessionType?: string;
  showTrackMap?: boolean;
  showSectors?: boolean;
}) {
  const mapPacket = useMemo(() => ({
    gameId: view.simulator,
    TrackOrdinal: view.identity.trackOrdinal ?? 0,
    LapNumber: view.timing.lapNumber ?? 0,
    DistanceTraveled: view.motion.distanceM ?? 0,
    PositionX: view.motion.position?.x ?? 0,
    PositionZ: view.motion.position?.z ?? 0,
  } as unknown as TelemetryPacket), [view]);
  return (
    <div className="border-b border-app-border">
      <div className={showTrackMap ? "grid grid-cols-1 @7xl/workspace:grid-cols-[1fr_220px]" : ""}>
        {/* Race timing */}
        <div className={showTrackMap ? "border-r border-app-border" : ""}>
          <div className="p-2 border-b border-app-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.label_race()}</h2>
              {sessionType && sessionType !== "unknown" && <span className="text-xs font-bold text-app-accent uppercase">{sessionType.replace(/-/g, " ")}</span>}
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
                <div className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.label_position()}</div>
                <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">P{view.timing.racePosition ?? "--"}</div>
              </div>
              <div>
                <div className="text-app-caption text-app-text-muted uppercase tracking-wider">Lap</div>
                <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">
                  {view.timing.lapNumber ?? "--"}
                  {totalLaps && totalLaps > 0 ? `/${totalLaps}` : ""}
                </div>
              </div>
            </div>
            <LapTimes view={view} sectors={sectors} />
            <div className="mt-3" />
            {showSectors && <SectorTimes sectors={sectors} />}
          </div>
        </div>

        {/* Track Map sidebar — only in pit crew mode */}
        {showTrackMap && (
          <div style={{ minHeight: 280 }}>
            <div className="p-2 border-b border-app-border">
              <div className="text-xs font-semibold text-app-text-muted uppercase tracking-wider truncate">{trackName || m.raceinfo_track_map_heading()}</div>
            </div>
            <LiveTrackMap packet={mapPacket} />
          </div>
        )}
      </div>
    </div>
  );
}
