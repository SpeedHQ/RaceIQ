import { Link } from "@tanstack/react-router";
import { m } from "@/paraglide/messages";
import { useCarName } from "../hooks/catalog-queries";
import { useTrackName } from "../hooks/track-queries";
import { useDemoMode } from "../hooks/useDemoMode";
import { useGameId, useGameRoute } from "../stores/game";
import { useTelemetryStore } from "../stores/telemetry";
import { LapTimeChart } from "./LapTimeChart";
import { type DashboardMode, LiveTelemetry } from "./LiveTelemetry";
import { NoDataView } from "./NoDataView";
import { RaceInfo } from "./RaceInfo";
import { RecordedLaps } from "./RecordedLaps";
import { Button } from "./ui/button";

function PageHeader({ dashMode, demo }: { dashMode: DashboardMode; demo: ReturnType<typeof useDemoMode> }) {
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
          aria-current={dashMode === "driver" ? "page" : undefined}
          className={`text-app-caption font-semibold px-2 py-0.5 rounded transition-colors ${dashMode === "driver" ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text"}`}
        >
          {m.label_driver()}
        </Link>
        <Link
          to={
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            `${prefix}/live/pit` as any
          }
          aria-current={dashMode === "pitcrew" ? "page" : undefined}
          className={`text-app-caption font-semibold px-2 py-0.5 rounded transition-colors ${dashMode === "pitcrew" ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text"}`}
        >
          {m.label_pit_crew()}
        </Link>
      </div>
      {import.meta.env.DEV && (
        <Button
          variant="app-ghost"
          size="app-sm"
          onClick={demo.toggle}
          disabled={demo.loading}
          className={`!border font-mono font-semibold ${
            demo.active
              ? "bg-status-warning/20 border-status-warning/50 text-status-warning hover:bg-status-warning/30"
              : demo.loading
                ? "border-app-border text-app-text-dim cursor-wait"
                : "border-app-border text-app-text-muted hover:text-app-text hover:border-app-border-hover"
          }`}
        >
          {demo.loading ? "Loading..." : demo.active ? "Stop Demo" : "Demo"}
        </Button>
      )}
    </div>
  );
}

export function ForzaLiveDashboard({ mode = "driver" }: { mode?: DashboardMode }) {
  const packet = useTelemetryStore((s) => s.packet);
  const serverStatus = useTelemetryStore((s) => s.serverStatus);
  const sessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const sectors = useTelemetryStore((s) => s.sectors);
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
      <div data-live-dashboard-layout className="grid h-auto flex-1 grid-cols-1 gap-0 @5xl/workspace:h-full @5xl/workspace:grid-cols-2">
        {/* Left column: Tire Health + Pit Window */}
        <div className="min-w-0 border-r border-app-border overflow-auto">
          <PageHeader dashMode={mode} demo={demo} />
          <LiveTelemetry packet={packet} mode={mode} />
        </div>

        {/* Right column: Race (with sectors) + Lap Chart + Recorded Laps */}
        <div data-live-dashboard-race className="min-w-0 overflow-y-auto overflow-x-hidden flex flex-col">
          <RaceInfo packet={packet} sectors={sectors} trackName={trackName} carName={carName} showTrackMap={false} showSectors={true} />
          <div className="shrink-0 h-[240px]">
            <LapTimeChart sessionLaps={sessionLaps} />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <RecordedLaps laps={sessionLaps} />
          </div>
        </div>
      </div>
    );
  }

  // ── PIT CREW MODE ─────────────────────────────────────────────
  return (
    <div data-live-dashboard-layout className="grid h-auto flex-1 grid-cols-1 gap-0 @5xl/workspace:h-full @5xl/workspace:grid-cols-2">
      {/* Left column: Full telemetry */}
      <div className="min-w-0 border-r border-app-border overflow-auto">
        <PageHeader dashMode={mode} demo={demo} />
        <LiveTelemetry packet={packet} mode={mode} />
      </div>

      {/* Right column: Race HUD + laps */}
      <div data-live-dashboard-race className="min-w-0 overflow-auto flex flex-col">
        <RaceInfo packet={packet} sectors={sectors} trackName={trackName} carName={carName} showTrackMap={false} showSectors={true} />
        <div className="shrink-0 h-[240px]">
          <LapTimeChart sessionLaps={sessionLaps} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <RecordedLaps laps={sessionLaps} />
        </div>
      </div>
    </div>
  );
}
