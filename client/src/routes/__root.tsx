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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
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
    <Dialog open onOpenChange={(open) => !open && complete && onClose()}>
      <DialogContent size="sm" showCloseButton={false} className="w-96 p-6">
        <DialogHeader className="mb-4 flex flex-row items-center gap-3">
          <RefreshCw className={`size-5 text-status-info ${complete ? "" : "animate-spin"}`} />
          <DialogTitle className="flex-1 text-sm font-semibold text-app-text">{complete ? m.root_reprocessing_complete() : m.root_reprocessing()}</DialogTitle>
          {complete && (
            <button type="button" onClick={onClose} className="text-app-text-dim hover:text-app-text-secondary transition-colors" aria-label="Close">
              <X className="size-4" />
            </button>
          )}
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
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
