import { createRootRoute, Link, Outlet, useNavigate, useLocation } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useWebSocket } from "../hooks/useWebSocket";
import { useTelemetryStore } from "../stores/telemetry";
import { ThemeProvider } from "../context/theme";
import { ConnectionStatus } from "../components/ConnectionStatus";
import { Settings } from "../components/Settings";
import { isOnboardingComplete } from "../components/Onboarding";
import { ProfileSwitcher } from "../components/ProfileSwitcher";
import { Button } from "@/components/ui/button";
import { getAllGames } from "@shared/games/registry";
import { client } from "../lib/rpc";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

const GAME_SUB_TABS = ["Live", "Sessions", "Compare", "Analyse", "Tracks", "Cars", "Tunes", "Setup", "Raw"] as const;

// Computed lazily on first call — the registry is empty at module load time
// because initGameAdapters() runs in main.tsx after route modules are imported.
let _globalTabs: { to: string; label: string }[] | null = null;
function getGlobalTabs() {
  return _globalTabs ??= [
    { to: "/", label: "Home" },
    ...getAllGames().map((g) => ({ to: `/${g.routePrefix}`, label: g.shortName })),
  ];
}

let _gamePrefixes: string[] | null = null;
function getGamePrefixes() {
  return _gamePrefixes ??= getAllGames().map((g) => `/${g.routePrefix}`);
}

function useUpdateCheck() {
  const [state, setState] = useState<{ updateAvailable: boolean; current: string; latest: string | null } | null>(null);
  useEffect(() => {
    client.api.version.$get()
      .then((r) => r.json())
      .then((d) => setState({ updateAvailable: d.updateAvailable, current: d.current, latest: d.latest }))
      .catch(() => {});
  }, []);
  return state;
}

function RootLayout() {
  useWebSocket();
  const connected = useTelemetryStore((s) => s.connected);
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const updateState = useUpdateCheck();

  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"about" | undefined>(undefined);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!isOnboardingComplete() && !location.pathname.startsWith("/onboarding")) {
      navigate({ to: "/onboarding" });
    }
  }, [location.pathname]);

  // Determine which game-specific tabs to show based on current route
  const gameTabs = useMemo(() => {
    const prefix = getGamePrefixes().find((p) => location.pathname.startsWith(p));
    if (!prefix) return [];
    const hideTunes = prefix === "/f125" || prefix === "/acc"; // setups are in Tracks tab
    return GAME_SUB_TABS
      .filter((label) => !(hideTunes && label === "Tunes"))
      .map((label) => ({ to: `${prefix}/${label.toLowerCase()}`, label }));
  }, [location.pathname]);

  return (
    <QueryClientProvider client={queryClient}>
    <ThemeProvider>
        <div className="h-screen grid grid-rows-[auto_1fr] bg-app-bg text-app-text">
          {!location.pathname.startsWith("/onboarding") && (
          <div className="flex items-center justify-between border-b border-app-border">
            <div className="flex items-center">
              <ConnectionStatus
                connected={connected}
                packetsPerSec={packetsPerSec}
                forzaReceiving={packetsPerSec > 0}
              />

              <div className="flex items-center gap-0 ml-4">
                {getGlobalTabs().map((tab) => (
                  <Link
                    key={tab.to}
                    to={tab.to}
                    activeOptions={{ exact: tab.to === "/" }}
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

                {gameTabs.length > 0 && (
                  <>
                    <div className="w-px h-4 bg-app-border mx-2" />
                    {gameTabs.map((tab) => (
                      <Link
                        key={tab.to}
                        to={tab.to}
                        activeOptions={{ exact: false }}
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
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 mr-2">
              {updateState?.updateAvailable && !showSettings && (
                <button
                  onClick={() => { setSettingsSection("about"); setShowSettings(true); }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-400/15 text-yellow-400 border border-yellow-400/30 hover:bg-yellow-400/25 transition-colors"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
                  {updateState.current} → {updateState.latest}
                </button>
              )}
              <ProfileSwitcher />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setSettingsSection(undefined); setShowSettings(!showSettings); }}
                className="text-app-text-secondary hover:text-app-text"
              >
                {showSettings ? "Close" : "Settings"}
              </Button>
            </div>
          </div>
          )}

          {showSettings && (
            <div className="fixed inset-0 z-50 flex items-start justify-center pt-12 pb-12 bg-black/60"
                 onClick={() => { setShowSettings(false); setSettingsSection(undefined); }}>
              <div className="w-full max-w-2xl h-full rounded-lg border border-app-border bg-app-bg overflow-hidden shadow-2xl"
                   onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-app-border bg-app-surface">
                  <h1 className="text-sm font-semibold text-app-text">Settings</h1>
                  <button
                    onClick={() => { setShowSettings(false); setSettingsSection(undefined); }}
                    className="text-app-text-muted hover:text-app-text text-lg leading-none"
                  >
                    &times;
                  </button>
                </div>
                <div className="h-[calc(100%-3rem)]">
                  <Settings initialSection={settingsSection} onClose={() => { setShowSettings(false); setSettingsSection(undefined); }} />
                </div>
              </div>
            </div>
          )}

          <div className={`min-h-0 overflow-y-auto ${location.pathname === "/onboarding" ? "h-full" : ""}`}>
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
