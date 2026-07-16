import { Button } from "@/components/ui/button";
import { applyLocale } from "@/lib/locale";
import { m } from "@/paraglide/messages";
import { getLocale, isLocale } from "@/paraglide/runtime";
import { getAllGames } from "@shared/games/registry";
import { QueryClientProvider } from "@tanstack/react-query";
import { Link, Outlet, createRootRoute, useLocation } from "@tanstack/react-router";
import { Menu, RefreshCw, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectionStatus } from "../components/ConnectionStatus";
import { OnboardingModal } from "../components/Onboarding";
import { Settings } from "../components/Settings";
import { UpdateModal } from "../components/UpdateModal";
import { ThemeProvider } from "../context/theme";
import { useSettings } from "../hooks/queries";
import { useWebSocket } from "../hooks/useWebSocket";
import { useTelemetryStore } from "../stores/telemetry";
import { useUiStore } from "../stores/ui";

import { queryClient } from "../lib/queryClient";

// Canonical (English, path-stable) game sub-tab keys. The URL segment is always
// the lowercased English key; only the *display* label is localized.
const GAME_SUB_TABS = ["Live", "Sessions", "Compare", "Analyse", "Tune", "Chats", "Tracks", "Cars", "Setups", "Raw"] as const;

// Sub-tabs only exposed for certain games (auto-tune pipeline is acc/ac-evo only).
const GAME_SUB_TAB_GATE: Partial<Record<(typeof GAME_SUB_TABS)[number], readonly string[]>> = {
  Tune: ["/acc", "/ac-evo"],
};

const SUB_TAB_LABELS: Record<(typeof GAME_SUB_TABS)[number], () => string> = {
  Live: m.tab_live,
  Sessions: m.label_sessions,
  Compare: m.label_compare,
  Analyse: m.label_analyse,
  Tune: () => "Lap Engineer",
  Chats: m.tab_chats,
  Tracks: m.label_tracks,
  Cars: m.label_cars,
  Setups: m.tab_setups,
  Raw: m.tab_raw,
};

let _gamePrefixes: string[] | null = null;
function getGamePrefixes() {
  if (_gamePrefixes === null) {
    _gamePrefixes = getAllGames().map((g) => `/${g.routePrefix}`);
  }
  return _gamePrefixes;
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
          <h2 className="text-sm font-semibold text-white flex-1">{complete ? m.root_reprocessing_complete() : m.root_reprocessing()}</h2>
          {complete && (
            <button type="button" onClick={onClose} className="text-white/40 hover:text-white/70 transition-colors" aria-label="Close">
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="mb-3 h-2 w-full rounded-full bg-white/10 overflow-hidden">
          <div className="h-full rounded-full bg-blue-500 transition-all duration-300" style={{ width: `${percent}%` }} />
        </div>
        <div className="flex justify-between text-xs text-white/40">
          <span>
            {done} / {total} sessions
          </span>
          <span>{percent}%</span>
        </div>
        {complete && <p className="mt-3 text-xs text-green-400 text-center">{m.root_all_sessions_updated()}</p>}
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
            <span className="text-sm font-semibold text-app-text">{m.root_lap_detection_updated()}</span>
          </div>
          <p className="text-xs text-app-text-muted mb-3">
            {staleLapDetection.sessionCount} session{staleLapDetection.sessionCount !== 1 ? "s were" : " was"} recorded with an older lap detector. Reparsing will improve lap boundaries and timing
            accuracy.
          </p>
          <button
            type="button"
            onClick={handleReprocess}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 text-blue-300 transition-colors"
          >
            <RefreshCw className="size-3" />
            Reparse {staleLapDetection.sessionCount} session{staleLapDetection.sessionCount !== 1 ? "s" : ""}
          </button>
        </div>
      )}
      {reprocessProgress && <ReprocessProgressModal total={reprocessProgress.total} done={reprocessProgress.done} onClose={handleDismissModal} />}
    </>
  );
}

export function MobileNotSupported({ feature = m.root_this_view() }: { feature?: string }) {
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
        <div className="text-base font-semibold text-app-text">{m.root_desktop_required()}</div>
        <div className="text-sm text-app-text-muted">
          {feature} {m.root_mobile_not_supported()}
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
      <div className="relative w-full max-w-sm rounded-xl border border-app-border bg-app-surface p-6 shadow-2xl text-center pointer-events-auto">
        <button type="button" onClick={() => setDismissed(true)} className="absolute top-2 right-2 p-1 text-app-text-muted hover:text-app-text" aria-label="Dismiss">
          <X className="size-4" />
        </button>
        <div className="flex flex-col items-center gap-3">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-app-accent animate-pulse">
            <rect x="5" y="2" width="14" height="20" rx="2" />
            <path d="M12 18h.01" />
            <path d="M3 12 L8 9 L8 15 Z" fill="currentColor" />
          </svg>
          <div className="text-base font-semibold text-app-text">{m.root_rotate_device()}</div>
          <div className="text-sm text-app-text-muted">{m.root_rotate_landscape()}</div>
        </div>
      </div>
    </div>
  );
}

function AppShell() {
  useWebSocket();
  const { displaySettings, settingsLoaded } = useSettings();
  const driverName = displaySettings.driverName || "";

  // Bootstrap the Paraglide UI locale from the server-persisted `language`
  // setting (the source of truth — the AI needs it server-side anyway). No
  // reload here: this only runs when the stored language differs from the
  // runtime locale (first load / cross-device), and the picker itself reloads.
  const settingsLanguage = displaySettings.language;
  const uiLocale = useUiStore((s) => s.uiLocale);
  useEffect(() => {
    if (!settingsLoaded || !settingsLanguage || !isLocale(settingsLanguage)) return;
    if (getLocale() !== settingsLanguage) applyLocale(settingsLanguage);
  }, [settingsLoaded, settingsLanguage]);
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
  const globalTabs = useMemo(
    () => [
      { to: "/", label: m.nav_home() },
      ...getAllGames()
        .filter((g) => !hiddenGames.includes(g.id))
        .map((g) => ({ to: `/${g.routePrefix}`, label: g.shortName })),
      { to: "/dash", label: m.nav_dash() },
      ...(import.meta.env.DEV ? [{ to: "/dev", label: m.nav_dev() }] : []),
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
    // uiLocale: recompute labels when the language changes (no reload).
    [hiddenGamesKey, uiLocale],
  );

  // Determine which game-specific tabs to show based on current route
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const gameTabs = useMemo(() => {
    const prefix = getGamePrefixes().find((p) => location.pathname.startsWith(p));
    if (!prefix) return [];
    // Every game exposes a "Setups" tab: fm23/acc/ac-evo show the tune browser
    // (Forza also folds its wheel/FFB catalogue in as a sub-tab), f125 shows a
    // placeholder. No per-game gating needed.
    return GAME_SUB_TABS.filter((key) => {
      const gate = GAME_SUB_TAB_GATE[key];
      return !gate || gate.includes(prefix);
    }).map((key) => ({ to: `${prefix}/${key.toLowerCase()}`, label: SUB_TAB_LABELS[key]() }));
  }, [location.pathname, uiLocale]);

  // Active game sub-tab (for the tablet <select> dropdown)
  const activeGameTab = useMemo(() => {
    return gameTabs.find((t) => location.pathname.startsWith(t.to))?.to ?? gameTabs[0]?.to ?? "";
  }, [gameTabs, location.pathname]);

  // Hide nav only on individual dashes (/dash/combo-1 etc.) — the catalogue
  // at /dash keeps the main app chrome.
  const isDash = location.pathname.startsWith("/dash/");

  // Block rendering until settings load, then show onboarding if needed
  if (!settingsLoaded) {
    return (
      <ThemeProvider>
        <div className="h-screen bg-app-bg" />
      </ThemeProvider>
    );
  }

  const forceWelcome = new URLSearchParams(window.location.search).has("welcome");
  if (forceWelcome || !displaySettings.onboardingComplete) {
    return (
      <ThemeProvider>
        <OnboardingModal />
      </ThemeProvider>
    );
  }

  // Minimal-chrome mode for /dash/* routes — no nav, no header.
  if (isDash) {
    return (
      <ThemeProvider>
        <div className="h-screen bg-black text-app-text">
          <Outlet key={uiLocale} />
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <div className="h-screen grid grid-rows-[auto_1fr] bg-app-bg text-app-text">
        <div className="flex items-stretch justify-between border-b border-app-border min-h-14 lg:min-h-0">
          <div className="flex items-center min-w-0 flex-1">
            <ConnectionStatus connected={connected} packetsPerSec={packetsPerSec} forzaReceiving={isRaceOn && packetsPerSec > 0} />

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
                type="button"
                onClick={() => setShowUpdateModal(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-400/15 text-yellow-400 border border-yellow-400/30 hover:bg-yellow-400/25 transition-colors"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
                <span className="hidden sm:inline">{m.root_update_available()}</span>
                <span className="sm:hidden">{m.root_update_short()}</span>
              </button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => (showSettings ? closeSettings() : openSettings())}
              aria-label={driverName ? `${m.nav_settings()} (${driverName})` : m.nav_settings()}
              className="hidden md:flex text-app-text-secondary hover:text-app-text items-center gap-1.5"
            >
              <span className="hidden sm:inline">{driverName || m.nav_settings()}</span>
              <Settings2 className="size-3.5 text-app-text-muted" />
            </Button>

            {/* Hamburger (mobile only, right side) */}
            <button type="button" onClick={() => setMobileNavOpen(true)} className="md:hidden p-3 text-app-text-secondary hover:text-app-text" aria-label="Open navigation">
              <Menu className="size-6" />
            </button>
          </div>
        </div>

        {/* Mobile nav drawer */}
        {mobileNavOpen && (
          <div className="md:hidden fixed inset-0 z-50 flex justify-end" onClick={() => setMobileNavOpen(false)}>
            <div className="absolute inset-0 bg-black/60" />
            <nav className="relative w-64 max-w-[80vw] h-full bg-app-bg border-l border-app-border flex flex-col overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
                <span className="text-sm font-semibold text-app-text">{m.nav_navigation()}</span>
                <button type="button" onClick={() => setMobileNavOpen(false)} className="p-1 text-app-text-muted hover:text-app-text" aria-label="Close navigation">
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
                    <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-app-text-dim">{m.nav_this_game()}</div>
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
                  type="button"
                  onClick={() => {
                    setMobileNavOpen(false);
                    openSettings();
                  }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold uppercase tracking-wider border-l-2 border-transparent text-app-text-muted hover:text-app-text"
                >
                  <Settings2 className="size-4" />
                  <span>{driverName || m.nav_settings()}</span>
                </button>
              </div>
            </nav>
          </div>
        )}

        {showSettings && (
          <div
            className="fixed inset-0 z-50 flex items-stretch md:items-start justify-center md:pt-12 md:pb-12 bg-black/60"
            onClick={() => {
              closeSettings();
            }}
          >
            <div className="w-full md:max-w-2xl h-full md:rounded-lg md:border border-app-border bg-app-bg overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-app-border bg-app-surface">
                <h1 className="text-sm font-semibold text-app-text">{m.nav_settings()}</h1>
                <button
                  type="button"
                  onClick={() => {
                    closeSettings();
                  }}
                  className="text-app-text-muted hover:text-app-text text-lg leading-none"
                >
                  &times;
                </button>
              </div>
              <div className="h-[calc(100%-3rem)]">
                <Settings
                  initialSection={settingsSection as "games" | "ai" | "updates" | "about" | undefined}
                  onClose={() => {
                    closeSettings();
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {(showUpdateModal || updateProgress) && <UpdateModal version={updateState?.latest ?? "?"} newReleases={updateState?.newReleases ?? []} onClose={() => setShowUpdateModal(false)} />}

        {onboardingOpen && <OnboardingModal onClose={closeOnboarding} />}

        <div className="min-h-0 overflow-y-auto">
          <Outlet key={uiLocale} />
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
