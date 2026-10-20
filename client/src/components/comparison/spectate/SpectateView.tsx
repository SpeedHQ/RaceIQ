import { useCompareLineSpread } from "@/hooks/laps";
import { SpectateLineScore } from "./SpectateLineScore";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { m } from "@/paraglide/messages";
import { CompareAiPanel } from "../CompareAiPanel";
import { formatLapTime } from "@/lib/format";
import { SpectateScene } from "./SpectateScene";
import { SpectateTelemetryPanel } from "./SpectateTelemetryPanel";
import { SpectateCarPanel } from "./SpectateCarPanel";
import { SpectateOverview } from "./SpectateOverview";
import { SpectateInputs } from "./SpectateInputs";
import { SpectatePlayback } from "./SpectatePlayback";
import type { SpectateController, SpectatePair, SpectateSegment } from "./types";
import { buildSpectateFocus, type SpectateFocusMode } from "./spectate-focus";
import { SpectateFocusToolbar } from "./SpectateFocusToolbar";
const STORAGE_KEY = "spectate-panel-width";
const DEFAULT_WIDTH = 310;
const MIN_WIDTH = 270;
const CAR_PANEL_WIDTH = 384;
const MAX_WIDTH = 650;
const MIN_SCENE_WIDTH = 320;
function clampWidth(value: number, available: number) {
  const maximum = Math.min(MAX_WIDTH, available * 0.88);
  const minimum = Math.min(MIN_WIDTH, maximum);
  return Math.round(Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : DEFAULT_WIDTH)));
}
export function SpectateView({
  pair,
  controller,
  outline,
  segments,
  aiOpen,
  telemetryOpen,
  carPanelOpen,
  onTelemetryOpenChange,
  onCarPanelOpenChange,
  panelHeaderTarget,
  onAiOpenChange,
}: {
  pair: SpectatePair;
  controller: SpectateController;
  outline: readonly { x: number; z: number }[] | null;
  segments: readonly SpectateSegment[];
  aiOpen: boolean;
  telemetryOpen: boolean;
  carPanelOpen: boolean;
  onTelemetryOpenChange: (open: boolean) => void;
  onCarPanelOpenChange: (open: boolean) => void;
  panelHeaderTarget: HTMLDivElement | null;
  onAiOpenChange: (open: boolean) => void;
}) {
  const lineSpread = useCompareLineSpread(pair.gameId, [pair.comparison.lapA.id, pair.comparison.lapB.id]);
  const [focusMode, setFocusMode] = useState<SpectateFocusMode>("inputs");
  const focus = useMemo(() => buildSpectateFocus(pair, focusMode), [pair, focusMode]);
  const root = useRef<HTMLDivElement>(null);
  const panelHeaders = useRef<HTMLDivElement>(null);
  const panelBody = useRef<HTMLElement>(null);
  const focusedPanelTab = useRef<string | null>(null);
  const drag = useRef<{ pointer: number; startX: number; startWidth: number } | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [telemetryHeaderControls, setTelemetryHeaderControls] = useState<HTMLDivElement | null>(null);
  const [aiHeaderControls, setAiHeaderControls] = useState<HTMLDivElement | null>(null);
  const collapsed = !telemetryOpen;
  const [viewport, setViewport] = useState(typeof window === "undefined" ? 1024 : window.innerWidth);
  const narrow = viewport <= 800;
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const availableWorkspaceWidth = root.current?.clientWidth || workspaceWidth || viewport;
  const panelRailMaxWidth = narrow ? "88vw" : Math.max(0, availableWorkspaceWidth - Math.min(MIN_SCENE_WIDTH, availableWorkspaceWidth * 0.5));
  const aiWidth = clampWidth(DEFAULT_WIDTH, root.current?.clientWidth || viewport);
  const setPanelWidth = useCallback((next: number, persist = true) => {
    const value = clampWidth(next, root.current?.clientWidth || window.innerWidth);
    setWidth(value);
    if (persist)
      try {
        localStorage.setItem(STORAGE_KEY, String(value));
      } catch {
        /* storage may be unavailable */
      }
  }, []);
  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(STORAGE_KEY));
      if (Number.isFinite(stored) && stored > 0) setPanelWidth(stored, false);
    } catch {
      /* storage may be unavailable */
    }
    let previousViewport = window.innerWidth;
    const update = () => {
      const next = window.innerWidth;
      setViewport(next);
      if (next <= 800 && previousViewport > 800) onTelemetryOpenChange(false);
      previousViewport = next;
      const available = root.current?.clientWidth || window.innerWidth;
      setWorkspaceWidth(available);
      setWidth((current) => clampWidth(current, available));
    };
    const observer = new ResizeObserver(() => {
      const available = root.current?.clientWidth || window.innerWidth;
      setWorkspaceWidth(available);
      setWidth((current) => clampWidth(current, available));
    });
    if (root.current) observer.observe(root.current);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [setPanelWidth, onTelemetryOpenChange]);
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, startX: event.clientX, startWidth: width };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    setPanelWidth(drag.current.startWidth + drag.current.startX - event.clientX);
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
  };
  const keyboardResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setPanelWidth(width + (event.key === "ArrowLeft" ? 20 : -20));
  };
  const carPanelWidth = narrow ? Math.min(CAR_PANEL_WIDTH, viewport * 0.88) : CAR_PANEL_WIDTH;
  const panelTabs = [
    { id: "spectate-telemetry-panel", label: m.spectate_telemetry(), open: telemetryOpen, width, closedWidth: 100, toggle: onTelemetryOpenChange },
    { id: "spectate-2d-panel", label: "Car layout", open: carPanelOpen, width: carPanelWidth, closedWidth: 88, toggle: onCarPanelOpenChange },
    { id: "spectate-ai-panel", label: m.label_ai_analysis(), open: aiOpen, width: aiWidth, closedWidth: 112, toggle: onAiOpenChange },
  ];
  const firstOpenTab = panelTabs.findIndex((tab) => tab.open);
  const leadingClosedTabs = panelTabs.slice(0, firstOpenTab < 0 ? panelTabs.length : firstOpenTab);
  useLayoutEffect(() => {
    const id = focusedPanelTab.current;
    if (!id || !panelHeaderTarget) return;
    panelHeaderTarget.querySelector<HTMLButtonElement>(`[data-panel-toggle="${id}"]`)?.focus();
    focusedPanelTab.current = null;
  }, [telemetryOpen, carPanelOpen, aiOpen, panelHeaderTarget]);
  const openPanelsWidth = (telemetryOpen ? width : 0) + (carPanelOpen ? carPanelWidth : 0) + (aiOpen ? aiWidth : 0);
  const renderPanelTab = (tab: (typeof panelTabs)[number], reservedWidth = 0) => (
    <div key={tab.id} data-panel-header={tab.id}
      className={`flex h-10 shrink-0 items-center border-b-2 border-l border-l-app-border bg-app-bg ${tab.open ? "border-b-app-accent" : "border-b-transparent"}`}
      style={{ width: tab.open ? tab.width : tab.closedWidth, paddingRight: reservedWidth }}>
      <button data-panel-toggle={tab.id} type="button" aria-pressed={tab.open} aria-expanded={tab.open} aria-controls={tab.open ? tab.id : undefined}
        onClick={() => { focusedPanelTab.current = tab.id; tab.toggle(!tab.open); }}
        className={`flex h-full min-w-0 flex-1 items-center px-3 text-left text-app-label focus-visible:outline-2 focus-visible:outline-app-accent ${tab.open ? "text-app-accent" : "text-app-text-secondary hover:text-app-text"}`}>
        <span className="truncate">{tab.label}</span>
      </button>
      {tab.open && tab.id === "spectate-telemetry-panel" && <div ref={setTelemetryHeaderControls} className="shrink-0 pr-3" />}
      {tab.open && tab.id === "spectate-ai-panel" && <div ref={setAiHeaderControls} className="shrink-0 pr-3" />}
    </div>
  );
  return (
    <div
      ref={root}
      className="relative flex min-h-[28rem] flex-1 w-full overflow-hidden bg-app-bg @5xl/workspace:min-h-0"
      style={pair.gameId === "f1-2025" && narrow ? { minHeight: 680 } : undefined}
      data-spectate-view=""
      data-panel-width={width}
      data-panel-collapsed={collapsed}
    >
      {panelHeaderTarget && createPortal(
        <>
          {leadingClosedTabs.length > 0 && <div className="flex shrink-0">
            {leadingClosedTabs.map((tab) => renderPanelTab(tab))}
          </div>}
          <div ref={panelHeaders} data-spectate-panel-headers="" className="flex shrink-0 overflow-x-auto"
            style={{ width: openPanelsWidth, maxWidth: panelRailMaxWidth }}
            onScroll={(event) => { if (panelBody.current) panelBody.current.scrollLeft = event.currentTarget.scrollLeft; }}>
            {panelTabs.map((tab, index) => {
              if (!tab.open) return null;
              const followingTabs = panelTabs.slice(index + 1);
              const nextOpen = followingTabs.findIndex((next) => next.open);
              const closedTabs = followingTabs.slice(0, nextOpen < 0 ? followingTabs.length : nextOpen);
              const reservedWidth = closedTabs.reduce((total, closedTab) => total + closedTab.closedWidth, 0);
              return <div key={tab.id} className="relative shrink-0" style={{ width: tab.width }}>
                {renderPanelTab(tab, reservedWidth)}
                {closedTabs.length > 0 && <div className="absolute right-0 bottom-0 flex">
                  {closedTabs.map((closedTab) => renderPanelTab(closedTab))}
                </div>}
              </div>;
            })}
          </div>
        </>,
        panelHeaderTarget,
      )}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-bg">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <SpectateScene pair={pair} controller={controller} outline={outline} focus={focus}
            overview={<SpectateOverview pair={pair} controller={controller} segments={segments} focus={focus} />} />
          <SpectateFocusToolbar focus={focus} onChange={setFocusMode} />
          <SpectateLineScore trace={lineSpread.data} pair={pair} controller={controller} />
          <SpectateInputs pair={pair} controller={controller} />
        </div>
        <SpectatePlayback controller={controller} pair={pair} />
      </main>
      <aside ref={panelBody}
        onScroll={(event) => { if (panelHeaders.current) panelHeaders.current.scrollLeft = event.currentTarget.scrollLeft; }}
        className={`inset-y-0 z-30 flex min-h-0 shrink-0 overflow-x-auto overflow-y-hidden border-l border-app-border bg-app-bg ${narrow ? "absolute right-0" : "relative"}`}
        style={{ width: openPanelsWidth, maxWidth: panelRailMaxWidth }}
        aria-label={m.spectate_telemetry()}>
        {!collapsed && <section id="spectate-telemetry-panel" aria-label={m.spectate_telemetry()} className="relative h-full shrink-0 bg-app-bg" style={{ width }}>
          <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={m.spectate_resize_panel()}
            aria-valuemin={Math.min(MIN_WIDTH, width)} aria-valuemax={clampWidth(MAX_WIDTH, root.current?.clientWidth || viewport)}
            aria-valuenow={width} className="absolute left-0 top-0 z-40 h-full w-3 cursor-col-resize touch-none outline-none focus-visible:bg-app-accent/30"
            onPointerDown={resize} onPointerMove={move} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} onKeyDown={keyboardResize} />
          <SpectateTelemetryPanel pair={pair} controller={controller} headerTarget={telemetryHeaderControls} />
        </section>}
        {carPanelOpen && <section id="spectate-2d-panel" aria-label="Car layout" className="h-full shrink-0 overflow-hidden border-l border-app-border bg-app-bg" style={{ width: carPanelWidth }}>
          <SpectateCarPanel pair={pair} controller={controller} />
        </section>}
        {aiOpen && <section id="spectate-ai-panel" aria-label={m.label_ai_analysis()} className="h-full shrink-0 overflow-y-auto border-l border-app-border bg-app-bg" style={{ width: aiWidth }}>
          <CompareAiPanel panelOpen headerTarget={aiHeaderControls} lapA={{ id: pair.comparison.lapA.id,
            label: `${m.compare_lap_label()} ${pair.comparison.lapA.lapNumber} (${formatLapTime(pair.comparison.lapA.lapTime)})`,
            lapTime: pair.comparison.lapA.lapTime }} lapB={{ id: pair.comparison.lapB.id,
            label: `${m.compare_lap_label()} ${pair.comparison.lapB.lapNumber} (${formatLapTime(pair.comparison.lapB.lapTime)})` ,
            lapTime: pair.comparison.lapB.lapTime }} segments={segments.map(({ name, startFrac, endFrac }) => ({ name, startFrac, endFrac }))} />
        </section>}
      </aside>
    </div>
  );
}
