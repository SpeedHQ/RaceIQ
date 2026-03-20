import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import { useTelemetryStore } from "../stores/telemetry";
import { ThemeProvider } from "../context/theme";
import { ConnectionStatus } from "../components/ConnectionStatus";
import { Settings } from "../components/Settings";
import { Button } from "@/components/ui/button";

const TABS = [
  { to: "/", label: "Live" },
  { to: "/compare", label: "Compare" },
  { to: "/analyse", label: "Analyse" },
  { to: "/tracks", label: "Tracks" },
  { to: "/tunes", label: "Tunes" },
  { to: "/setup", label: "Setup" },
  { to: "/raw", label: "Raw" },
] as const;

function RootLayout() {
  useWebSocket();
  const { connected, packetsPerSec, refetchSettings } = useTelemetryStore();

  useEffect(() => { refetchSettings(); }, [refetchSettings]);

  const [showSettings, setShowSettings] = useState(false);

  return (
    <ThemeProvider>
        <div className="h-screen grid grid-rows-[auto_1fr] bg-app-bg text-app-text">
          <div className="flex items-center justify-between border-b border-app-border">
            <div className="flex items-center">
              <ConnectionStatus
                connected={connected}
                packetsPerSec={packetsPerSec}
                forzaReceiving={packetsPerSec > 0}
              />

              <div className="flex items-center gap-0 ml-4">
                {TABS.map((tab) => (
                  <Link
                    key={tab.to}
                    to={tab.to}
                    className="px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors"
                    activeProps={{
                      className: "px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors border-app-accent text-app-accent",
                    }}
                    inactiveProps={{
                      className: "px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors border-transparent text-app-text-muted hover:text-app-text-secondary",
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
              className="mr-2 text-app-text-secondary hover:text-app-text"
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

          <div className="min-h-0 overflow-y-auto">
            <Outlet />
          </div>
        </div>
    </ThemeProvider>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
