import { useTelemetryStore } from "../stores/telemetry";
import { Link } from "@tanstack/react-router";
import { useTrackName, useCarName } from "../hooks/queries";
import { useGameId, useGameRoute } from "../stores/game";
import { LiveTelemetry, type DashboardMode } from "./LiveTelemetry";
import { RecordedLaps } from "./RecordedLaps";
import { LapTimeChart } from "./LapTimeChart";
import { useDemoMode } from "../hooks/useDemoMode";
import { NoDataView } from "./NoDataView";
import { RaceInfo } from "./RaceInfo";

function PageHeader({ dashMode, demo }: {
  dashMode: DashboardMode;
  demo: ReturnType<typeof useDemoMode>;
}) {
  const prefix = useGameRoute();
  const gameId = useGameId();

  if (gameId === "acc") return null;

  return (
    <div className="p-2 border-b border-app-border flex items-center justify-between">
      <div className="flex items-center gap-1 rounded p-0.5">
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
                ? "border-app-border text-app-text-dim cursor-wait"
                : "border-app-border text-app-text-muted hover:text-app-text hover:border-app-border-hover"
          }`}
        >
          {demo.loading ? "Loading..." : demo.active ? "Stop Demo" : "Demo"}
        </button>
      )}
    </div>
  );
}

export function ForzaLiveDashboard({ mode = "driver" }: { mode?: DashboardMode }) {
  const packet = useTelemetryStore((s) => s.packet);
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
        {/* Left column: Tire Health + Pit Window */}
        <div className="border-r border-app-border overflow-auto">
          <PageHeader dashMode={mode} demo={demo} />
          <LiveTelemetry packet={packet} mode={mode} />
        </div>

        {/* Right column: Race (with sectors) + Lap Chart + Recorded Laps */}
        <div className="overflow-y-auto overflow-x-hidden flex flex-col">
          <RaceInfo packet={packet} trackName={trackName} carName={carName} showTrackMap={false} showSectors={true} />
          <LapTimeChart packet={packet} />
          <div className="flex-1">
            <RecordedLaps />
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
        <RaceInfo packet={packet} trackName={trackName} carName={carName} showTrackMap={false} showSectors={true} />
        <LapTimeChart packet={packet} />
        <div className="flex-1">
          <RecordedLaps />
        </div>
      </div>
    </div>
  );
}
