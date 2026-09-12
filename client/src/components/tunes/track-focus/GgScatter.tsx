import { useEffect, useMemo, useRef } from "react";
import type { LapTrace } from "../../../lib/stint-traces";
import { syncCanvasSize } from "../../../lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "../../../lib/rendering/css-canvas";
import { useMeasuredWidth } from "./use-measured-width";

interface GgScatterProps {
  traces: LapTrace[];
  primaryLapId: number | null;
  /** Shared cursor fraction (0..1) — the point nearest this fraction on each
   *  lap is highlighted so the scatter stays in sync with the lanes. */
  cursorFrac: number | null;
}

const H = 220;
/** Friction-circle reference rings, in g. */
const RINGS = [1, 1.5];
/** Fixed g-domain — a friction circle should read as a circle, not an
 *  ellipse, so both axes share the same scale regardless of container width. */
const G_RANGE = 2;

/** Index of the trace frame nearest a given lap fraction. */
function nearestIndex(t: LapTrace, f: number): number {
  const fr = t.frac;
  const n = fr.length;
  if (n <= 1) return 0;
  const target = Math.max(0, Math.min(1, f));
  if (target <= fr[0]) return 0;
  if (target >= fr[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fr[mid] <= target) lo = mid;
    else hi = mid;
  }
  return target - fr[lo] <= fr[hi] - target ? lo : hi;
}

/**
 * G-G friction-circle scatter: every valid lap's (latG, longG) points overlaid
 * — dim for regular laps, accent for the best lap. Friction-circle reference
 * rings show how much of the tyre's available grip is being used; a filled
 * envelope means the tyre is fully worked, a sparse quadrant means grip is
 * left on the table (e.g. trail-braking or corner-exit throttle). The point
 * at the shared cursor fraction is highlighted on every lap so this chart and
 * the lat/long lanes stay in sync while scrubbing.
 */
export function GgScatter({ traces, primaryLapId, cursorFrac }: GgScatterProps) {
  const { ref: wrapRef, width: bw } = useMeasuredWidth<HTMLDivElement>(320);
  const staticCanvasRef = useRef<HTMLCanvasElement>(null);
  const cursorCanvasRef = useRef<HTMLCanvasElement>(null);
  const withG = useMemo(() => traces.filter((t) => t.latG != null && t.longG != null), [traces]);
  const cursorActive = cursorFrac != null;

  const size = Math.min(bw, H);
  const cx = bw / 2;
  const cy = H / 2;
  const r = (size / 2 - 16) / G_RANGE;
  const px = (latG: number) => cx + latG * r;
  const py = (longG: number) => cy - longG * r;

  useEffect(() => {
    const canvas = staticCanvasRef.current;
    if (!canvas || withG.length === 0) return;
    const ctx = getSemanticCanvasContext(canvas);
    if (!ctx) return;
    syncCanvasSize(canvas, bw, H, window.devicePixelRatio || 1, false);
    ctx.setTransform(canvas.width / bw, 0, 0, canvas.height / H, 0, 0);
    ctx.clearRect(0, 0, bw, H);

    ctx.strokeStyle = "var(--app-border)";
    ctx.lineWidth = 1;
    for (const g of RINGS) {
      ctx.beginPath();
      ctx.setLineDash([2, 4]);
      ctx.arc(cx, cy, g * r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(bw, cy);
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, H);
    ctx.stroke();

    ctx.fillStyle = "var(--app-text-dim)";
    ctx.font = "var(--text-app-caption) var(--font-sans)";
    for (const g of RINGS) ctx.fillText(`${g}g`, cx + g * r + 2, cy - 2);
    ctx.fillText("right", bw - 30, cy - 4);
    ctx.fillText("left", 4, cy - 4);
    ctx.fillText("accel", cx + 4, 12);
    ctx.fillText("brake", cx + 4, H - 4);

    const drawTrace = (trace: LapTrace, radius: number, fill: string, alpha: number) => {
      ctx.beginPath();
      for (let i = 0; i < trace.n; i++) {
        ctx.moveTo(px(trace.latG![i]) + radius, py(trace.longG![i]));
        ctx.arc(px(trace.latG![i]), py(trace.longG![i]), radius, 0, Math.PI * 2);
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    for (const trace of withG) {
      if (trace.lapId === primaryLapId) continue;
      drawTrace(trace, 1.1, trace.isValid ? "var(--app-text-dim)" : "var(--status-danger)", trace.isValid ? 0.3 : 0.45);
    }
    const best = withG.find((trace) => trace.lapId === primaryLapId);
    if (best) drawTrace(best, 1.3, cursorActive ? "var(--app-text-dim)" : "var(--app-accent)", cursorActive ? 0.3 : 0.85);
  }, [primaryLapId, bw, cursorActive, cx, cy, r, withG]);

  useEffect(() => {
    const canvas = cursorCanvasRef.current;
    if (!canvas) return;
    const ctx = getSemanticCanvasContext(canvas);
    if (!ctx) return;
    syncCanvasSize(canvas, bw, H, window.devicePixelRatio || 1, false);
    ctx.setTransform(canvas.width / bw, 0, 0, canvas.height / H, 0, 0);
    ctx.clearRect(0, 0, bw, H);
    if (cursorFrac == null) return;

    let bestCursor: { x: number; y: number } | null = null;
    ctx.lineWidth = 1.5;
    for (const trace of withG) {
      const idx = nearestIndex(trace, cursorFrac);
      const x = px(trace.latG![idx]);
      const y = py(trace.longG![idx]);
      if (trace.lapId === primaryLapId) {
        bestCursor = { x, y };
        continue;
      }
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.strokeStyle = "var(--app-text)";
      ctx.stroke();
    }
    if (bestCursor) {
      ctx.beginPath();
      ctx.arc(bestCursor.x, bestCursor.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "var(--app-accent)";
      ctx.fill();
    }
  }, [primaryLapId, bw, cursorFrac, cx, cy, r, withG]);

  if (withG.length === 0) {
    return (
      <div>
        <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">G-G friction circle</div>
        <div className="h-[120px] flex items-center justify-center rounded bg-app-surface border border-app-border text-app-compact text-app-text-dim">No acceleration data for this game</div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="space-y-1">
      <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">G-G friction circle (lat vs long)</div>
      <div className="relative" style={{ height: H }}>
        <canvas ref={staticCanvasRef} className="absolute inset-0 h-full w-full" aria-label="G-G friction circle" />
        <canvas ref={cursorCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
      </div>
    </div>
  );
}
