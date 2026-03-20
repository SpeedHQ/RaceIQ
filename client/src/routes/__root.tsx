import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useWebSocket } from "../hooks/useWebSocket";
import { useTelemetryStore } from "../stores/telemetry";
import { ThemeProvider } from "../context/theme";
import { ConnectionStatus } from "../components/ConnectionStatus";
import { Settings } from "../components/Settings";
import { Button } from "@/components/ui/button";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

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
  const connected = useTelemetryStore((s) => s.connected);
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);

  const [showSettings, setShowSettings] = useState(false);

  return (
    <QueryClientProvider client={queryClient}>
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
            <div className="fixed inset-0 z-50 flex items-start justify-center pt-12 pb-12 bg-black/60"
                 onClick={() => setShowSettings(false)}>
              <div className="w-full max-w-2xl h-full rounded-lg border border-app-border bg-app-bg overflow-hidden shadow-2xl"
                   onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-app-border bg-app-surface">
                  <h1 className="text-sm font-semibold text-app-text">Settings</h1>
                  <button
                    onClick={() => setShowSettings(false)}
                    className="text-app-text-muted hover:text-app-text text-lg leading-none"
                  >
                    &times;
                  </button>
                </div>
                <div className="h-[calc(100%-3rem)]">
                  <Settings />
                </div>
              </div>
            </div>
          )}

          <div className="min-h-0 overflow-y-auto">
            <Outlet />
          </div>
        </div>
    </ThemeProvider>
    </QueryClientProvider>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
