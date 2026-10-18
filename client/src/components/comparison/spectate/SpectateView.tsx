import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronLeft } from "lucide-react";
import { m } from "@/paraglide/messages";
import { SpectateScene } from "./SpectateScene";
import { SpectateTelemetryPanel } from "./SpectateTelemetryPanel";
import { SpectateOverview } from "./SpectateOverview";
import { SpectateInputs } from "./SpectateInputs";
import { SpectatePlayback } from "./SpectatePlayback";
import type { SpectateController, SpectatePair, SpectateSegment } from "./types";

const STORAGE_KEY = "spectate-panel-width";
const MIN_WIDTH = 270;
const MAX_WIDTH = 650;
function clampWidth(value: number, available: number) {
  const maximum = Math.min(MAX_WIDTH, available * 0.88);
  const minimum = Math.min(MIN_WIDTH, maximum);
  return Math.round(Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : 310)));
}
export function SpectateView({
  pair,
  controller,
  outline,
  segments,
}: {
  pair: SpectatePair;
  controller: SpectateController;
  outline: readonly { x: number; z: number }[] | null;
  segments: readonly SpectateSegment[];
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number } | null>(null);
  const [width, setWidth] = useState(310);
  const [collapsed, setCollapsed] = useState(typeof window !== "undefined" && window.innerWidth <= 800);
  const [viewport, setViewport] = useState(typeof window === "undefined" ? 1024 : window.innerWidth);
  const narrow = viewport <= 800;
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
    const update = () => {
      const next = window.innerWidth;
      setViewport(next);
      if (next <= 800) setCollapsed(true);
      const available = root.current?.clientWidth || window.innerWidth;
      setWidth((current) => clampWidth(current, available));
    };
    const observer = new ResizeObserver(() => {
      const available = root.current?.clientWidth || window.innerWidth;
      setWidth((current) => clampWidth(current, available));
    });
    if (root.current) observer.observe(root.current);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [setPanelWidth]);
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId || !root.current) return;
    const bounds = root.current.getBoundingClientRect();
    setPanelWidth(bounds.right - event.clientX);
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
  };
  const keyboardResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setPanelWidth(width + (event.key === "ArrowLeft" ? 20 : -20));
  };
  return (
    <div
      ref={root}
      className="relative flex min-h-[28rem] flex-1 w-full overflow-hidden bg-app-bg @5xl/workspace:min-h-0"
      style={pair.gameId === "f1-2025" && narrow ? { minHeight: 680 } : undefined}
      data-spectate-view=""
      data-panel-width={width}
      data-panel-collapsed={collapsed}
    >
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-bg">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <SpectateScene pair={pair} controller={controller} outline={outline} />
          <SpectateOverview pair={pair} controller={controller} segments={segments} />
          <SpectateInputs pair={pair} controller={controller} />
        </div>
        <SpectatePlayback controller={controller} />
      </main>
      {!collapsed && (
        <aside
          className={`z-30 flex min-h-0 flex-col bg-app-surface ${narrow ? "absolute inset-y-0 right-0 border-l border-app-border" : "relative shrink-0 border-l border-app-border"}`}
          style={{ width: narrow ? Math.min(width, (root.current?.clientWidth ?? viewport) * 0.88) : width }}
          aria-label={m.spectate_telemetry()}
        >
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={m.spectate_resize_panel()}
            aria-valuemin={Math.min(MIN_WIDTH, width)}
            aria-valuemax={clampWidth(MAX_WIDTH, root.current?.clientWidth || viewport)}
            aria-valuenow={width}
            className={`absolute top-0 z-40 h-full w-3 cursor-col-resize touch-none outline-none focus-visible:bg-app-accent/30 ${narrow ? "left-0" : "-left-1.5"}`}
            onPointerDown={resize}
            onPointerMove={move}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onKeyDown={keyboardResize}
          />
          <SpectateTelemetryPanel pair={pair} controller={controller} onClose={() => setCollapsed(true)} />
        </aside>
      )}
      {collapsed && (
        <button
          type="button"
          className="absolute right-3 top-3 z-40 flex items-center gap-1 rounded-sm border border-app-border bg-app-surface px-2.5 py-2 text-app-label text-app-text hover:text-app-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent"
          aria-label={m.spectate_show_telemetry()}
          aria-expanded={false}
          onClick={() => setCollapsed(false)}
        >
          <ChevronLeft size={14} />
          {m.spectate_telemetry()}
        </button>
      )}
    </div>
  );
}
