import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { createContext, useContext, useMemo, useState } from "react";
import { optionalDevTrackIdentity } from "../../../lib/dev-track-routes";
import { TrackConfigurationBrowser, type TrackConfigurationSelection } from "../TrackConfigurationBrowser";

interface TrackWorkbenchContextValue {
  configurationRevision: number;
  incrementConfigurationRevision: () => void;
}

const TrackWorkbenchContext = createContext<TrackWorkbenchContextValue | null>(null);

export function useTrackWorkbenchContext(): TrackWorkbenchContextValue {
  const context = useContext(TrackWorkbenchContext);
  if (!context) throw new Error("useTrackWorkbenchContext must be used inside TrackWorkbenchLayout");
  return context;
}

export function TrackWorkbenchLayout() {
  const routeParams = useParams({ strict: false }) as { gameId?: string; trackOrdinal?: string };
  const navigate = useNavigate();
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const selection = useMemo(() => optionalDevTrackIdentity(routeParams), [routeParams.gameId, routeParams.trackOrdinal]);
  const contextValue = useMemo(() => ({ configurationRevision, incrementConfigurationRevision: () => setConfigurationRevision((revision) => revision + 1) }), [configurationRevision]);

  const handleSelect = (nextSelection: TrackConfigurationSelection) => {
    void navigate({
      to: "/dev/tracks/$gameId/$trackOrdinal",
      params: { gameId: nextSelection.gameId, trackOrdinal: String(nextSelection.trackOrdinal) },
    });
  };

  return (
    <TrackWorkbenchContext.Provider value={contextValue}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-app-bg">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-app-border bg-app-surface px-4 py-3">
          <div className="min-w-0">
            <Link to="/dev" className="text-xs text-app-text-muted hover:text-app-text">
              Developer tools
            </Link>
            <h1 className="truncate text-lg font-semibold text-app-text">Track developer workbench</h1>
          </div>
          {selection && (
            <span
              data-testid={`dev-selected-track-${selection.gameId}-${selection.trackOrdinal}`}
              className="shrink-0 rounded border border-app-border bg-app-surface-alt px-2 py-1 font-mono text-xs text-app-text-muted"
            >
              {selection.gameId} · #{selection.trackOrdinal}
            </span>
          )}
        </header>
        <div className="flex min-h-0 flex-1">
          <TrackConfigurationBrowser
            selection={selection}
            onSelect={handleSelect}
            onConfigurationChange={contextValue.incrementConfigurationRevision}
            className={selection ? "hidden @7xl/workspace:flex @7xl/workspace:w-[22rem] @7xl/workspace:shrink-0" : "w-full"}
          />
          {selection && (
            <main className="min-w-0 flex-1 overflow-y-auto">
              <div className="border-b border-app-border px-4 py-2 @7xl/workspace:hidden">
                <Link to="/dev/tracks" className="text-sm text-app-accent hover:underline">
                  Change track
                </Link>
              </div>
              <Outlet />
            </main>
          )}
        </div>
      </div>
    </TrackWorkbenchContext.Provider>
  );
}
