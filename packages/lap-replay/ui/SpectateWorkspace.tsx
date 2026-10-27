import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMessages } from "./host";

const DEFAULT_WIDTH = 310;
const MIN_WIDTH = 270;
const MIN_SCENE_WIDTH = 320;
function clampWidth(value: number, available: number) {
  const maximum = Math.max(0, available - Math.min(MIN_SCENE_WIDTH, available * 0.5));
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
  order?: readonly string[];
}
interface ResizeDrag {
  pointer: number;
  startX: number;
  railWidth: number;
  widths: Record<string, number>;
  left?: string;
}

/** Shared scene, resizable right rail, and independently sized panels. */
export function SpectateWorkspace({ children, panels, panelHeaderTarget, storageKey }: {
  children: ReactNode;
  panels: readonly SpectateWorkspacePanel[];
  panelHeaderTarget?: HTMLDivElement | null;
  storageKey: string;
}) {
  const m = useMessages();
  const root = useRef<HTMLDivElement>(null);
  const panelHeaders = useRef<HTMLDivElement>(null);
  const panelBody = useRef<HTMLElement>(null);
  const focusedPanelTab = useRef<string | null>(null);
  const drag = useRef<ResizeDrag | null>(null);
  const tabDrag = useRef<{ id: string; pointer: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressTabClick = useRef(false);
  const [tabDrop, setTabDrop] = useState<{ source: string; target: string | null } | null>(null);
  const [layout, setLayout] = useState<PanelLayout>({ widths: {}, railWidth: null });
  const [viewport, setViewport] = useState(typeof window === "undefined" ? 1024 : window.innerWidth);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const panelsRef = useRef(panels);
  const previousOpenPanels = useRef<Set<string> | null>(null);
  panelsRef.current = panels;
  const narrow = viewport <= 800;
  const available = workspaceWidth || viewport;
  const panelTabs = panels.map((panel) => ({ ...panel, width: narrow ? available : clampWidth(layout.widths[panel.id] ?? panel.width ?? DEFAULT_WIDTH, available) }))
    .sort((a, b) => {
      const left = layout.order?.indexOf(a.id) ?? -1, right = layout.order?.indexOf(b.id) ?? -1;
      return (left < 0 ? Number.MAX_SAFE_INTEGER : left) - (right < 0 ? Number.MAX_SAFE_INTEGER : right);
    });
  const openTabs = panelTabs.filter((panel) => panel.open).slice(0, narrow ? 1 : panelTabs.length);
  const closedTabs = panelTabs.filter((panel) => !panel.open);
  const contentWidth = openTabs.reduce((total, panel) => total + panel.width, 0);
  const railMaximum = Math.max(0, narrow ? available : available - Math.min(MIN_SCENE_WIDTH, available * 0.5));
  const railMinimum = Math.min(MIN_WIDTH, railMaximum);
  const railWidth = openTabs.length ? narrow ? available : Math.round(Math.min(railMaximum, Math.max(Math.min(railMinimum, available * 0.5), layout.railWidth ?? Math.min(contentWidth, Math.floor(available * 0.5))))) : 0;
  if (!narrow && openTabs.length === 1) openTabs[0]!.width = railWidth;
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
        const order = Array.isArray(saved.order) ? saved.order.filter((id): id is string => typeof id === "string") : undefined;
        setLayout({ widths, railWidth: typeof saved.railWidth === "number" && Number.isFinite(saved.railWidth) && saved.railWidth > 0 ? saved.railWidth : null, order });
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
    const open = panels.filter((panel) => panel.open);
    const previous = previousOpenPanels.current;
    const selected = open.find((panel) => !previous?.has(panel.id)) ?? open[0];
    if (narrow && open.length > 1) {
      for (const panel of open) if (panel !== selected) panel.toggle(false);
    }
    previousOpenPanels.current = new Set((narrow && selected ? [selected] : open).map((panel) => panel.id));
  }, [narrow, panels, layout, persistLayout]);
  useLayoutEffect(() => {
    const id = focusedPanelTab.current;
    if (!id) return;
    (narrow ? root.current : panelHeaderTarget ?? root.current)?.querySelector<HTMLButtonElement>(`[data-panel-toggle="${id}"]`)?.focus();
    focusedPanelTab.current = null;
  });

  const snapshot = (pointer: number, startX: number, left?: string): ResizeDrag => ({
    pointer, startX, railWidth, left,
    widths: Object.fromEntries(openTabs.map((panel) => [panel.id, panel.width])),
  });
  const applyResize = (current: ResizeDrag, delta: number) => {
    if (current.left) {
      const width = clampWidth(current.widths[current.left]! + delta, available);
      persistLayout({ ...layout, railWidth: current.railWidth, widths: { ...layout.widths, ...current.widths, [current.left]: width } });
    } else {
      const target = Math.max(railMinimum, Math.min(railMaximum, current.railWidth - delta));
      const widths = { ...layout.widths };
      const ids = Object.keys(current.widths);
      let remaining = target - Object.values(current.widths).reduce((total, width) => total + width, 0);
      if (ids.length > 1 && remaining > 0) {
        for (let index = 0; index < ids.length; index++) {
          const id = ids[index]!, extra = Math.floor(remaining / (ids.length - index));
          widths[id] = current.widths[id]! + extra;
          remaining -= extra;
        }
      }
      persistLayout({ ...layout, railWidth: target, widths });
    }
  };
  const beginResize = (event: PointerEvent<HTMLDivElement>, left?: string) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = snapshot(event.pointerId, event.clientX, left);
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
  const keyboardResize = (event: KeyboardEvent<HTMLDivElement>, left?: string) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    applyResize(snapshot(0, 0, left), event.key === "ArrowLeft" ? -20 : 20);
  };
  const canReorder = (source: string, target: string | null): target is string => {
    const from = panelTabs.find((panel) => panel.id === source), to = panelTabs.find((panel) => panel.id === target);
    return !!from && !!to && from !== to && (narrow || from.open === to.open);
  };
  const reorder = (source: string, target: string | null) => {
    if (!canReorder(source, target)) return;
    const order = panelTabs.map((panel) => panel.id);
    const from = order.indexOf(source), to = order.indexOf(target);
    order.splice(to, 0, order.splice(from, 1)[0]!);
    focusedPanelTab.current = source;
    persistLayout({ ...layout, order });
  };
  const cancelTabDrag = () => { tabDrag.current = null; setTabDrop(null); };
  const moveTab = (event: PointerEvent<HTMLButtonElement>) => {
    const current = tabDrag.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
    current.moved = true;
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-panel-header]")?.dataset.panelHeader ?? null;
    const target = canReorder(current.id, over) ? over : null;
    setTabDrop((previous) => previous?.source === current.id && previous.target === target ? previous : { source: current.id, target });
  };
  const renderPanelTab = (panel: (typeof panelTabs)[number]) => (
    <div key={panel.id} data-panel-header={panel.id}
      className={`flex min-w-0 shrink-0 items-center border-b-2 border-l border-l-app-border bg-app-bg ${narrow ? "h-11" : "h-10"} ${narrow && panel.open && panel.headerControls ? "col-span-3" : ""} ${panel.open || tabDrop?.target === panel.id ? "border-b-app-accent" : "border-b-transparent"} ${tabDrop?.source === panel.id ? "opacity-60" : ""}`}
      style={{ width: narrow ? undefined : panel.open ? panel.width : panel.closedWidth }}>
      <button data-panel-toggle={panel.id} type="button" aria-pressed={panel.open} aria-expanded={panel.open} aria-controls={panel.open ? panel.id : undefined}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          suppressTabClick.current = false;
          tabDrag.current = { id: panel.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={moveTab}
        onPointerUp={(event) => {
          const current = tabDrag.current;
          if (!current || current.pointer !== event.pointerId) return;
          if (current.moved) {
            suppressTabClick.current = true;
            reorder(current.id, document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-panel-header]")?.dataset.panelHeader ?? null);
          }
          cancelTabDrag();
        }}
        onPointerCancel={cancelTabDrag}
        onLostPointerCapture={(event) => { if (tabDrag.current?.pointer === event.pointerId) cancelTabDrag(); }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && tabDrag.current) {
            suppressTabClick.current = true;
            cancelTabDrag();
          }
          if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          const group = panelTabs.filter((item) => narrow || item.open === panel.open);
          const next = group[group.findIndex((item) => item.id === panel.id) + (event.key === "ArrowLeft" ? -1 : 1)];
          if (next) reorder(panel.id, next.id);
        }}
        onClick={(event) => {
          if (suppressTabClick.current && event.detail !== 0) { suppressTabClick.current = false; return; }
          suppressTabClick.current = false;
          focusedPanelTab.current = panel.id;
          if (narrow) for (const other of panels) if (other.id !== panel.id && other.open) other.toggle(false);
          panel.toggle(!panel.open);
        }}
        className={`flex h-full min-w-0 flex-1 cursor-grab touch-none select-none items-center px-3 text-left text-app-label active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-app-accent ${panel.open ? "text-app-accent" : "text-app-text-secondary hover:text-app-text"}`}>
        <span className="truncate">{panel.label}</span>
      </button>
      {panel.open && panel.headerControls}
    </div>
  );
  const headers = narrow ? <div data-mobile-panel-tabs="" className="grid w-full shrink-0 grid-cols-3 border-y border-app-border">{panelTabs.map(renderPanelTab)}</div> : <>
    {closedTabs.length > 0 && <div className="flex max-w-full shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{closedTabs.map(renderPanelTab)}</div>}
    <div ref={panelHeaders} data-spectate-panel-headers="" className="flex shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" style={{ width: railWidth }}
      onScroll={(event) => { if (panelBody.current) panelBody.current.scrollLeft = event.currentTarget.scrollLeft; }}>
      {openTabs.map(renderPanelTab)}
    </div>
  </>;
  return <div ref={root} className="relative flex min-h-[32rem] w-full flex-1 flex-col overflow-hidden bg-app-bg @5xl/workspace:min-h-0"
    data-spectate-workspace="" data-spectate-view="" data-panel-width={railWidth} data-panel-collapsed={!panels.some((panel) => panel.collapseOnNarrow && panel.open)}>
    {!narrow && (panelHeaderTarget ? createPortal(headers, panelHeaderTarget) : <div className="flex shrink-0 flex-wrap items-end justify-end border-b border-app-border">{headers}</div>)}
    <div className={`relative flex min-h-0 flex-1 overflow-hidden ${narrow ? "flex-col" : ""}`}>
      <main className={`relative isolate flex min-h-0 min-w-0 flex-col overflow-hidden bg-app-bg ${narrow ? "h-[42rem] flex-none" : "flex-1"}`}>{children}</main>
      {narrow && headers}
      <div data-panel-rail="" className={`relative z-30 min-h-0 shrink-0 ${narrow && openTabs.length ? "h-96 border-t border-app-border" : ""}`} style={{ width: railWidth }}>
        {openTabs.length > 0 && !narrow && <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={m.spectate_resize_panel()}
          aria-valuemin={railMinimum} aria-valuemax={railMaximum} aria-valuenow={railWidth}
          className="absolute inset-y-0 -left-1.5 z-50 w-3 cursor-col-resize touch-none outline-none focus-visible:bg-app-accent/30"
          onPointerDown={(event) => beginResize(event)} onPointerMove={move} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} onKeyDown={(event) => keyboardResize(event)} />}
        <aside ref={panelBody} onScroll={(event) => { if (panelHeaders.current) panelHeaders.current.scrollLeft = event.currentTarget.scrollLeft; }}
          className={`flex h-full min-h-0 w-full overflow-y-hidden border-l border-app-border bg-app-bg ${narrow ? "overflow-x-hidden" : "overflow-x-auto"}`} aria-label={m.spectate_telemetry()}>
          {openTabs.map((panel, index) => <section key={panel.id} id={panel.id} aria-label={panel.label}
            className="relative flex h-full shrink-0 flex-col overflow-hidden border-l border-app-border bg-app-bg" style={{ width: narrow ? "100%" : panel.width }}>
            {index > 0 && !narrow && <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={m.spectate_resize_between({ left: openTabs[index - 1]!.label, right: panel.label })}
              aria-valuemin={clampWidth(0, available)}
              aria-valuemax={clampWidth(available, available)}
              aria-valuenow={openTabs[index - 1]!.width}
              className="absolute inset-y-0 left-0 z-40 w-3 cursor-col-resize touch-none outline-none focus-visible:bg-app-accent/30"
              onPointerDown={(event) => beginResize(event, openTabs[index - 1]!.id)} onPointerMove={move} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize}
              onKeyDown={(event) => keyboardResize(event, openTabs[index - 1]!.id)} />}
            {panel.content}
          </section>)}
        </aside>
      </div>
    </div>
  </div>;
}
