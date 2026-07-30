import { getAllGames } from "@shared/games/registry";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, Outlet, useLocation } from "@tanstack/react-router";
import { Menu, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { applyLocale } from "@/lib/locale";
import { m } from "@/paraglide/messages";
import { getLocale, isLocale } from "@/paraglide/runtime";
import { AppSidebar } from "../components/AppSidebar";
import { OnboardingModal } from "../components/Onboarding";
import { Settings } from "../components/Settings";
import { UpdateModal } from "../components/UpdateModal";
import { useSettings } from "../hooks/queries";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useWebSocket } from "../hooks/useWebSocket";
import { queryClient } from "../lib/queryClient";
import { useTelemetryStore } from "../stores/telemetry";
import { useUiStore } from "../stores/ui";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app-bg/60 backdrop-blur-sm">
      <div className="w-96 rounded-xl border border-app-border bg-app-surface p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <RefreshCw className={`size-5 text-status-info ${complete ? "" : "animate-spin"}`} />
          <h2 className="text-sm font-semibold text-app-text flex-1">{complete ? m.root_reprocessing_complete() : m.root_reprocessing()}</h2>
          {complete && (
            <button type="button" onClick={onClose} className="text-app-text-dim hover:text-app-text-secondary transition-colors" aria-label="Close">
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="mb-3 h-2 w-full rounded-full bg-app-text/10 overflow-hidden">
          <div className="h-full rounded-full bg-status-info transition-all duration-300" style={{ width: `${percent}%` }} />
        </div>
        <div className="flex justify-between text-xs text-app-text-dim">
          <span>
            {done} / {total} sessions
          </span>
          <span>{percent}%</span>
        </div>
        {complete && <p className="mt-3 text-xs text-status-success text-center">{m.root_all_sessions_updated()}</p>}
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
        <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg bg-app-surface border border-status-info/30 shadow-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw className="size-4 text-status-info shrink-0" />
            <span className="text-sm font-semibold text-app-text">{m.root_lap_detection_updated()}</span>
          </div>
          <p className="text-xs text-app-text-muted mb-3">
            {staleLapDetection.sessionCount} session{staleLapDetection.sessionCount !== 1 ? "s were" : " was"} recorded with an older lap detector. Reparsing will improve lap boundaries and timing
            accuracy.
          </p>
          <button
            type="button"
            onClick={handleReprocess}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-status-info/20 hover:bg-status-info/30 border border-status-info/30 text-status-info transition-colors"
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
  const updateProgress = useTelemetryStore((s) => s.updateProgress);
  const { settingsOpen: showSettings, settingsSection, openSettings, closeSettings, onboardingOpen, closeOnboarding } = useUiStore();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage<boolean>("raceiq-sidebar-collapsed", false);
  const [showUpdateModal, setShowUpdateModal] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("update")) return false;
    params.delete("update");
    const clean = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (clean ? `?${clean}` : ""));
    return true;
  });
  const location = useLocation();
  const hiddenGames: string[] = displaySettings.hiddenGames ?? [];

  // Close mobile drawer on route change, but keep it open when the user
  // lands on a bare game root (e.g. /fm23) so they can pick a feature next.
  useEffect(() => {
    const onGameRoot = getGamePrefixes().some((prefix) => location.pathname === prefix || location.pathname === `${prefix}/`);
    if (!onGameRoot) setMobileNavOpen(false);
  }, [location.pathname]);

  // Hide navigation only on individual dashboards (/dash/combo-1 etc.) — the
  // dashboard catalogue at /dash keeps the app shell.
  const isDash = location.pathname.startsWith("/dash/");

  if (!settingsLoaded) {
    return <div className="h-screen bg-app-bg" />;
  }

  const forceWelcome = new URLSearchParams(window.location.search).has("welcome");
  if (forceWelcome || !displaySettings.onboardingComplete) {
    return <OnboardingModal />;
  }

  if (isDash) {
    return (
      <div className="h-screen bg-app-bg text-app-text">
        <Outlet key={uiLocale} />
      </div>
    );
  }

  return (
    <>
      <div className="flex h-screen min-h-0 bg-app-bg text-app-text">
        <aside className="hidden h-full shrink-0 md:block">
          <AppSidebar
            collapsed={sidebarCollapsed}
            connected={connected}
            driverName={driverName}
            forzaReceiving={isRaceOn && packetsPerSec > 0}
            hiddenGames={hiddenGames}
            mobile={false}
            onCollapsedChange={setSidebarCollapsed}
            onOpenSettings={openSettings}
            onShowUpdate={() => setShowUpdateModal(true)}
            packetsPerSec={packetsPerSec}
            updateAvailable={updateState?.updateAvailable ?? false}
            updateVersion={updateState?.latest ?? null}
          />
        </aside>

        <div className="flex min-w-0 min-h-0 flex-1 flex-col">
          <header className="flex min-h-14 items-center justify-between border-b border-app-border px-3 md:hidden">
            <span className="text-sm font-semibold text-app-text">RaceIQ</span>
            <button type="button" onClick={() => setMobileNavOpen(true)} className="p-3 text-app-text-secondary hover:text-app-text" aria-label="Open navigation">
              <Menu className="size-6" />
            </button>
          </header>
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <Outlet key={uiLocale} />
          </main>
        </div>

        {mobileNavOpen && (
          <div className="fixed inset-0 z-50 flex justify-end md:hidden">
            <button type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} className="absolute inset-0 bg-app-bg/60" />
            <div className="relative h-full">
              <AppSidebar
                collapsed={false}
                connected={connected}
                driverName={driverName}
                forzaReceiving={isRaceOn && packetsPerSec > 0}
                hiddenGames={hiddenGames}
                mobile
                onClose={() => setMobileNavOpen(false)}
                onOpenSettings={openSettings}
                onShowUpdate={() => setShowUpdateModal(true)}
                packetsPerSec={packetsPerSec}
                updateAvailable={updateState?.updateAvailable ?? false}
                updateVersion={updateState?.latest ?? null}
              />
            </div>
          </div>
        )}

        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-stretch justify-center md:items-start md:pb-12 md:pt-12">
            <button type="button" aria-label="Close settings" onClick={closeSettings} className="absolute inset-0 bg-app-bg/60" />
            <div className="relative h-full w-full overflow-hidden bg-app-bg md:max-w-2xl md:rounded-lg md:border md:border-app-border">
              <div className="flex items-center justify-between border-b border-app-border bg-app-surface px-4 py-3">
                <h1 className="text-sm font-semibold text-app-text">{m.nav_settings()}</h1>
                <button type="button" onClick={closeSettings} className="text-lg leading-none text-app-text-muted hover:text-app-text">
                  &times;
                </button>
              </div>
              <div className="h-[calc(100%-3rem)]">
                <Settings initialSection={settingsSection as "games" | "ai" | "updates" | "about" | undefined} onClose={closeSettings} />
              </div>
            </div>
          </div>
        )}

        {(showUpdateModal || updateProgress) && <UpdateModal version={updateState?.latest ?? "?"} newReleases={updateState?.newReleases ?? []} onClose={() => setShowUpdateModal(false)} />}
        {onboardingOpen && <OnboardingModal onClose={closeOnboarding} />}
      </div>
      <StaleLapButton />
    </>
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
