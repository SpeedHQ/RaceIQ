import { useMemo } from "react";
import type { Pt } from "../track-map-geometry";
import { VIEW } from "../track-map-geometry";

const DEFAULT_RADIUS_M = 30;
/** Above this 0..1 activation a channel counts as "on". */
const INPUT_ON = 0.08;

const COLOR_BRAKE = "var(--ch-brake)";
const COLOR_THROTTLE = "var(--ch-throttle)";
const COLOR_COAST = "var(--app-text-dim)";

export type InputState = "brake" | "throttle" | "coast";

/** Classify a point's input state from its brake/throttle activation. Brake
 *  wins ties — trail-braking reads as braking, not coasting. */
export function inputState(brake: number, throttle: number): InputState {
  if (brake > INPUT_ON) return "brake";
  if (throttle > INPUT_ON) return "throttle";
  return "coast";
}

function stateColor(s: InputState): string {
  return s === "brake" ? COLOR_BRAKE : s === "throttle" ? COLOR_THROTTLE : COLOR_COAST;
}

export interface ZoomPoint {
  x: number;
  z: number;
  /** 0..1 input activation carried through for state coloring (edges omit these). */
  brake?: number;
  throttle?: number;
}

export interface ZoomLapWindow {
  lapId: number;
  points: ZoomPoint[];
}

export interface ZoomViewport {
  /** Mean position of every lap at the cursor — used to FRAME the window so the
   *  whole bundle stays in view. */
  center: ZoomPoint;
  /** Point the cursor dot is drawn at: the best (fastest) lap's position at the
   *  cursor, so the dot sits on a line that is actually drawn (falls back to the
   *  mean center when the best lap isn't in the pool). */
  dot: ZoomPoint;
  /** Per-lap points inside the ±radiusM window, plus one neighbor point each
   *  side of a run so polyline segments reach the window edge. */
  inWindow: ZoomLapWindow[];
  /** Track edges clipped to the same window (null when no edges supplied). */
  edges: { left: ZoomPoint[]; right: ZoomPoint[] } | null;
}

type ZoomLapLine = { lapId: number; x: number[]; z: number[]; brake?: number[]; throttle?: number[]; frac?: number[] };

/** Nearest index in a monotonic-ascending fraction array to `f`. */
function nearestIdxByFrac(fr: ArrayLike<number>, f: number): number {
  const n = fr.length;
  if (n === 0) return 0;
  if (f <= fr[0]) return 0;
  if (f >= fr[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fr[mid] <= f) lo = mid;
    else hi = mid;
  }
  return f - fr[lo] <= fr[hi] - f ? lo : hi;
}

/** Normalized cumulative chord length (0..1) — a distance-fraction proxy used
 *  when a lap line lacks a server-supplied `frac` array (old cache entries). */
function normCumLen(x: number[], z: number[]): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
    out[i] = acc;
  }
  if (acc > 0) for (let i = 0; i < n; i++) out[i] /= acc;
  return out;
}

/** Frame index of a lap at distance-fraction `cursorFrac` — by DistanceTraveled
 *  (server `frac`) when present, else cumulative chord length. NOT raw frame
 *  index: frames are uniform in time, so a frame-index fraction lands at the
 *  wrong physical point (past slow corners). */
function idxAtFrac(l: ZoomLapLine, cursorFrac: number): number {
  const fr = l.frac ?? normCumLen(l.x, l.z);
  return nearestIdxByFrac(fr, cursorFrac);
}

/**
 * Points from parallel arrays that fall inside a ±radiusM box around `center`,
 * plus a single neighbor point each side of a contiguous run so the drawn
 * segment reaches the box edge instead of stopping short. Optional `brake`/
 * `throttle` arrays are carried onto each kept point for state coloring.
 */
function windowPoints(x: number[], z: number[], center: ZoomPoint, radiusM: number, brake?: number[], throttle?: number[]): ZoomPoint[] {
  const at = (i: number): ZoomPoint => ({ x: x[i], z: z[i], brake: brake?.[i], throttle: throttle?.[i] });
  const points: ZoomPoint[] = [];
  let prevInside = false;
  for (let i = 0; i < x.length; i++) {
    const inside = Math.abs(x[i] - center.x) <= radiusM && Math.abs(z[i] - center.z) <= radiusM;
    if (inside) {
      if (!prevInside && i > 0) points.push(at(i - 1));
      points.push(at(i));
    } else if (prevInside) {
      points.push(at(i));
    }
    prevInside = inside;
  }
  return points;
}

/**
 * Pure windowing math for the zoom view: the mean position of every lap at
 * the bin nearest `cursorFrac`, and each lap's points that fall inside a
 * ±radiusM box around that center. No React, no DOM — safe to unit test.
 */
export function zoomViewport(lapLines: ZoomLapLine[], cursorFrac: number, radiusM: number = DEFAULT_RADIUS_M, edges?: { left: Pt[]; right: Pt[] } | null, bestLapId?: number | null): ZoomViewport {
  if (lapLines.length === 0 || (lapLines[0]?.x.length ?? 0) === 0) return { center: { x: 0, z: 0 }, dot: { x: 0, z: 0 }, inWindow: [], edges: null };

  // Raw laps differ in frame count AND are uniform in time (not distance), so
  // index each by its own DISTANCE fraction at cursorFrac (via idxAtFrac), not
  // a raw frame-index fraction.
  let sx = 0;
  let sz = 0;
  let dot: ZoomPoint | null = null;
  for (const l of lapLines) {
    const idx = idxAtFrac(l, cursorFrac);
    sx += l.x[idx];
    sz += l.z[idx];
    // Anchor the dot to the best lap's point so it lands on the thick, visible line.
    if (bestLapId != null && l.lapId === bestLapId) dot = { x: l.x[idx], z: l.z[idx] };
  }
  const center = { x: sx / lapLines.length, z: sz / lapLines.length };

  const inWindow: ZoomLapWindow[] = lapLines.map((l) => ({ lapId: l.lapId, points: windowPoints(l.x, l.z, center, radiusM, l.brake, l.throttle) }));

  const windowedEdges = edges
    ? {
        left: windowPoints(
          edges.left.map((p) => p.x),
          edges.left.map((p) => p.z),
          center,
          radiusM,
        ),
        right: windowPoints(
          edges.right.map((p) => p.x),
          edges.right.map((p) => p.z),
          center,
          radiusM,
        ),
      }
    : null;

  return { center, dot: dot ?? center, inWindow, edges: windowedEdges };
}

interface TrackFocusZoomProps {
  lapLines: { lapId: number; x: number[]; z: number[]; brake: number[]; throttle: number[]; frac?: number[] }[];
  bestLapId: number | null;
  /** 0..1, drives the window center point. */
  cursorFrac: number;
  /** Half-window in metres (window is radiusM * 2 across). Default 60. */
  radiusM?: number;
  /** Track edges in the same world space as the lap lines (already flipped to
   *  match the negated telemetry) — drawn as faint boundaries under the lines. */
  edges?: { left: Pt[]; right: Pt[] } | null;
}

/**
 * Zoomed-in section of the track (same VIEW=300 viewbox as TrackFocusMap, so
 * it swaps in/out cleanly) centered on the cursor's track point. Every clean
 * lap's line is drawn as thin per-point segments colored by input state —
 * red braking, gray coasting, green on throttle — so both line-to-line spread
 * and where each lap brakes/accelerates are directly visible. The best lap is
 * drawn thicker. Pure/presentational — no data fetching.
 */
export function TrackFocusZoom({ lapLines, bestLapId, cursorFrac, radiusM = DEFAULT_RADIUS_M, edges }: TrackFocusZoomProps) {
  const viewport = useMemo(() => (lapLines.length > 0 ? zoomViewport(lapLines, cursorFrac, radiusM, edges, bestLapId) : null), [lapLines, cursorFrac, radiusM, edges, bestLapId]);

  const totalPoints = viewport ? viewport.inWindow.reduce((sum, l) => sum + l.points.length, 0) : 0;

  if (!viewport || lapLines.length === 0 || totalPoints < 2) {
    return <div className="aspect-square rounded bg-app-surface border border-app-border flex items-center justify-center text-[11px] text-app-text-dim">no line data</div>;
  }

  const { center, dot, inWindow, edges: windowedEdges } = viewport;
  const scale = VIEW / (radiusM * 2);
  const minZ = center.z - radiusM;
  // Same orientation as track-map-geometry / TrackDetail: mirror X (inputs are
  // negated-X telemetry space), Z straight down.
  const maxX = center.x + radiusM;
  const px = (x: number) => (maxX - x) * scale;
  const py = (z: number) => (z - minZ) * scale;

  // Dot sits on the best-lap line; window stays framed on the mean.
  const dotPx = px(dot.x);
  const dotPy = py(dot.z);
  const edgePolyline = (pts: ZoomPoint[]) => pts.map((p) => `${px(p.x).toFixed(1)},${py(p.z).toFixed(1)}`).join(" ");

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${VIEW} ${VIEW}`} width="100%" height="100%" className="aspect-square">
        {windowedEdges && windowedEdges.left.length > 1 && <polyline points={edgePolyline(windowedEdges.left)} fill="none" stroke="var(--app-border)" strokeWidth={1} />}
        {windowedEdges && windowedEdges.right.length > 1 && <polyline points={edgePolyline(windowedEdges.right)} fill="none" stroke="var(--app-border)" strokeWidth={1} />}
        {inWindow.map((l) => {
          const isBest = l.lapId === bestLapId;
          const w = isBest ? 1.6 : 0.8;
          const op = isBest ? 1 : 0.55;
          // One <line> per consecutive pair, colored by the segment's leading
          // point input state (brake wins ties). Keys are built here rather
          // than from the render index so they do not depend on array position.
          const segments = l.points.slice(0, -1).map((p, i) => ({
            key: `${l.lapId}-${i}`,
            p,
            q: l.points[i + 1],
            color: stateColor(inputState(p.brake ?? 0, p.throttle ?? 0)),
          }));
          return segments.map(({ key, p, q, color }) => <line key={key} x1={px(p.x)} y1={py(p.z)} x2={px(q.x)} y2={py(q.z)} stroke={color} strokeWidth={w} strokeLinecap="round" opacity={op} />);
        })}
        <circle cx={dotPx} cy={dotPy} r={4} fill="var(--app-accent)" stroke="var(--app-bg)" strokeWidth={1.2} />
      </svg>
      <div className="absolute top-1 right-1 text-[10px] font-mono tabular-nums bg-app-surface/80 border border-app-border rounded px-1.5 py-0.5 text-app-text-muted">±{radiusM}m</div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-app-text-dim">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: COLOR_BRAKE }} /> brake
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: COLOR_COAST }} /> coast
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: COLOR_THROTTLE }} /> throttle
        </span>
      </div>
    </div>
  );
}
