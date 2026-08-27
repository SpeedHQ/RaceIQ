import { getAllGames } from "@shared/games/registry";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { OnboardingModal } from "@/components/onboarding/OnboardingModal";
import { Settings } from "@/components/settings/Settings";
import { useSettings } from "@/hooks/settings";
import { applyLocale } from "@/lib/locale";
import { m } from "@/paraglide/messages";
import { getLocale, isLocale } from "@/paraglide/runtime";
import { AppSidebar } from "../components/AppSidebar";
import { RaceResultStatus } from "../components/RaceResultStatus";
import { ResponsiveWorkspace } from "../components/ResponsiveWorkspace";
import { StaleLapReprocessing } from "../components/StaleLapReprocessing";
import { UpdateModal } from "../components/UpdateModal";
import { Button } from "../components/ui/button";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useWebSocket } from "../hooks/useWebSocket";
import { queryClient } from "../lib/queryClient";
import { useTelemetryStore } from "../stores/telemetry";
import { uiStore, useUiStore } from "../stores/ui";

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
  const packetsPerSec = useTelemetryStore((s) => s.serverStatus?.telemetryPps ?? 0);
  const isRaceOn = useTelemetryStore((s) => s.isRaceOn);
  const updateState = useUpdateCheck();
  const updateAvailable = useTelemetryStore((s) => s.updateAvailable);
  const updateProgress = useTelemetryStore((s) => s.updateProgress);
  const showSettings = useUiStore((s) => s.settingsOpen);
  const settingsSection = useUiStore((s) => s.settingsSection);
  const onboardingOpen = useUiStore((s) => s.onboardingOpen);
  const { openSettings, closeSettings, closeOnboarding } = uiStore.actions;
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

  // Hide navigation only on individual portable dashboards (/portable/combo-1 etc.) — the
  // portable dashboard catalogue at /portable keeps the app shell.
  const isPortable = location.pathname.startsWith("/portable/");

  if (!settingsLoaded) {
    return <div className="h-screen bg-app-bg" />;
  }

  const forceWelcome = new URLSearchParams(window.location.search).has("welcome");
  if (forceWelcome || !displaySettings.onboardingComplete) {
    return <OnboardingModal />;
  }

  if (isPortable) {
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
            <Link to="/" className="text-sm font-semibold text-app-text transition-colors hover:text-app-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent">
              RaceIQ
            </Link>
            <Button type="button" onClick={() => setMobileNavOpen(true)} className="p-3 text-app-text-secondary hover:text-app-text" aria-label="Open navigation">
              <Menu className="size-6" />
            </Button>
          </header>
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <ResponsiveWorkspace>
              <Outlet key={uiLocale} />
            </ResponsiveWorkspace>
          </main>
        </div>

        {mobileNavOpen && (
          <div className="fixed inset-0 z-50 flex justify-end @3xl/shell:hidden">
            <Button type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} className="absolute inset-0 bg-app-bg/60" />
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
            <div className="relative h-full w-full overflow-hidden bg-app-bg @3xl/shell:max-w-4xl @3xl/shell:rounded-lg @3xl/shell:border @3xl/shell:border-app-border">
              <div className="flex items-center justify-between border-b border-app-border bg-app-surface px-4 py-3">
                <h1 className="text-app-heading font-semibold text-app-text">{m.nav_settings()}</h1>
                <Button type="button" aria-label="Close settings" onClick={closeSettings} className="text-app-heading leading-none text-app-text-muted hover:text-app-text">
                  &times;
                </Button>
              </div>
              <div className="h-[calc(100%-3rem)]">
                <Settings initialSection={settingsSection as "games" | "ai" | "updates" | "about" | undefined} onClose={closeSettings} />
              </div>
            </div>
          </div>
        )}

        {(showUpdateModal || updateProgress) && <UpdateModal version={updateState?.latest ?? updateAvailable ?? "?"} currentVersion={updateState?.current ?? "?"} newReleases={updateState?.newReleases ?? []} fullReleaseNotes={updateState?.fullReleaseNotes ?? null} currentReleaseNotes={updateState?.currentReleaseNotes ?? null} currentReleaseDate={updateState?.currentReleaseDate ?? null} onClose={() => setShowUpdateModal(false)} />}
        {onboardingOpen && <OnboardingModal onClose={closeOnboarding} />}
      </div>
      <StaleLapReprocessing />
      <RaceResultStatus compact />
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
