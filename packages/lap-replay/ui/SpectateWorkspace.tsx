import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMessages } from "./host"

const DEFAULT_WIDTH = 310;
const MIN_WIDTH = 270;
const MAX_WIDTH = 650;
const MIN_SCENE_WIDTH = 320;
function clampWidth(value: number, available: number) {
  const maximum = Math.min(MAX_WIDTH, available * 0.88);
  const minimum = Math.min(MIN_WIDTH, maximum);
  return Math.round(Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : DEFAULT_WIDTH)));
}
export interface SpectateWorkspacePanel {
  id: string;
  label: string;
  open: boolean;
  width?: number;
  closedWidth: number;
  toggle: (open: boolean) => void;
  content: ReactNode;
  headerControls?: ReactNode;
  resizable?: boolean;
}

/** Shared scene and independently toggled panel rail for replay and comparison. */
export function SpectateWorkspace({ children, panels, panelHeaderTarget, storageKey, tallMobile = false }: {
  children: ReactNode;
  panels: readonly SpectateWorkspacePanel[];
  panelHeaderTarget?: HTMLDivElement | null;
  storageKey: string;
  tallMobile?: boolean;
}) { const m = useMessages(); const root = useRef<HTMLDivElement>(null);
const panelHeaders = useRef<HTMLDivElement>(null);
const panelBody = useRef<HTMLElement>(null);
const focusedPanelTab = useRef<string | null>(null);
const drag = useRef<{ pointer: number; startX: number; startWidth: number } | null>(null);
const [width, setWidth] = useState(DEFAULT_WIDTH);
const [viewport, setViewport] = useState(typeof window === "undefined" ? 1024 : window.innerWidth);
const narrow = viewport <= 800;
const [workspaceWidth, setWorkspaceWidth] = useState(0);
const available = root.current?.clientWidth || workspaceWidth || viewport;
const panelRailMaxWidth = narrow ? "88vw" : Math.max(0, available - Math.min(MIN_SCENE_WIDTH, available * 0.5));
const setPanelWidth = useCallback((next: number, persist = true) => {
  const value = clampWidth(next, root.current?.clientWidth || window.innerWidth);
  setWidth(value);
  if (persist) {
    try { localStorage.setItem(storageKey, String(value)); } catch { /* Storage may be unavailable. */ }
  }
}, [storageKey]);
const panelsRef = useRef(panels);
panelsRef.current = panels;
useEffect(() => {
  try {
    const stored = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(stored) && stored > 0) setPanelWidth(stored, false);
  } catch { /* Storage may be unavailable. */ }
  let previousViewport = window.innerWidth;
  const update = () => {
    const next = window.innerWidth;
    setViewport(next);
    if (next <= 800 && previousViewport > 800) {
      for (const panel of panelsRef.current) if (panel.resizable) panel.toggle(false);
    }
    previousViewport = next;
    const nextAvailable = root.current?.clientWidth || next;
    setWorkspaceWidth(nextAvailable);
    setWidth((current) => clampWidth(current, nextAvailable));
  };
  const observer = new ResizeObserver(update);
  if (root.current) observer.observe(root.current);
  window.addEventListener("resize", update);
  update();
  return () => { observer.disconnect(); window.removeEventListener("resize", update); };
}, [storageKey, setPanelWidth]);
const resize = (event: PointerEvent<HTMLDivElement>) => {
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.current = { pointer: event.pointerId, startX: event.clientX, startWidth: width };
};
const move = (event: PointerEvent<HTMLDivElement>) => {
  if (drag.current?.pointer === event.pointerId) setPanelWidth(drag.current.startWidth + drag.current.startX - event.clientX);
};
const endResize = (event: PointerEvent<HTMLDivElement>) => {
  if (drag.current?.pointer === event.pointerId) drag.current = null;
};
const keyboardResize = (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  event.stopPropagation();
  setPanelWidth(width + (event.key === "ArrowLeft" ? 20 : -20));
};
const panelTabs = panels.map((panel) => ({ ...panel, width: panel.resizable ? width : clampWidth(panel.width ?? DEFAULT_WIDTH, available) }));
const closedTabs = panelTabs.filter((panel) => !panel.open);
useLayoutEffect(() => {
  const id = focusedPanelTab.current;
  if (!id) return;
  (panelHeaderTarget ?? root.current)?.querySelector<HTMLButtonElement>(`[data-panel-toggle="${id}"]`)?.focus();
  focusedPanelTab.current = null;
});
const openPanelsWidth = panelTabs.reduce((total, panel) => total + (panel.open ? panel.width : 0), 0);
const renderPanelTab = (panel: (typeof panelTabs)[number]) => (
  <div key={panel.id} data-panel-header={panel.id}
    className={`flex h-10 shrink-0 items-center border-b-2 border-l border-l-app-border bg-app-bg ${panel.open ? "border-b-app-accent" : "border-b-transparent"}`}
    style={{ width: panel.open && panelHeaderTarget ? panel.width : panel.closedWidth }}>
    <button data-panel-toggle={panel.id} type="button" aria-pressed={panel.open} aria-expanded={panel.open} aria-controls={panel.open ? panel.id : undefined}
      onClick={() => { focusedPanelTab.current = panel.id; panel.toggle(!panel.open); }}
      className={`flex h-full min-w-0 flex-1 items-center px-3 text-left text-app-label focus-visible:outline-2 focus-visible:outline-app-accent ${panel.open ? "text-app-accent" : "text-app-text-secondary hover:text-app-text"}`}>
      <span className="truncate">{panel.label}</span>
    </button>
    {panel.open && panel.headerControls}
  </div>
);
const headers = <>
  {closedTabs.length > 0 && <div className="flex max-w-full shrink-0 overflow-x-auto">{closedTabs.map((panel) => renderPanelTab(panel))}</div>}
  <div ref={panelHeaders} data-spectate-panel-headers="" className="flex shrink-0 overflow-x-auto"
    style={{ width: openPanelsWidth, maxWidth: panelRailMaxWidth }}
    onScroll={(event) => { if (panelBody.current) panelBody.current.scrollLeft = event.currentTarget.scrollLeft; }}>
    {panelTabs.filter((panel) => panel.open).map((panel) => renderPanelTab(panel))}
  </div>
</>;
return <div ref={root} className="relative flex min-h-[32rem] w-full flex-1 flex-col overflow-hidden bg-app-bg @5xl/workspace:min-h-0"
  style={tallMobile && narrow ? { minHeight: 680 } : undefined}
  data-spectate-workspace="" data-spectate-view="" data-panel-width={width} data-panel-collapsed={!panels.some((panel) => panel.resizable && panel.open)}>
  {panelHeaderTarget ? createPortal(headers, panelHeaderTarget) : <div className="flex shrink-0 overflow-x-auto border-b border-app-border"><div className="ml-auto flex">{panelTabs.map((panel) => renderPanelTab(panel))}</div></div>}
  <div className="relative flex min-h-0 flex-1 overflow-hidden">
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-bg">{children}</main>
    <aside ref={panelBody} onScroll={(event) => { if (panelHeaders.current) panelHeaders.current.scrollLeft = event.currentTarget.scrollLeft; }}
      className={`inset-y-0 z-30 flex min-h-0 shrink-0 overflow-x-auto overflow-y-hidden border-l border-app-border bg-app-bg ${narrow ? "absolute right-0" : "relative"}`}
      style={{ width: openPanelsWidth, maxWidth: panelRailMaxWidth }} aria-label={m.spectate_telemetry()}>
      {panelTabs.filter((panel) => panel.open).map((panel) => <section key={panel.id} id={panel.id} aria-label={panel.label}
        className="relative flex h-full shrink-0 flex-col overflow-hidden border-l border-app-border bg-app-bg" style={{ width: panel.width }}>
        {panel.resizable && <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={m.spectate_resize_panel()}
          aria-valuemin={Math.min(MIN_WIDTH, width)} aria-valuemax={clampWidth(MAX_WIDTH, available)} aria-valuenow={width}
          className="absolute left-0 top-0 z-40 h-full w-3 cursor-col-resize touch-none outline-none focus-visible:bg-app-accent/30"
          onPointerDown={resize} onPointerMove={move} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} onKeyDown={keyboardResize} />}
        {panel.content}
      </section>)}
    </aside>
  </div>
</div>; }
