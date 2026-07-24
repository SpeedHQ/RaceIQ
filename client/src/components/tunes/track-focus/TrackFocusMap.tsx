import type { TelemetryPacket, TuneIssue } from "@shared/types";
import { useMemo, useRef } from "react";
import type { LineSpreadTrace, TrackCorner } from "../../../hooks/queries";
import { buildGeometry, type Pt, projectPoint, type SectorTimesLite, VIEW } from "../track-map-geometry";
import { nearestCornerLabel } from "./detect-corners";

// Same threshold server-side (server/lap-consistency.ts LINE_SPREAD_THRESHOLD_M).
const LINE_SPREAD_THRESHOLD_M = 1.5;

function spreadColor(spreadM: number): string {
  if (spreadM > LINE_SPREAD_THRESHOLD_M * 2) return "var(--color-dynamics-red, #ef4444)";
  if (spreadM > LINE_SPREAD_THRESHOLD_M) return "var(--color-dynamics-amber, #f59e0b)";
  return "var(--color-dynamics-green, #34d399)";
}

/** Linear-interpolate `spreadM` at fraction `f` along the trace's own fracs array. */
function spreadAt(trace: LineSpreadTrace, f: number): number {
  const { fracs, spreadM } = trace;
  const n = fracs.length;
  if (n === 0) return 0;
  if (n === 1 || f <= fracs[0]) return spreadM[0];
  if (f >= fracs[n - 1]) return spreadM[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fracs[mid] <= f) lo = mid;
    else hi = mid;
  }
  const span = fracs[hi] - fracs[lo];
  if (span <= 0) return spreadM[lo];
  const t = (f - fracs[lo]) / span;
  return spreadM[lo] + (spreadM[hi] - spreadM[lo]) * t;
}

interface TrackFocusMapProps {
  telemetry: TelemetryPacket[] | null;
  sectorTimes: SectorTimesLite | null;
  edges: { left: Pt[]; right: Pt[] } | null;
  corners: TrackCorner[];
  /** Apex lap-fraction (0..1) for each entry in `corners`, same order — used
   *  to place corner labels and drive the cursor's "nearest corner" chip.
   *  Falls back to `distanceStart` when omitted. */
  cornerFracs?: number[];
  issues: TuneIssue[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
  /** Per-lap brake/throttle onset fracs to overlay as dots on the driven
   *  line (set while hovering a Corner Ledger row, null otherwise). */
  overlayPoints?: { brake: number[]; throttle: number[] } | null;
  /** Racing-line consistency trace (Consistency tab only, null otherwise) —
   *  when present and non-empty, colors the driven line by lateral spread
   *  instead of the default sector coloring. */
  lineSpread?: LineSpreadTrace | null;
}

const SEV_COLOR: Record<string, string> = {
  critical: "var(--color-dynamics-red, #ef4444)",
  warn: "var(--color-dynamics-amber, #f59e0b)",
  info: "#38bdf8",
};

/**
 * Focus-lap track map: driven line (3 sector-colored segments), optional
 * track edges, corner markers, issue dots (severity-colored, critical gets a
 * halo), a cursor dot synced to `cursorFrac`, and a "nearest corner" chip
 * that tracks the cursor (or the lap
 * average when no cursor is set).
 */
export function TrackFocusMap({ telemetry, sectorTimes, edges, corners, cornerFracs, issues, cursorFrac, onCursorFrac, overlayPoints, lineSpread }: TrackFocusMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  const geometry = useMemo(() => (telemetry ? buildGeometry(telemetry, sectorTimes, edges) : null), [telemetry, sectorTimes, edges]);

  // Per-frame normalized distance fraction (0..1 by DistanceTraveled). The
  // shared `cursorFrac` and the lineSpread trace are distance fractions, but
  // telemetry frames are uniform in TIME, not distance (dense in slow corners).
  // Mapping frac<->frame via array index would misplace the cursor, corner and
  // issue dots, and smear the heat coloring longitudinally. Use the real
  // distance instead (fall back to index fraction when DistanceTraveled is flat).
  const normDist = useMemo(() => {
    if (!telemetry || telemetry.length === 0) return null;
    const n = telemetry.length;
    const first = telemetry[0].DistanceTraveled;
    const span = telemetry[n - 1].DistanceTraveled - first;
    const out = new Float32Array(n);
    if (span > 0) {
      for (let i = 0; i < n; i++) {
        const f = (telemetry[i].DistanceTraveled - first) / span;
        out[i] = f < 0 ? 0 : f > 1 ? 1 : f;
      }
    } else {
      for (let i = 0; i < n; i++) out[i] = n > 1 ? i / (n - 1) : 0;
    }
    return out;
  }, [telemetry]);

  // Nearest frame index for a distance fraction `f` (binary search on the
  // monotonic normDist array). Replaces the old round(frac*(len-1)) index math.
  function distFracToIdx(f: number): number {
    if (!normDist || normDist.length === 0) return 0;
    const n = normDist.length;
    if (f <= normDist[0]) return 0;
    if (f >= normDist[n - 1]) return n - 1;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (normDist[mid] <= f) lo = mid;
      else hi = mid;
    }
    return f - normDist[lo] <= normDist[hi] - f ? lo : hi;
  }

  // Heat-colored driven-line segments (Consistency tab, when a trace with at
  // least one bin is available) — one <line> per consecutive point pair,
  // colored by the trimmed lateral spread at that point's lap fraction.
  const heatSegments = useMemo(() => {
    if (!geometry || !telemetry || telemetry.length < 2 || !normDist || !lineSpread || lineSpread.spreadM.length === 0) return null;
    const segs: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];
    for (let i = 1; i < geometry.pts.length; i++) {
      const a = geometry.pts[i - 1];
      const b = geometry.pts[i];
      // Color by the segment point's DISTANCE fraction so the heat aligns with
      // the distance-fraction spread trace (not the frame-index fraction).
      const frac = normDist[b.idx];
      segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: spreadColor(spreadAt(lineSpread, frac)) });
    }
    return segs;
  }, [geometry, telemetry, normDist, lineSpread]);

  // Centroid of the driven line, used to push corner labels outward along
  // the vector from centroid -> apex so they don't sit on top of the track.
  const centroid = useMemo(() => {
    if (!geometry || geometry.pts.length === 0) return null;
    let sx = 0;
    let sy = 0;
    for (const p of geometry.pts) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / geometry.pts.length, y: sy / geometry.pts.length };
  }, [geometry]);

  function fracToPoint(frac: number): { x: number; y: number } | null {
    if (!telemetry || telemetry.length === 0) return null;
    const idx = distFracToIdx(frac);
    const t = telemetry[idx];
    return projectPoint({ x: t.PositionX, z: t.PositionZ }, telemetry, edges);
  }

  // A short tick mark across the driven line at `frac`, oriented perpendicular
  // to the local track direction (from the neighbouring sample).
  function fracToTick(frac: number, half = 4): { x1: number; y1: number; x2: number; y2: number } | null {
    if (!telemetry || telemetry.length < 2) return null;
    const n = telemetry.length;
    const idx = distFracToIdx(frac);
    const p = fracToPoint(frac);
    const aIdx = Math.max(0, idx - 1);
    const bIdx = Math.min(n - 1, idx + 1);
    const a = projectPoint({ x: telemetry[aIdx].PositionX, z: telemetry[aIdx].PositionZ }, telemetry, edges);
    const b = projectPoint({ x: telemetry[bIdx].PositionX, z: telemetry[bIdx].PositionZ }, telemetry, edges);
    if (!p || !a || !b) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Perpendicular unit vector.
    const nx = -dy / len;
    const ny = dx / len;
    return { x1: p.x - nx * half, y1: p.y - ny * half, x2: p.x + nx * half, y2: p.y + ny * half };
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!geometry || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * VIEW;
    const my = ((e.clientY - rect.top) / rect.height) * VIEW;
    let best = geometry.pts[0];
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of geometry.pts) {
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    // Emit the nearest frame's DISTANCE fraction so lanes/ledgers (distance-frac)
    // receive the cursor in the same space they render in.
    if (best && normDist) onCursorFrac(normDist[best.idx]);
  }

  const cursorIdx = cursorFrac != null && telemetry ? distFracToIdx(cursorFrac) : null;
  const cursorPt = cursorFrac != null ? fracToPoint(cursorFrac) : null;
  const readoutFrame = cursorIdx != null && telemetry ? telemetry[cursorIdx] : null;

  const cornerApexFracs = useMemo(() => corners.map((c, i) => cornerFracs?.[i] ?? c.distanceStart), [corners, cornerFracs]);
  // Suppress the "nearest corner" chip while the brake/throttle overlay is
  // active (hovering/pinning a ledger row) so no turn label lingers.
  const hoveredCornerLabel = cursorFrac != null && !overlayPoints ? nearestCornerLabel(corners, cornerApexFracs, cursorFrac) : null;

  return (
    <div className="space-y-2">
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          width="100%"
          height="100%"
          className="aspect-square"
          style={{ cursor: geometry ? "crosshair" : "default" }}
          onMouseMove={onMove}
          onMouseLeave={() => onCursorFrac(null)}
        >
          {!geometry && (
            <text x={VIEW / 2} y={VIEW / 2} textAnchor="middle" fontSize={10} fill="var(--color-app-text-dim, #7a8ea0)">
              No telemetry
            </text>
          )}
          {geometry?.leftEdge && <polyline points={geometry.leftEdge} fill="none" stroke="var(--color-app-border, #2a2a2a)" strokeWidth={1} />}
          {geometry?.rightEdge && <polyline points={geometry.rightEdge} fill="none" stroke="var(--color-app-border, #2a2a2a)" strokeWidth={1} />}
          {heatSegments
            ? heatSegments.map((s, i) => <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.color} strokeWidth={2.5} strokeLinecap="round" />)
            : (["s1", "s2", "s3"] as const).map((segKey, i) => (
                <polyline key={segKey} points={geometry?.segments[i]} fill="none" stroke={["#f87171", "#60a5fa", "#facc15"][i]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              ))}
          {!overlayPoints &&
            corners.map((c, i) => {
              const apexFrac = cornerApexFracs[i];
              const pt = fracToPoint(apexFrac);
              if (!pt) return null;
              const isActive = hoveredCornerLabel === c.label;
              // Offset the label outward along the vector from the track's
              // centroid to the apex point so it clears the driven line.
              let ox = 0;
              let oy = -8;
              if (centroid) {
                const dx = pt.x - centroid.x;
                const dy = pt.y - centroid.y;
                const len = Math.hypot(dx, dy) || 1;
                ox = (dx / len) * 10;
                oy = (dy / len) * 10;
              }
              const color = isActive ? "var(--color-app-accent, #22d3ee)" : "var(--color-app-text-dim, #7a8ea0)";
              return (
                <g key={c.index}>
                  <circle cx={pt.x} cy={pt.y} r={isActive ? 3.5 : 2.5} fill={color} stroke="#020617" strokeWidth={0.75} />
                  <text x={pt.x + ox} y={pt.y + oy} textAnchor="middle" fontFamily="var(--font-mono, monospace)" fontSize={isActive ? 8.5 : 7.5} fontWeight={isActive ? 700 : 400} fill={color}>
                    {c.label}
                  </text>
                </g>
              );
            })}
          {!overlayPoints &&
            issues.map((it) => {
              if (it.distanceFrac == null) return null;
              const pt = fracToPoint(it.distanceFrac);
              if (!pt) return null;
              const color = SEV_COLOR[it.severity] ?? SEV_COLOR.info;
              return (
                <g key={`${it.kind}-${it.corner ?? ""}-${it.distanceFrac}-${it.detail}`}>
                  {it.severity === "critical" && <circle cx={pt.x} cy={pt.y} r={6} fill={color} opacity={0.25} />}
                  <circle cx={pt.x} cy={pt.y} r={3} fill={color} stroke="#020617" strokeWidth={1} />
                </g>
              );
            })}
          {overlayPoints?.brake.map((f, i) => {
            const tk = fracToTick(f);
            if (!tk) return null;
            return <line key={`ob-${i}`} x1={tk.x1} y1={tk.y1} x2={tk.x2} y2={tk.y2} stroke="var(--color-ch-brake, #ef4444)" strokeWidth={1.5} strokeLinecap="round" />;
          })}
          {overlayPoints?.throttle.map((f, i) => {
            const tk = fracToTick(f);
            if (!tk) return null;
            return <line key={`ot-${i}`} x1={tk.x1} y1={tk.y1} x2={tk.x2} y2={tk.y2} stroke="var(--color-ch-throttle, #059669)" strokeWidth={1.5} strokeLinecap="round" />;
          })}
          {cursorPt && <circle cx={cursorPt.x} cy={cursorPt.y} r={4} fill="var(--color-app-accent, #22d3ee)" stroke="#020617" strokeWidth={1.2} />}
        </svg>
        {cursorFrac != null && cursorPt ? (
          (() => {
            const leftPct = (cursorPt.x / VIEW) * 100;
            const topPct = (cursorPt.y / VIEW) * 100;
            const flipX = leftPct > 60;
            const flipY = topPct > 70;
            const speed = readoutFrame ? `${(readoutFrame.Speed * 3.6).toFixed(0)} km/h` : null;
            return (
              <div
                className="absolute pointer-events-none text-[10px] font-mono tabular-nums bg-app-surface-alt/95 border border-app-border rounded px-1.5 py-0.5 text-app-text-muted whitespace-nowrap shadow"
                style={{
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  transform: `translate(${flipX ? "-110%" : "10px"}, ${flipY ? "calc(-100% - 10px)" : "10px"})`,
                }}
              >
                {hoveredCornerLabel && <span className="text-app-accent font-semibold">{hoveredCornerLabel} · </span>}
                {(cursorFrac * 100).toFixed(0)}%{speed ? ` · ${speed}` : ""}
              </div>
            );
          })()
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-app-text-dim">
        {heatSegments ? (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: "var(--color-dynamics-green, #34d399)" }} /> tight line
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: "var(--color-dynamics-amber, #f59e0b)" }} /> ~1-2x spread
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: "var(--color-dynamics-red, #ef4444)" }} /> {`>2x spread`}
            </span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: "#f87171" }} /> S1
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: "#60a5fa" }} /> S2
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: "#facc15" }} /> S3
            </span>
          </>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: SEV_COLOR.critical }} /> critical
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: SEV_COLOR.warn }} /> warn
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: SEV_COLOR.info }} /> info
        </span>
      </div>
    </div>
  );
}
