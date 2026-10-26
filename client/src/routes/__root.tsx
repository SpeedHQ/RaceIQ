import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { SparseSplitMigration } from "../components/SparseSplitMigration";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RecordingLayoutMigration } from "../components/RecordingLayoutMigration";
import { getAllGames } from "@raceiq/shared/games/registry"
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, ErrorComponent, Link, Outlet, redirect, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { OnboardingModal } from "@/components/onboarding/OnboardingModal";
import { Settings } from "@/components/settings/Settings";
import { DashboardAuthUnavailable, loadDashboardAuth } from "@/lib/dashboard-auth";
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
import { ClassificationMigrationDock } from "../components/ClassificationMigration";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useWebSocket } from "../hooks/useWebSocket";
import { queryClient } from "../lib/queryClient";
import { telemetryStore, useTelemetryStore } from "../stores/telemetry";
import { gameIdForPathname } from "../lib/game-routes";
import { uiStore, useUiStore } from "../stores/ui";
import { GameRouteProvider, gameStore, usesStoreGameContext, useGameStore } from "../stores/game";
import { RaceIqOnlineProvider, CloudLapImportActivation } from "@raceiq/online/ui";
import { onlineUiHost } from "@/features/online-host";
import { CarsCatalogueHostProvider } from "../features/cars-catalogue-host";
import { NAV_ITEMS, type SectionId } from "@/components/settings/navigation";
import { TracksCatalogueHostProvider } from "../features/tracks-catalogue-host";
function OverlayShell() {
  useWebSocket();
  const { displaySettings, settingsLoaded } = useSettings();
  const settingsLanguage = displaySettings.language;

  useEffect(() => {
    if (!settingsLoaded || !settingsLanguage || !isLocale(settingsLanguage)) return;
    if (getLocale() !== settingsLanguage) applyLocale(settingsLanguage);
  }, [settingsLoaded, settingsLanguage]);

  useLayoutEffect(() => {
    document.documentElement.classList.add("overlay-source");
    return () => document.documentElement.classList.remove("overlay-source");
  }, []);

  return <Outlet />;
}

function isOverlayPath(pathname: string) {
  return pathname === "/overlay" || pathname === "/overlay/";
}

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
  const shellRef = useRef<HTMLDivElement>(null);
  const [layoutMigrationPrecedence, setLayoutMigrationPrecedence] = useState(false);
  const [sparseMigrationVisible, setSparseMigrationVisible] = useState(false);
  const { displaySettings, settingsLoaded } = useSettings();

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
  const liveCaptureError = useTelemetryStore((s) => s.liveCaptureError);
  const settingsSection = useUiStore((s) => s.settingsSection);
  const onboardingOpen = useUiStore((s) => s.onboardingOpen);
  const { openSettings, closeSettings: closeSettingsStore, closeOnboarding } = uiStore.actions;
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
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("settings")) return;
    const section = params.get("settings");
    openSettings(section && NAV_ITEMS.some((item) => item.id === section) ? section : undefined);
  }, [location.pathname, location.search, openSettings]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (showSettings) url.searchParams.set("settings", settingsSection && NAV_ITEMS.some((item) => item.id === settingsSection) ? settingsSection : "general");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [showSettings, settingsSection]);
  const closeSettings = () => {
    closeSettingsStore();
    const url = new URL(window.location.href);
    url.searchParams.delete("settings");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const setSettingsSection = (section: SectionId) => {
    uiStore.actions.openSettings(section);
    const url = new URL(window.location.href);
    url.searchParams.set("settings", section);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  useEffect(() => {
    if (!onboardingOpen) return;
    const url = new URL("/onboarding", window.location.origin);
    url.searchParams.set("welcome", "true");
    url.searchParams.set("step", "welcome");
    void navigate({ href: `${url.pathname}${url.search}` });
    closeOnboarding();
  }, [onboardingOpen, navigate, closeOnboarding]);
  const routeGameId = gameIdForPathname(location.pathname);
  useLayoutEffect(() => {
    if (!(routeGameId === null && usesStoreGameContext(location.pathname))) {
      gameStore.actions.setGameId(routeGameId);
    }
  }, [location.pathname, routeGameId]);
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
      <div ref={shellRef} className="@container/shell flex h-screen min-h-0 bg-app-bg text-app-text">
        <aside className="hidden h-full shrink-0 @3xl/shell:block">
          <AppSidebar
            collapsed={sidebarCollapsed}
            connected={connected}
            forzaReceiving={isRaceOn}
            hiddenGames={hiddenGames}
            mobile={false}
            onCollapsedChange={setSidebarCollapsed}
            onOpenSettings={openSettings}
            onShowUpdate={() => setShowUpdateModal(true)}
            packetsPerSec={packetsPerSec}
            updateAvailable={!updateState?.updatesDisabled && (updateState?.updateAvailable ?? false)}
            updateVersion={updateState?.updatesDisabled ? null : (updateState?.latest ?? null)}
          />
        </aside>

        <div className="flex min-w-0 min-h-0 flex-1 flex-col">
          <header className="flex min-h-14 items-center justify-between border-b border-app-border px-3 @3xl/shell:hidden">
            <Link to="/" className="text-sm font-semibold text-app-text transition-colors hover:text-app-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent">
              RaceIQ
            </Link>
            <Button type="button" onClick={() => setMobileNavOpen(true)} className="p-3 text-app-text-secondary hover:text-app-text" aria-label={m.nav_open_navigation()}>
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
          <Button type="button" aria-label={m.nav_close_navigation()} onClick={() => setMobileNavOpen(false)} className="absolute inset-0 bg-app-bg/60" />
            <div className="relative h-full">
              <AppSidebar
                collapsed={false}
                connected={connected}
                forzaReceiving={isRaceOn}
                hiddenGames={hiddenGames}
                mobile
                onClose={() => setMobileNavOpen(false)}
                onOpenSettings={openSettings}
                onShowUpdate={() => setShowUpdateModal(true)}
                packetsPerSec={packetsPerSec}
                updateAvailable={!updateState?.updatesDisabled && (updateState?.updateAvailable ?? false)}
                updateVersion={updateState?.updatesDisabled ? null : (updateState?.latest ?? null)}
              />
            </div>
          </div>
        )}

        <DialogPrimitive.Root open={showSettings} onOpenChange={(open) => { if (!open) closeSettings(); }}>
          <DialogPrimitive.Portal container={shellRef.current ?? undefined}>
            {showSettings && (
              <div className="fixed inset-0 z-50 flex items-stretch justify-center @3xl/shell:items-start @3xl/shell:py-12">
              <DialogPrimitive.Backdrop className="absolute inset-0 bg-app-bg/60" />
              <DialogPrimitive.Popup aria-modal="true" className="relative h-full w-full overflow-hidden bg-app-bg outline-none @3xl/shell:max-w-4xl @3xl/shell:rounded-lg @3xl/shell:border @3xl/shell:border-app-border">
                <div className="flex items-center justify-between border-b border-app-border bg-app-surface px-4 py-3">
                  <DialogPrimitive.Title className="text-app-heading font-semibold text-app-text">{m.nav_settings()}</DialogPrimitive.Title>
                  <DialogPrimitive.Close render={<Button type="button" aria-label={m.nav_close_settings()} className="text-app-heading leading-none text-app-text-muted hover:text-app-text" />}>
                    &times;
                  </DialogPrimitive.Close>
                </div>
                <div className="h-[calc(100%-3rem)]">
                  <Settings initialSection={NAV_ITEMS.find((item) => item.id === settingsSection)?.id} onSectionChange={setSettingsSection} onClose={closeSettings} />
                </div>
              </DialogPrimitive.Popup>
              </div>
            )}
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>

        {(showUpdateModal || updateProgress) && <UpdateModal version={updateState?.latest ?? updateAvailable ?? "?"} currentVersion={updateState?.current ?? "?"} newReleases={updateState?.newReleases ?? []} fullReleaseNotes={updateState?.fullReleaseNotes ?? null} currentReleaseNotes={updateState?.currentReleaseNotes ?? null} currentReleaseDate={updateState?.currentReleaseDate ?? null} updatesDisabled={updateState?.updatesDisabled} onClose={() => setShowUpdateModal(false)} />}
        {onboardingOpen && <OnboardingModal onClose={closeOnboarding} />}
      </div>
      <RecordingLayoutMigration onPrecedenceChange={setLayoutMigrationPrecedence} />
      <StaleLapReprocessing />
      <SparseSplitMigration layoutPrecedence={layoutMigrationPrecedence} onVisibilityChange={setSparseMigrationVisible} />
      <RaceResultStatus compact />
      <ClassificationMigrationDock suppressed={layoutMigrationPrecedence || sparseMigrationVisible} />
      {liveCaptureError && <div role="alert" className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-start gap-3 border border-status-danger/40 bg-app-surface px-4 py-3 text-sm text-app-danger">
        <p className="min-w-0 whitespace-pre-wrap break-words">{liveCaptureError}</p>
        <Button type="button" variant="app-ghost" size="app-sm" aria-label="Dismiss recording failure" onClick={() => telemetryStore.actions.setLiveCaptureError(null)} className="shrink-0">Dismiss</Button>
      </div>}
    </>
  );
}
function DashboardConnection() {
  useWebSocket();
  return null;
}

function RootLayout() {
  const router = useRouter();
  const { auth } = Route.useRouteContext();
  const location = useLocation();
  const pathname = location.pathname;
  const routeGameId = gameIdForPathname(pathname);
  const storedGameId = useGameStore((state) => state.gameId);
  const gameId = routeGameId ?? (usesStoreGameContext(pathname) ? storedGameId : null);
  useEffect(() => {
    const refresh = () => { void router.invalidate(); };
    window.addEventListener("raceiq-auth-required", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener("raceiq-auth-required", refresh);
      window.clearInterval(timer);
    };
  }, [router]);
  return (
    <QueryClientProvider client={queryClient}>
      <RaceIqOnlineProvider host={onlineUiHost}>
        <GameRouteProvider value={gameId}>
          <TracksCatalogueHostProvider>
            <CarsCatalogueHostProvider>
              {auth.authenticated && <DashboardConnection />}
              {auth.authenticated && auth.onboardingComplete && !isOverlayPath(pathname) && <CloudLapImportActivation />}
              {isOverlayPath(pathname) ? <OverlayShell /> : pathname === "/login" || pathname === "/onboarding" ? <Outlet /> : <AppShell />}
            </CarsCatalogueHostProvider>
          </TracksCatalogueHostProvider>
        </GameRouteProvider>
      </RaceIqOnlineProvider>
    </QueryClientProvider>
  );
}

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    const auth = await loadDashboardAuth();
    if (auth.pending && location.pathname !== "/onboarding" &&
      !(location.pathname === "/login" && new URLSearchParams(location.searchStr).get("discord") === "complete")) {
      throw redirect({ to: "/onboarding", search: { redirect: location.href, welcome: undefined, step: undefined } });
    }
    if (!auth.pending && !auth.authenticated && location.pathname !== "/login") {
      throw redirect({ to: "/login", search: { redirect: location.href, discord: undefined } });
    }
    if (auth.authenticated && location.pathname !== "/login" && location.pathname !== "/onboarding" &&
      (!auth.onboardingComplete || new URLSearchParams(location.searchStr).has("welcome"))) {
      throw redirect({ to: "/onboarding", search: { redirect: location.href, welcome: true, step: undefined } });
    }
    return { auth };
  },
  errorComponent: function AccessUnavailable({ error }) {
    const router = useRouter();
    if (!(error instanceof DashboardAuthUnavailable)) return <ErrorComponent error={error} />;
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-app-bg p-4 text-app-text">
        <p className="text-sm text-status-danger" role="alert">{m.access_unavailable()}</p>
        <Button variant="app-outline" onClick={() => void router.invalidate()}>{m.access_retry()}</Button>
      </div>
    );
  },
  component: RootLayout,
});
