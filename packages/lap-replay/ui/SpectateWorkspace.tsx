import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMessages } from "./host";

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
  collapseOnNarrow?: boolean;
}
interface PanelLayout {
  widths: Record<string, number>;
  railWidth: number | null;
}
interface ResizeDrag {
  pointer: number;
  startX: number;
  railWidth: number;
  widths: Record<string, number>;
  left?: string;
  right?: string;
}

/** Shared scene, resizable right rail, and independently sized panels. */
export function SpectateWorkspace({ children, panels, panelHeaderTarget, storageKey, tallMobile = false }: {
  children: ReactNode;
  panels: readonly SpectateWorkspacePanel[];
  panelHeaderTarget?: HTMLDivElement | null;
  storageKey: string;
  tallMobile?: boolean;
}) {
  const m = useMessages();
  const root = useRef<HTMLDivElement>(null);
  const panelHeaders = useRef<HTMLDivElement>(null);
  const panelBody = useRef<HTMLElement>(null);
  const focusedPanelTab = useRef<string | null>(null);
  const drag = useRef<ResizeDrag | null>(null);
  const [layout, setLayout] = useState<PanelLayout>({ widths: {}, railWidth: null });
  const [viewport, setViewport] = useState(typeof window === "undefined" ? 1024 : window.innerWidth);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const narrow = viewport <= 800;
  const available = workspaceWidth || viewport;
  const panelTabs = panels.map((panel) => ({ ...panel, width: clampWidth(layout.widths[panel.id] ?? panel.width ?? DEFAULT_WIDTH, available) }));
  const openTabs = panelTabs.filter((panel) => panel.open);
  const closedTabs = panelTabs.filter((panel) => !panel.open);
  const railMaximum = Math.max(0, narrow ? available * 0.88 : available - Math.min(MIN_SCENE_WIDTH, available * 0.5));
  const railMinimum = Math.min(MIN_WIDTH, railMaximum);
  const contentWidth = openTabs.reduce((total, panel) => total + panel.width, 0);
  const railWidth = openTabs.length ? Math.round(Math.min(railMaximum, Math.max(railMinimum, layout.railWidth ?? contentWidth))) : 0;
  const persistLayout = useCallback((next: PanelLayout) => {
    setLayout(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
  }, [storageKey]);

  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
        const telemetry = panelsRef.current.find((panel) => panel.collapseOnNarrow);
        setLayout({ widths: telemetry ? { [telemetry.id]: stored } : {}, railWidth: null });
      } else if (stored && typeof stored === "object") {
        const saved = stored as Partial<PanelLayout>;
        const widths = saved.widths && typeof saved.widths === "object"
          ? Object.fromEntries(Object.entries(saved.widths).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0))
          : {};
        setLayout({ widths, railWidth: typeof saved.railWidth === "number" && Number.isFinite(saved.railWidth) && saved.railWidth > 0 ? saved.railWidth : null });
      } else setLayout({ widths: {}, railWidth: null });
    } catch { setLayout({ widths: {}, railWidth: null }); }
  }, [storageKey]);
  useEffect(() => {
    let previousViewport = window.innerWidth;
    const update = () => {
      const next = window.innerWidth;
      setViewport(next);
      if (next <= 800 && previousViewport > 800) {
        for (const panel of panelsRef.current) if (panel.collapseOnNarrow) panel.toggle(false);
      }
      previousViewport = next;
      setWorkspaceWidth(root.current?.clientWidth || next);
    };
    const observer = new ResizeObserver(update);
    if (root.current) observer.observe(root.current);
    window.addEventListener("resize", update);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  useLayoutEffect(() => {
    const id = focusedPanelTab.current;
    if (!id) return;
    (panelHeaderTarget ?? root.current)?.querySelector<HTMLButtonElement>(`[data-panel-toggle="${id}"]`)?.focus();
    focusedPanelTab.current = null;
  });

  const snapshot = (pointer: number, startX: number, left?: string, right?: string): ResizeDrag => ({
    pointer, startX, railWidth, left, right,
    widths: Object.fromEntries(openTabs.map((panel) => [panel.id, panel.width])),
  });
  const applyResize = (current: ResizeDrag, delta: number) => {
    if (current.left && current.right) {
      const left = current.widths[current.left]!, right = current.widths[current.right]!;
      const minimum = clampWidth(0, available), maximum = clampWidth(MAX_WIDTH, available);
      const offset = Math.max(Math.max(minimum - left, right - maximum), Math.min(Math.min(maximum - left, right - minimum), delta));
      persistLayout({ ...layout, widths: { ...layout.widths, [current.left]: left + offset, [current.right]: right - offset } });
    } else {
      const target = Math.max(railMinimum, Math.min(railMaximum, current.railWidth - delta));
      persistLayout({ ...layout, railWidth: target });
    }
  };
  const beginResize = (event: PointerEvent<HTMLDivElement>, left?: string, right?: string) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = snapshot(event.pointerId, event.clientX, left, right);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (Object.keys(current.widths).some((id) => !panelsRef.current.some((panel) => panel.id === id && panel.open))) {
      drag.current = null;
      return;
    }
    applyResize(current, event.clientX - current.startX);
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
  };
  const keyboardResize = (event: KeyboardEvent<HTMLDivElement>, left?: string, right?: string) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    applyResize(snapshot(0, 0, left, right), event.key === "ArrowLeft" ? -20 : 20);
  };
  const renderPanelTab = (panel: (typeof panelTabs)[number]) => (
    <div key={panel.id} data-panel-header={panel.id}
      className={`flex h-10 shrink-0 items-center border-b-2 border-l border-l-app-border bg-app-bg ${panel.open ? "border-b-app-accent" : "border-b-transparent"}`}
      style={{ width: panel.open ? panel.width : panel.closedWidth }}>
      <button data-panel-toggle={panel.id} type="button" aria-pressed={panel.open} aria-expanded={panel.open} aria-controls={panel.open ? panel.id : undefined}
        onClick={() => { focusedPanelTab.current = panel.id; panel.toggle(!panel.open); }}
        className={`flex h-full min-w-0 flex-1 items-center px-3 text-left text-app-label focus-visible:outline-2 focus-visible:outline-app-accent ${panel.open ? "text-app-accent" : "text-app-text-secondary hover:text-app-text"}`}>
        <span className="truncate">{panel.label}</span>
      </button>
      {panel.open && panel.headerControls}
    </div>
  );
  const headers = <>
    {closedTabs.length > 0 && <div className="flex max-w-full shrink-0 overflow-x-auto">{closedTabs.map(renderPanelTab)}</div>}
    <div ref={panelHeaders} data-spectate-panel-headers="" className="flex shrink-0 overflow-x-auto" style={{ width: railWidth }}
      onScroll={(event) => { if (panelBody.current) panelBody.current.scrollLeft = event.currentTarget.scrollLeft; }}>
      {openTabs.map(renderPanelTab)}
    </div>
  </>;
  return <div ref={root} className="relative flex min-h-[32rem] w-full flex-1 flex-col overflow-hidden bg-app-bg @5xl/workspace:min-h-0"
    style={tallMobile && narrow ? { minHeight: 680 } : undefined}
    data-spectate-workspace="" data-spectate-view="" data-panel-width={railWidth} data-panel-collapsed={!panels.some((panel) => panel.collapseOnNarrow && panel.open)}>
    {panelHeaderTarget ? createPortal(headers, panelHeaderTarget) : <div className="flex shrink-0 flex-wrap items-end justify-end border-b border-app-border">{headers}</div>}
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <main className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-bg">{children}</main>
      <div data-panel-rail="" className={`inset-y-0 z-30 min-h-0 shrink-0 ${narrow ? "absolute right-0" : "relative"}`} style={{ width: railWidth }}>
        {openTabs.length > 0 && <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={m.spectate_resize_panel()}
          aria-valuemin={railMinimum} aria-valuemax={railMaximum} aria-valuenow={railWidth}
          className="absolute inset-y-0 -left-1.5 z-50 w-3 cursor-col-resize touch-none outline-none focus-visible:bg-app-accent/30"
          onPointerDown={(event) => beginResize(event)} onPointerMove={move} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} onKeyDown={(event) => keyboardResize(event)} />}
        <aside ref={panelBody} onScroll={(event) => { if (panelHeaders.current) panelHeaders.current.scrollLeft = event.currentTarget.scrollLeft; }}
          className="flex h-full min-h-0 w-full overflow-x-auto overflow-y-hidden border-l border-app-border bg-app-bg" aria-label={m.spectate_telemetry()}>
          {openTabs.map((panel, index) => <section key={panel.id} id={panel.id} aria-label={panel.label}
            className="relative flex h-full shrink-0 flex-col overflow-hidden border-l border-app-border bg-app-bg" style={{ width: panel.width }}>
            {index > 0 && <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={m.spectate_resize_between({ left: openTabs[index - 1]!.label, right: panel.label })}
              aria-valuemin={Math.max(clampWidth(0, available), openTabs[index - 1]!.width + panel.width - clampWidth(MAX_WIDTH, available))}
              aria-valuemax={Math.min(clampWidth(MAX_WIDTH, available), openTabs[index - 1]!.width + panel.width - clampWidth(0, available))}
              aria-valuenow={openTabs[index - 1]!.width}
              className="absolute inset-y-0 left-0 z-40 w-3 cursor-col-resize touch-none outline-none focus-visible:bg-app-accent/30"
              onPointerDown={(event) => beginResize(event, openTabs[index - 1]!.id, panel.id)} onPointerMove={move} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize}
              onKeyDown={(event) => keyboardResize(event, openTabs[index - 1]!.id, panel.id)} />}
            {panel.content}
          </section>)}
        </aside>
      </div>
    </div>
  </div>;
}
