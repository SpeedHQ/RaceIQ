import { createRootRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useWebSocket } from "../hooks/useWebSocket";
import { useTelemetryStore } from "../stores/telemetry";
import { useUiStore } from "../stores/ui";
import { useSettings } from "../hooks/queries";
import { ThemeProvider } from "../context/theme";
import { ConnectionStatus } from "../components/ConnectionStatus";
import { Settings } from "../components/Settings";
import { UpdateModal } from "../components/UpdateModal";
import { OnboardingModal } from "../components/Onboarding";
import { Button } from "@/components/ui/button";
import { Settings2, RefreshCw, X } from "lucide-react";
import { getAllGames } from "@shared/games/registry";

import { queryClient } from "../lib/queryClient";

const GAME_SUB_TABS = ["Live", "Sessions", "Compare", "Analyse", "Chats", "Tracks", "Cars", "Tunes", "Setup", "Raw"] as const;

let _gamePrefixes: string[] | null = null;
function getGamePrefixes() {
  return _gamePrefixes ??= getAllGames().map((g) => `/${g.routePrefix}`);
}

function useUpdateCheck() {
  return useTelemetryStore((s) => s.versionInfo);
}

function ReprocessProgressModal({ total, done, onClose }: { total: number; done: number; onClose: () => void }) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const complete = done >= total;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-96 rounded-xl border border-white/10 bg-[#1a1a1a] p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <RefreshCw className={`size-5 text-blue-400 ${complete ? "" : "animate-spin"}`} />
          <h2 className="text-sm font-semibold text-white flex-1">
            {complete ? "Reprocessing complete" : "Reprocessing sessions…"}
          </h2>
          {complete && (
            <button onClick={onClose} className="text-white/40 hover:text-white/70 transition-colors" aria-label="Close">
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="mb-3 h-2 w-full rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-white/40">
          <span>{done} / {total} sessions</span>
          <span>{percent}%</span>
        </div>
        {complete && (
          <p className="mt-3 text-xs text-green-400 text-center">All sessions updated.</p>
        )}
      </div>
    </div>
  );
}

function StaleLapButton() {
  const staleLapDetection = useTelemetryStore((s) => s.staleLapDetection);
  const setStaleLapDetection = useTelemetryStore((s) => s.setStaleLapDetection);
  const reprocessProgress = useTelemetryStore((s) => s.reprocessProgress);
  const setReprocessProgress = useTelemetryStore((s) => s.setReprocessProgress);

  if (!staleLapDetection && !reprocessProgress) return null;

  const handleReprocess = async () => {
    const total = staleLapDetection!.sessionCount;
    setReprocessProgress({ done: 0, total });
    setStaleLapDetection(null);
    try {
      await fetch("/api/sessions/reprocess-stale", { method: "POST" });
    } finally {
      // Modal auto-closes via useEffect when done >= total
    }
  };

  const handleDismissModal = () => setReprocessProgress(null);

  return (
    <>
      {staleLapDetection && (
        <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg bg-app-surface border border-blue-500/30 shadow-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw className="size-4 text-blue-400 shrink-0" />
            <span className="text-sm font-semibold text-app-text">Lap detection updated</span>
          </div>
          <p className="text-xs text-app-text-muted mb-3">
            {staleLapDetection.sessionCount} session{staleLapDetection.sessionCount !== 1 ? "s were" : " was"} recorded with an older lap detector. Reparsing will improve lap boundaries and timing accuracy.
          </p>
          <button
            onClick={handleReprocess}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 text-blue-300 transition-colors"
          >
            <RefreshCw className="size-3" />
            Reparse {staleLapDetection.sessionCount} session{staleLapDetection.sessionCount !== 1 ? "s" : ""}
          </button>
        </div>
      )}
      {reprocessProgress && (
        <ReprocessProgressModal
          total={reprocessProgress.total}
          done={reprocessProgress.done}
          onClose={handleDismissModal}
        />
      )}
    </>
  );
}

function AppShell() {
  useWebSocket();
  const { displaySettings, settingsLoaded } = useSettings();
  const driverName = displaySettings.driverName || "";
  const connected = useTelemetryStore((s) => s.connected);
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const isRaceOn = useTelemetryStore((s) => s.isRaceOn);
  const updateState = useUpdateCheck();

  const { settingsOpen: showSettings, settingsSection, openSettings, closeSettings, onboardingOpen, closeOnboarding } = useUiStore();
  const [showUpdateModal, setShowUpdateModal] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("update")) {
      // Clean up the URL
      params.delete("update");
      const clean = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (clean ? `?${clean}` : ""));
      return true;
    }
    return false;
  });
  const updateProgress = useTelemetryStore((s) => s.updateProgress);
  const location = useLocation();

  // Global nav tabs — filtered by user's hidden games preference
  const hiddenGames: string[] = displaySettings.hiddenGames ?? [];
  const hiddenGamesKey = hiddenGames.join(",");
  const globalTabs = useMemo(() => [
    { to: "/", label: "Home" },
    ...getAllGames()
      .filter((g) => !hiddenGames.includes(g.id))
      .map((g) => ({ to: `/${g.routePrefix}`, label: g.shortName })),
    { to: "/dash", label: "Dash" },
    ...(import.meta.env.DEV ? [{ to: "/dev", label: "Dev" }] : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [hiddenGamesKey]);

  // Determine which game-specific tabs to show based on current route
  const gameTabs = useMemo(() => {
    const prefix = getGamePrefixes().find((p) => location.pathname.startsWith(p));
    if (!prefix) return [];
    const hideTunes = prefix !== "/fm23"; // only fm23 has a Tunes tab; other games put setups in the Tracks tab
    const hideSetup = prefix === "/ac-evo";
    return GAME_SUB_TABS
      .filter((label) => !(hideTunes && label === "Tunes"))
      .filter((label) => !(hideSetup && label === "Setup"))
      .map((label) => ({ to: `${prefix}/${label.toLowerCase()}`, label }));
  }, [location.pathname]);

  // Hide nav only on individual dashes (/dash/combo-1 etc.) — the catalogue
  // at /dash keeps the main app chrome.
  const isDash = location.pathname.startsWith("/dash/");

  // Block rendering until settings load, then show onboarding if needed
  if (!settingsLoaded) {
    return <ThemeProvider><div className="h-screen bg-app-bg" /></ThemeProvider>;
  }

  const forceWelcome = new URLSearchParams(window.location.search).has("welcome");
  if (forceWelcome || !displaySettings.onboardingComplete) {
    return <ThemeProvider><OnboardingModal /></ThemeProvider>;
  }

  // Minimal-chrome mode for /dash/* routes — no nav, no header.
  if (isDash) {
    return (
      <ThemeProvider>
        <div className="h-screen bg-black text-app-text">
          <Outlet />
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
        <div className="h-screen grid grid-rows-[auto_1fr] bg-app-bg text-app-text">
          <div className="flex items-center justify-between border-b border-app-border">
            <div className="flex items-center">
              <ConnectionStatus
                connected={connected}
                packetsPerSec={packetsPerSec}
                forzaReceiving={isRaceOn && packetsPerSec > 0}
              />

              <div className="w-px h-4 bg-app-border mx-2" />

              <div className="flex items-center gap-0">
                {globalTabs.map((tab) => (
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
              {updateState?.updateAvailable && (
                <button
                  onClick={() => setShowUpdateModal(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-400/15 text-yellow-400 border border-yellow-400/30 hover:bg-yellow-400/25 transition-colors"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
                  Update available
                </button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => showSettings ? closeSettings() : openSettings()}
                className="text-app-text-secondary hover:text-app-text flex items-center gap-1.5"
              >
                {driverName || "Settings"}
                <Settings2 className="size-3.5 text-app-text-muted" />
              </Button>
            </div>
          </div>

          {showSettings && (
            <div className="fixed inset-0 z-50 flex items-start justify-center pt-12 pb-12 bg-black/60"
                 onClick={() => { closeSettings(); }}>
              <div className="w-full max-w-2xl h-full rounded-lg border border-app-border bg-app-bg overflow-hidden shadow-2xl"
                   onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-app-border bg-app-surface">
                  <h1 className="text-sm font-semibold text-app-text">Settings</h1>
                  <button
                    onClick={() => { closeSettings(); }}
                    className="text-app-text-muted hover:text-app-text text-lg leading-none"
                  >
                    &times;
                  </button>
                </div>
                <div className="h-[calc(100%-3rem)]">
                  <Settings initialSection={settingsSection as "games" | "ai" | "updates" | "about" | undefined} onClose={() => { closeSettings(); }} />
                </div>
              </div>
            </div>
          )}

          {(showUpdateModal || updateProgress) && (
            <UpdateModal version={updateState?.latest ?? "?"} newReleases={updateState?.newReleases ?? []} onClose={() => setShowUpdateModal(false)} />
          )}

          {onboardingOpen && <OnboardingModal onClose={closeOnboarding} />}

          <div className="min-h-0 overflow-y-auto">
            <Outlet />
          </div>
        </div>
        <StaleLapButton />
    </ThemeProvider>
  );
}

function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
