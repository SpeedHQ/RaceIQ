import { createRootRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { useState, useMemo, useEffect, useRef } from "react";
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
import { Settings2, RefreshCw, X, Menu } from "lucide-react";
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

export function MobileNotSupported({ feature = "This view" }: { feature?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const shortEdge = Math.min(w, h);
      setShow(shortEdge <= 768);
    };
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  if (!show) return null;

  return (
    <div className="flex-1 flex items-center justify-center p-8 text-center">
      <div className="max-w-sm flex flex-col items-center gap-3">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-app-accent">
          <rect x="3" y="4" width="18" height="14" rx="2" />
          <path d="M8 20h8" />
        </svg>
        <div className="text-base font-semibold text-app-text">Desktop required</div>
        <div className="text-sm text-app-text-muted">
          {feature} isn't supported on mobile yet. Open RaceIQ on a tablet or desktop to use it.
        </div>
      </div>
    </div>
  );
}

export function RotatePrompt() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Prompt when the device is phone-sized (short edge <= 768) and in portrait.
      const shortEdge = Math.min(w, h);
      setShow(h > w && shortEdge <= 768);
    };
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  const [dismissed, setDismissed] = useState(false);
  if (!show || dismissed) return null;

  return (
    <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-6 pointer-events-none">
      <div
        className="relative w-full max-w-sm rounded-xl border border-app-border bg-app-surface p-6 shadow-2xl text-center pointer-events-auto"
      >
        <button
          onClick={() => setDismissed(true)}
          className="absolute top-2 right-2 p-1 text-app-text-muted hover:text-app-text"
          aria-label="Dismiss"
        >
          <X className="size-4" />
        </button>
        <div className="flex flex-col items-center gap-3">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-app-accent animate-pulse">
            <rect x="5" y="2" width="14" height="20" rx="2" />
            <path d="M12 18h.01" />
            <path d="M3 12 L8 9 L8 15 Z" fill="currentColor" />
          </svg>
          <div className="text-base font-semibold text-app-text">Rotate your device</div>
          <div className="text-sm text-app-text-muted">
            Dashboards are designed for landscape. Turn your phone sideways for the best view.
          </div>
        </div>
      </div>
    </div>
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [gameMenuOpen, setGameMenuOpen] = useState(false);
  const gameMenuRef = useRef<HTMLDivElement>(null);
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

  // Close mobile drawer on route change, but keep it open when the user
  // lands on a bare game root (e.g. /fm23) so they can pick a sub-tab next.
  useEffect(() => {
    const prefixes = getGamePrefixes();
    const onGameRoot = prefixes.some((p) => location.pathname === p || location.pathname === `${p}/`);
    if (!onGameRoot) setMobileNavOpen(false);
    setGameMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!gameMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (gameMenuRef.current && !gameMenuRef.current.contains(e.target as Node)) setGameMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [gameMenuOpen]);

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

  // Active game sub-tab (for the tablet <select> dropdown)
  const activeGameTab = useMemo(() => {
    return gameTabs.find((t) => location.pathname.startsWith(t.to))?.to ?? gameTabs[0]?.to ?? "";
  }, [gameTabs, location.pathname]);

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
          <div className="flex items-stretch justify-between border-b border-app-border min-h-14 lg:min-h-0">
            <div className="flex items-center min-w-0 flex-1">
              <ConnectionStatus
                connected={connected}
                packetsPerSec={packetsPerSec}
                forzaReceiving={isRaceOn && packetsPerSec > 0}
              />

              <div className="hidden md:block w-px h-4 bg-app-border mx-2" />

              {/* Desktop tabs (global, md+) */}
              <div className="hidden md:flex items-center gap-0 min-w-0">
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

                    {/* Inline game sub-tabs at lg+ */}
                    <div className="hidden lg:flex items-center gap-0">
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
                    </div>

                    {/* Dropdown for game sub-tabs at md-lg */}
                    <div ref={gameMenuRef} className="lg:hidden relative self-center">
                      <button
                        type="button"
                        onClick={() => setGameMenuOpen((o) => !o)}
                        className="flex items-center gap-1.5 bg-app-surface border border-app-border rounded px-2 py-1 text-xs font-semibold uppercase tracking-wider text-app-text hover:border-app-accent"
                      >
                        <span>{gameTabs.find((t) => t.to === activeGameTab)?.label ?? ""}</span>
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {gameMenuOpen && (
                        <div className="absolute left-0 top-full mt-1 w-44 bg-app-surface border border-app-border rounded-lg shadow-lg z-50 overflow-hidden">
                          {gameTabs.map((tab) => (
                            <Link
                              key={tab.to}
                              to={tab.to}
                              onClick={() => setGameMenuOpen(false)}
                              className={`block px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${tab.to === activeGameTab ? "text-app-accent bg-app-accent/10" : "text-app-text hover:bg-app-surface-alt"}`}
                            >
                              {tab.label}
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 mr-2 shrink-0">
              {updateState?.updateAvailable && (
                <button
                  onClick={() => setShowUpdateModal(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-400/15 text-yellow-400 border border-yellow-400/30 hover:bg-yellow-400/25 transition-colors"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
                  <span className="hidden sm:inline">Update available</span>
                  <span className="sm:hidden">Update</span>
                </button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => showSettings ? closeSettings() : openSettings()}
                aria-label="Settings"
                className="hidden md:flex text-app-text-secondary hover:text-app-text items-center gap-1.5"
              >
                <span className="hidden sm:inline">{driverName || "Settings"}</span>
                <Settings2 className="size-3.5 text-app-text-muted" />
              </Button>

              {/* Hamburger (mobile only, right side) */}
              <button
                onClick={() => setMobileNavOpen(true)}
                className="md:hidden p-3 text-app-text-secondary hover:text-app-text"
                aria-label="Open navigation"
              >
                <Menu className="size-6" />
              </button>
            </div>
          </div>

          {/* Mobile nav drawer */}
          {mobileNavOpen && (
            <div
              className="md:hidden fixed inset-0 z-50 flex justify-end"
              onClick={() => setMobileNavOpen(false)}
            >
              <div className="absolute inset-0 bg-black/60" />
              <nav
                className="relative w-64 max-w-[80vw] h-full bg-app-bg border-l border-app-border flex flex-col overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
                  <span className="text-sm font-semibold text-app-text">Navigation</span>
                  <button
                    onClick={() => setMobileNavOpen(false)}
                    className="p-1 text-app-text-muted hover:text-app-text"
                    aria-label="Close navigation"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div className="py-2">
                  {globalTabs.map((tab) => (
                    <Link
                      key={tab.to}
                      to={tab.to}
                      activeOptions={{ exact: tab.to === "/" }}
                      className="block px-4 py-2.5 text-sm font-semibold uppercase tracking-wider border-l-2 transition-colors"
                      activeProps={{
                        className: "block px-4 py-2.5 text-sm font-semibold uppercase tracking-wider border-l-2 transition-colors border-app-accent text-app-accent bg-app-accent/10",
                      }}
                      inactiveProps={{
                        className: "block px-4 py-2.5 text-sm font-semibold uppercase tracking-wider border-l-2 transition-colors border-transparent text-app-text-muted hover:text-app-text",
                      }}
                    >
                      {tab.label}
                    </Link>
                  ))}

                  {gameTabs.length > 0 && (
                    <>
                      <div className="mx-4 my-2 border-t border-app-border" />
                      <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-app-text-dim">This game</div>
                      {gameTabs.map((tab) => (
                        <Link
                          key={tab.to}
                          to={tab.to}
                          activeOptions={{ exact: false }}
                          className="block px-4 py-2.5 text-sm font-semibold uppercase tracking-wider border-l-2 transition-colors"
                          activeProps={{
                            className: "block px-4 py-2.5 text-sm font-semibold uppercase tracking-wider border-l-2 transition-colors border-app-accent text-app-accent bg-app-accent/10",
                          }}
                          inactiveProps={{
                            className: "block px-4 py-2.5 text-sm font-semibold uppercase tracking-wider border-l-2 transition-colors border-transparent text-app-text-muted hover:text-app-text",
                          }}
                        >
                          {tab.label}
                        </Link>
                      ))}
                    </>
                  )}

                  <div className="mx-4 my-2 border-t border-app-border" />
                  <button
                    onClick={() => {
                      setMobileNavOpen(false);
                      openSettings();
                    }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold uppercase tracking-wider border-l-2 border-transparent text-app-text-muted hover:text-app-text"
                  >
                    <Settings2 className="size-4" />
                    <span>{driverName || "Settings"}</span>
                  </button>
                </div>
              </nav>
            </div>
          )}

          {showSettings && (
            <div className="fixed inset-0 z-50 flex items-stretch md:items-start justify-center md:pt-12 md:pb-12 bg-black/60"
                 onClick={() => { closeSettings(); }}>
              <div className="w-full md:max-w-2xl h-full md:rounded-lg md:border border-app-border bg-app-bg overflow-hidden shadow-2xl"
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
