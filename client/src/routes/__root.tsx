import { createRootRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import { TelemetryContext, useDisplaySettings } from "../context/telemetry";
import { ConnectionStatus } from "../components/ConnectionStatus";
import { Settings } from "../components/Settings";
import { Button } from "@/components/ui/button";
import { LivePage } from "../components/LivePage";

const TABS = [
  { to: "/", label: "Live" },
  { to: "/compare", label: "Compare" },
  { to: "/analyse", label: "Analyse" },
  { to: "/tracks", label: "Tracks" },
  { to: "/raw", label: "Raw" },
] as const;

function RootLayout() {
  const ws = useWebSocket();
  const { displaySettings, refetchSettings } = useDisplaySettings();

  useEffect(() => { refetchSettings(); }, [refetchSettings]);

  const [showSettings, setShowSettings] = useState(false);
  const isLive = useRouterState({ select: (s) => s.location.pathname === "/" });

  return (
    <TelemetryContext.Provider value={{ ...ws, displaySettings, refetchSettings }}>
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center">
            <ConnectionStatus
              connected={ws.connected}
              packetsPerSec={ws.packetsPerSec}
              forzaReceiving={ws.packetsPerSec > 0}
            />

            <div className="flex items-center gap-0 ml-4">
              {TABS.map((tab) => (
                <Link
                  key={tab.to}
                  to={tab.to}
                  className="px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors"
                  activeProps={{
                    className: "px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors border-cyan-400 text-cyan-400",
                  }}
                  inactiveProps={{
                    className: "px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors border-transparent text-slate-500 hover:text-slate-300",
                  }}
                >
                  {tab.label}
                </Link>
              ))}
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSettings(!showSettings)}
            className="mr-2 text-slate-400 hover:text-white"
          >
            {showSettings ? "Close" : "Settings"}
          </Button>
        </div>

        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/60"
               onClick={() => setShowSettings(false)}>
            <div className="max-w-md w-full max-h-[80vh] overflow-y-auto"
                 onClick={(e) => e.stopPropagation()}>
              <Settings />
            </div>
          </div>
        )}

        {/* Live page stays mounted always so state persists between tab switches */}
        <div className={isLive ? "flex-1 flex flex-col" : "hidden"}>
          <LivePage />
        </div>
        {!isLive && <Outlet />}
      </div>
    </TelemetryContext.Provider>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
