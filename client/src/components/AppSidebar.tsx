import { Select } from "@base-ui/react/select";
import { getAllGames } from "@shared/games/registry";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Binary,
  Car,
  ChartNoAxesCombined,
  Check,
  Code2,
  FlaskConical,
  Gamepad2,
  Gauge,
  GitCompareArrows,
  History,
  House,
  LayoutDashboard,
  type LucideIcon,
  Map as MapIcon,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  UserRound,
  X,
} from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { m } from "@/paraglide/messages";
import { type GameRouteFeature, supportsGameFeature } from "../lib/game-routes";
import { ConnectionStatus } from "./ConnectionStatus";

export interface AppSidebarProps {
  collapsed: boolean;
  connected: boolean;
  driverName: string;
  forzaReceiving: boolean;
  hiddenGames: readonly string[];
  mobile: boolean;
  onClose?: () => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  onOpenSettings: () => void;
  onShowUpdate: () => void;
  packetsPerSec: number;
  updateAvailable: boolean;
  updateVersion?: string | null;
}

type SidebarLinkProps = {
  collapsed: boolean;
  exact?: boolean;
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  to: string;
};

function SidebarLink({ collapsed, exact = false, icon: Icon, label, onClick, to }: SidebarLinkProps) {
  const className = `flex min-h-9 items-center gap-2 border-l-2 px-3 text-xs font-semibold uppercase tracking-wider transition-colors ${collapsed ? "justify-center px-0" : ""}`;
  const activeProps = { className: `${className} border-app-accent bg-app-surface-alt text-app-accent` };
  const inactiveProps = { className: `${className} border-transparent text-app-text-muted hover:bg-app-surface-hover hover:text-app-text-secondary` };
  const content = (
    <>
      <Icon className="size-4 shrink-0" />
      <span className={collapsed ? "sr-only" : "truncate"}>{label}</span>
    </>
  );

  if (!collapsed) {
    return (
      <Link to={to} onClick={onClick} activeOptions={{ exact }} className={className} activeProps={activeProps} inactiveProps={inactiveProps}>
        {content}
      </Link>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<Link to={to} onClick={onClick} activeOptions={{ exact }} className={className} activeProps={activeProps} inactiveProps={inactiveProps} />}>{content}</TooltipTrigger>
      <TooltipContent side="right" role="tooltip">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarAction({ children, collapsed, label, onClick, className: customClassName }: { children: ReactNode; collapsed: boolean; label: string; onClick: () => void; className?: string }) {
  const className = `w-full justify-start ${collapsed ? "justify-center px-0" : ""} ${customClassName ?? ""}`;

  if (!collapsed) {
    return (
      <Button variant="app-ghost" size="app-md" onClick={onClick} aria-label={label} className={className}>
        {children}
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="app-ghost" size="app-md" onClick={onClick} aria-label={label} className={className} />}>{children}</TooltipTrigger>
      <TooltipContent side="right" role="tooltip">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const FEATURE_LINKS: ReadonlyArray<{
  icon: LucideIcon;
  label: () => string;
  segment: string;
  feature?: GameRouteFeature;
}> = [
  { segment: "live", label: m.tab_live, icon: Gauge },
  { segment: "sessions", label: m.label_sessions, icon: History },
  { segment: "compare", label: m.label_compare, icon: GitCompareArrows },
  { segment: "analyse", label: m.label_analyse, icon: ChartNoAxesCombined },
  { segment: "driver", label: m.label_driver, icon: UserRound, feature: "driver" },
  { segment: "experiments", label: m.nav_experiments, icon: FlaskConical, feature: "experiments" },
  { segment: "chats", label: m.tab_chats, icon: MessagesSquare },
  { segment: "tracks", label: m.label_tracks, icon: MapIcon },
  { segment: "cars", label: m.label_cars, icon: Car },
  { segment: "setups", label: m.tab_setups, icon: SlidersHorizontal, feature: "setups" },
  { segment: "raw", label: m.tab_raw, icon: Binary, feature: "raw" },
];

const GAME_LOGO_SRC: Readonly<Partial<Record<string, string>>> = {
  "fm-2023": "/forza-logo.svg",
  "f1-2025": "/f1-logo.svg",
  acc: "/acc-logo.svg",
  "ac-evo": "/acevo-logo.svg",
};

export function AppSidebar({
  collapsed,
  connected,
  driverName,
  forzaReceiving,
  hiddenGames,
  mobile,
  onClose,
  onCollapsedChange,
  onOpenSettings,
  onShowUpdate,
  packetsPerSec,
  updateAvailable,
  updateVersion,
}: AppSidebarProps): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [gameSelectOpen, setGameSelectOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const activeGame = getAllGames().find((game) => location.pathname === `/${game.routePrefix}` || location.pathname.startsWith(`/${game.routePrefix}/`));
  const visibleGames = getAllGames().filter((game) => !hiddenGames.includes(game.id) || game.id === activeGame?.id);
  const selectItems = useMemo(() => visibleGames.map((game) => ({ value: game.id, label: game.displayName })), [visibleGames]);
  const visibleFeatures = activeGame ? FEATURE_LINKS.filter((feature) => !feature.feature || supportsGameFeature(activeGame.routePrefix, feature.feature)) : [];
  const showCollapsed = !mobile && collapsed;

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const cancelScheduledClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = (event: React.PointerEvent<HTMLElement>) => {
    if (!showCollapsed || event.pointerType !== "mouse") return;
    cancelScheduledClose();
    closeTimer.current = window.setTimeout(() => setGameSelectOpen(false), 150);
  };

  const openOnHover = (event: React.PointerEvent<HTMLElement>) => {
    if (!showCollapsed || event.pointerType !== "mouse") return;
    cancelScheduledClose();
    setGameSelectOpen(true);
  };

  const handleGameChange = (gameId: string | null) => {
    if (gameId === null) return;
    const game = getAllGames().find((candidate) => candidate.id === gameId);
    if (!game) return;
    setGameSelectOpen(false);
    void navigate({ to: `/${game.routePrefix}` });
  };

  const handleSettings = () => {
    onClose?.();
    onOpenSettings();
  };

  const handleUpdate = () => {
    onClose?.();
    onShowUpdate();
  };

  const toggleLabel = collapsed ? m.nav_expand_sidebar() : m.nav_collapse_sidebar();
  const updateLabel = updateVersion ? `${m.root_update_available()} · v${updateVersion}` : m.root_update_available();

  return (
    <TooltipProvider>
      <nav
        aria-label={m.nav_navigation()}
        data-collapsed={mobile ? false : collapsed}
        className={`flex h-full shrink-0 flex-col bg-app-bg text-app-text ${
          mobile ? "w-64 max-w-[80vw] border-l border-app-border" : collapsed ? "w-14 border-r border-app-border" : "w-52 border-r border-app-border"
        } transition-[width] duration-200 motion-reduce:transition-none`}
      >
        <div className={`flex h-14 items-center border-b border-app-border ${showCollapsed ? "justify-center" : "justify-between px-3"}`}>
          {!showCollapsed && (
            <Link to="/" className="text-sm font-semibold text-app-text transition-colors hover:text-app-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent">
              RaceIQ
            </Link>
          )}
          {mobile ? (
            <Button variant="app-ghost" size="icon-sm" onClick={onClose} aria-label="Close navigation">
              <X className="size-4" />
            </Button>
          ) : (
            <SidebarAction collapsed={showCollapsed} label={toggleLabel} onClick={() => onCollapsedChange?.(!collapsed)} className="w-auto">
              {showCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </SidebarAction>
          )}
        </div>

        <div className="border-b border-app-border p-2">
          <Select.Root<string> items={selectItems} value={activeGame?.id ?? null} open={gameSelectOpen} onOpenChange={setGameSelectOpen} onValueChange={handleGameChange} modal={false}>
            <Select.Trigger
              aria-label={m.label_games()}
              onPointerEnter={openOnHover}
              onPointerLeave={scheduleClose}
              className={`flex h-9 w-full items-center gap-2 rounded border border-app-border-input bg-app-surface text-xs font-semibold text-app-text transition-colors hover:border-app-accent focus-visible:border-app-accent focus-visible:outline-none ${
                showCollapsed ? "justify-center px-0" : "px-2"
              }`}
            >
              {activeGame && GAME_LOGO_SRC[activeGame.id] ? (
                <span
                  aria-hidden="true"
                  className="h-4 w-5 shrink-0 bg-app-accent [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain]"
                  style={{ maskImage: `url(${GAME_LOGO_SRC[activeGame.id]})`, WebkitMaskImage: `url(${GAME_LOGO_SRC[activeGame.id]})` }}
                />
              ) : (
                <Gamepad2 className="size-4 shrink-0 text-app-accent" />
              )}
              <Select.Value className={showCollapsed ? "sr-only" : "truncate"} placeholder={m.label_games()} />
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner alignItemWithTrigger={false} side={showCollapsed ? "right" : "bottom"} align="start" sideOffset={8} collisionPadding={8}>
                <Select.Popup onPointerEnter={openOnHover} onPointerLeave={scheduleClose} className="z-50 min-w-52 overflow-hidden rounded border border-app-border bg-app-surface p-1 text-app-text">
                  <Select.List>
                    {visibleGames.map((game) => (
                      <Select.Item
                        key={game.id}
                        value={game.id}
                        className="flex cursor-default items-center justify-between gap-3 rounded px-2 py-2 text-sm outline-none data-highlighted:bg-app-surface-alt data-selected:text-app-accent"
                      >
                        <Select.ItemText>{game.displayName}</Select.ItemText>
                        <Select.ItemIndicator>
                          <Check className="size-4" />
                        </Select.ItemIndicator>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </div>

        {activeGame && (
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            {visibleFeatures.map((feature) => (
              <SidebarLink key={feature.segment} collapsed={showCollapsed} icon={feature.icon} label={feature.label()} to={`/${activeGame.routePrefix}/${feature.segment}`} onClick={onClose} />
            ))}
          </div>
        )}

        <div className="mt-auto border-t border-app-border p-2">
          <SidebarLink collapsed={showCollapsed} exact icon={House} label={m.nav_home()} to="/" onClick={onClose} />
          <SidebarLink collapsed={showCollapsed} icon={LayoutDashboard} label={m.nav_dash()} to="/dash" onClick={onClose} />
          {import.meta.env.DEV && <SidebarLink collapsed={showCollapsed} icon={Code2} label={m.nav_dev()} to="/dev" onClick={onClose} />}
          {updateAvailable && (
            <SidebarAction collapsed={showCollapsed} label={updateLabel} onClick={handleUpdate}>
              <RefreshCw className="size-4 text-app-accent" />
              <span className={showCollapsed ? "sr-only" : "truncate"}>{updateLabel}</span>
            </SidebarAction>
          )}
          <SidebarAction collapsed={showCollapsed} label={driverName ? `${m.nav_settings()} (${driverName})` : m.nav_settings()} onClick={handleSettings}>
            <Settings2 className="size-4" />
            <span className={showCollapsed ? "sr-only" : "truncate"}>{driverName || m.nav_settings()}</span>
          </SidebarAction>
          <ConnectionStatus connected={connected} packetsPerSec={packetsPerSec} forzaReceiving={forzaReceiving} collapsed={showCollapsed} />
        </div>
      </nav>
    </TooltipProvider>
  );
}
