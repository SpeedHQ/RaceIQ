import { getAllGames } from "@shared/games/registry";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, Outlet, useLocation } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { OnboardingModal } from "@/components/onboarding/OnboardingModal";
import { Settings } from "@/components/settings/Settings";
import { useSettings } from "@/hooks/settings";
import { applyLocale } from "@/lib/locale";
import { m } from "@/paraglide/messages";
import { getLocale, isLocale } from "@/paraglide/runtime";
import { AppSidebar } from "../components/AppSidebar";
import { OnboardingModal } from "../components/Onboarding";
import { Settings } from "../components/Settings";
import { StaleLapReprocessing } from "../components/StaleLapReprocessing";
import { UpdateModal } from "../components/UpdateModal";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { isNarrowViewport } from "../hooks/useNarrowViewport";
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

export function MobileNotSupported({ feature = m.root_this_view() }: { feature?: string }) {

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
      // Prompt only when portrait width cannot support desktop-only views.
      setShow(h > w && isNarrowViewport(w));
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
        <ResponsiveWorkspace className="overflow-hidden">
          <Outlet key={uiLocale} />
        </ResponsiveWorkspace>
      </div>
    );
  }

  return (
    <>
      <div className="@container/shell flex h-screen min-h-0 bg-app-bg text-app-text">
        <aside className="hidden h-full shrink-0 @3xl/shell:block">
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
          <header className="flex min-h-14 items-center justify-between border-b border-app-border px-3 @3xl/shell:hidden">
            <span className="text-sm font-semibold text-app-text">RaceIQ</span>
            <button type="button" onClick={() => setMobileNavOpen(true)} className="p-3 text-app-text-secondary hover:text-app-text" aria-label="Open navigation">
              <Menu className="size-6" />
            </button>
          </header>
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <ResponsiveWorkspace>
              <Outlet key={uiLocale} />
            </ResponsiveWorkspace>
          </main>
        </div>

        {mobileNavOpen && (
          <div className="fixed inset-0 z-50 flex justify-end @3xl/shell:hidden">
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
          <div className="fixed inset-0 z-50 flex items-stretch justify-center @3xl/shell:items-start @3xl/shell:py-12">
            <Button type="button" variant="app-ghost" size="content" aria-label="Dismiss settings" onClick={closeSettings} className="absolute inset-0 bg-app-bg/60" />
            <div className="relative h-full w-full overflow-hidden bg-app-bg @3xl/shell:max-w-2xl @3xl/shell:rounded-lg @3xl/shell:border @3xl/shell:border-app-border">
              <div className="flex items-center justify-between border-b border-app-border bg-app-surface px-4 py-3">
                <h1 className="text-app-heading font-semibold text-app-text">{m.nav_settings()}</h1>
                <Button type="button" aria-label="Close settings" onClick={closeSettings} className="text-app-heading leading-none text-app-text-muted hover:text-app-text">
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
      <StaleLapReprocessing />
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
