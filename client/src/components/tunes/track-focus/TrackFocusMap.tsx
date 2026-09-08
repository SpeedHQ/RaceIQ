import { useMemo, useRef } from "react";
import { SECTOR_COLOR_VARS, severityColor } from "@/lib/colors";
import type { TuneIssue } from "../../../../../shared/racing/tuning/issues";
import type { SemanticTuneSample } from "../semantic-tune";
import type { LineSpreadTrace } from "../../../hooks/experiments";
import type { TrackCorner } from "../../../hooks/track-queries";
import { buildGeometry, buildStartMarker, type Pt, type SectorTimesLite, VIEW } from "../track-map-geometry";

// Same threshold server-side (server/lap-analysis/consistency.ts LINE_SPREAD_THRESHOLD_M).
const LINE_SPREAD_THRESHOLD_M = 1.5;

function spreadColor(spreadM: number): string {
  return spreadM < LINE_SPREAD_THRESHOLD_M ? severityColor(0) : spreadM < LINE_SPREAD_THRESHOLD_M * 2 ? severityColor(1) : severityColor(3);
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
  telemetry: SemanticTuneSample[] | null;
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
   *  line (set while hovering a Segment Ledger row, null otherwise). */
  overlayPoints?: { brake: number[]; throttle: number[] } | null;
  /** Corner span highlighted while hovering or pinning a ledger row. */
  highlightRange?: { startFrac: number; endFrac: number } | null;
  /** Racing-line consistency trace (Consistency tab only, null while loading,
   *  no session, or too few clean laps — lane + map overlay render empty). */
  lineSpread?: LineSpreadTrace | null;
  /** Fraction of lap currently selected in a lane zoom. */
  visibleRange?: { start: number; end: number } | null;
}

const SEV_COLOR: Record<string, string> = {
  critical: "var(--status-danger)",
  warn: "var(--status-warning)",
  info: "var(--status-info)",
};

/**
 * Focus-lap track map: driven line (3 sector-colored segments), optional
 * track edges, corner markers, issue dots (severity-colored, critical gets a
 * halo), a cursor dot synced to `cursorFrac`, and a "nearest corner" chip
 * that tracks the cursor (or the lap
 * average when no cursor is set).
 */
export function TrackFocusMap({
  telemetry,
  sectorTimes,
  edges,
  corners,
  cornerFracs,
  issues,
  cursorFrac,
  onCursorFrac,
  overlayPoints,
  highlightRange,
  lineSpread,
  visibleRange = null,
}: TrackFocusMapProps) {
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
    const sampleCount = telemetry.length;
    const distances = telemetry.map((sample) => sample.distanceM);
    const first = distances[0];
    const last = distances[sampleCount - 1];
    const span = first === undefined || last === undefined ? 0 : last - first;
    const normalized = new Float32Array(sampleCount);
    if (span > 0 && distances.every((distance) => distance !== undefined)) {
      for (let index = 0; index < sampleCount; index++) {
        const fraction = ((distances[index] as number) - (first as number)) / span;
        normalized[index] = Math.max(0, Math.min(1, fraction));
      }
    } else {
      for (let index = 0; index < sampleCount; index++) normalized[index] = sampleCount > 1 ? index / (sampleCount - 1) : 0;
    }
    return normalized;
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
  // Keep the complete lap as context, but emphasize only lane scope when a
  // range is selected. Segment rendering avoids a second projection.
  const scopedSegments = useMemo(() => {
    if (!visibleRange || !geometry || geometry.pts.length < 2) return [];
    const start = Math.max(0, Math.min(1, visibleRange.start));
    const end = Math.max(start, Math.min(1, visibleRange.end));
    const boundaries = sectorTimes?.boundaryIndices ?? [];
    const lastIdx = Math.max(1, (telemetry?.length ?? 1) - 1);
    return geometry.pts.slice(1).flatMap((point, index) => {
      const previous = geometry.pts[index];
      const frac = normDist?.[point.idx] ?? point.idx / lastIdx;
      if (frac < start || frac > end) return [];
      let sector = 0;
      while (sector < boundaries.length && point.idx >= boundaries[sector]) sector++;
      return [{ x1: previous.x, y1: previous.y, x2: point.x, y2: point.y, color: SECTOR_COLOR_VARS[sector % SECTOR_COLOR_VARS.length] }];
    });
  }, [geometry, normDist, sectorTimes, telemetry, visibleRange]);
  const mapViewBox = useMemo(() => {
    if (!visibleRange || scopedSegments.length === 0) return `0 0 ${VIEW} ${VIEW}`;
    const points = scopedSegments.flatMap(({ x1, y1, x2, y2 }) => [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ]);
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const width = Math.max(20, maxX - minX);
    const height = Math.max(20, maxY - minY);
    const padding = Math.max(10, Math.max(width, height) * 0.2);
    return `${minX - padding} ${minY - padding} ${width + padding * 2} ${height + padding * 2}`;
  }, [scopedSegments, visibleRange]);

  function fracToPoint(frac: number): { x: number; y: number } | null {
    if (!geometry || geometry.pts.length === 0) return null;
    const targetIndex = distFracToIdx(frac);
    return geometry.pts.reduce((closest, point) => (Math.abs(point.idx - targetIndex) < Math.abs(closest.idx - targetIndex) ? point : closest));
  }

  // A short tick mark across the driven line at `frac`, oriented perpendicular
  // to the local track direction (from the neighbouring sample).
  function fracToTick(frac: number, half = 4): { x1: number; y1: number; x2: number; y2: number } | null {
    if (!geometry || geometry.pts.length < 2) return null;
    const targetIndex = distFracToIdx(frac);
    let pointIndex = 0;
    for (let index = 1; index < geometry.pts.length; index++) {
      if (Math.abs(geometry.pts[index].idx - targetIndex) < Math.abs(geometry.pts[pointIndex].idx - targetIndex)) pointIndex = index;
    }
    const point = geometry.pts[pointIndex];
    const a = geometry.pts[Math.max(0, pointIndex - 1)];
    const b = geometry.pts[Math.min(geometry.pts.length - 1, pointIndex + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Perpendicular unit vector.
    const nx = -dy / len;
    const ny = dx / len;
    return { x1: point.x - nx * half, y1: point.y - ny * half, x2: point.x + nx * half, y2: point.y + ny * half };
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

  // Start/finish marker + direction arrow, shared with TrackDetail's canvas
  // renderer so every game's map reads the same way.
  const startMarker = useMemo(() => buildStartMarker(geometry?.pts), [geometry]);

  const cornerApexFracs = useMemo(() => corners.map((c, i) => cornerFracs?.[i] ?? c.distanceStart), [corners, cornerFracs]);
  const highlightedLine = useMemo(() => {
    if (!geometry || !highlightRange) return null;
    const start = Math.max(0, Math.min(1, highlightRange.startFrac));
    const end = Math.max(start, Math.min(1, highlightRange.endFrac));
    const points = geometry.pts.filter((point) => {
      const f = normDist?.[point.idx] ?? 0;
      return f >= start && f <= end;
    });
    return points.length >= 2 ? points.map((point) => `${point.x},${point.y}`).join(" ") : null;
  }, [geometry, highlightRange, normDist]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={mapViewBox}
          width="100%"
          className="aspect-[1.1/1]"
          style={{ cursor: geometry ? "crosshair" : "default" }}
          onMouseMove={onMove}
          onMouseLeave={() => onCursorFrac(null)}
        >
          {!geometry && (
            <text x={VIEW / 2} y={VIEW / 2} textAnchor="middle" fontSize={10} fill="var(--app-text-dim)">
              No telemetry
            </text>
          )}
          {geometry?.leftEdge && <polyline points={geometry.leftEdge} fill="none" stroke="var(--app-border)" strokeWidth={1} />}
          {geometry?.rightEdge && <polyline points={geometry.rightEdge} fill="none" stroke="var(--app-border)" strokeWidth={1} />}
          <g opacity={visibleRange ? 0.2 : 1} style={visibleRange ? { filter: "grayscale(1)" } : undefined}>
            {heatSegments
              ? heatSegments.map((s) => (
                  <line key={`${s.x1}-${s.y1}-${s.x2}-${s.y2}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.color} strokeWidth={visibleRange ? 1.6 : 2.5} strokeLinecap="round" />
                ))
              : (["s1", "s2", "s3"] as const).map((segKey, i) => (
                  <polyline key={segKey} points={geometry?.segments[i]} fill="none" stroke={SECTOR_COLOR_VARS[i]} strokeWidth={visibleRange ? 1.6 : 2} strokeLinejoin="round" strokeLinecap="round" />
                ))}
          </g>
          {scopedSegments.map((segment, index) => (
            <line key={`scope-${index}`} x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} stroke={segment.color} strokeWidth={1.6} strokeLinecap="round" />
          ))}
          {highlightedLine && <polyline points={highlightedLine} fill="none" stroke="var(--app-accent)" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" opacity={0.55} />}
          {startMarker && (
            <g>
              <line x1={startMarker.x} y1={startMarker.y} x2={startMarker.tipX} y2={startMarker.tipY} stroke="var(--track-start)" strokeWidth={1.5} />
              <polygon points={startMarker.head} fill="var(--track-start)" />
              <circle cx={startMarker.x} cy={startMarker.y} r={3} fill="var(--track-start)" />
            </g>
          )}
          {!overlayPoints &&
            corners.map((c, i) => {
              const apexFrac = cornerApexFracs[i];
              const pt = fracToPoint(apexFrac);
              if (!pt) return null;
              const color = "var(--app-text-dim)";
              return (
                <g key={c.index}>
                  <circle cx={pt.x} cy={pt.y} r={2.5} fill={color} stroke="var(--app-bg)" strokeWidth={0.75} />
                </g>
              );
            })}
          {issues.map((it) => {
            if (it.distanceFrac == null) return null;
            const pt = fracToPoint(it.distanceFrac);
            if (!pt) return null;
            const color = SEV_COLOR[it.severity] ?? SEV_COLOR.info;
            return (
              <g key={`${it.kind}-${it.corner ?? ""}-${it.distanceFrac}-${it.detail}`}>
                {it.severity === "critical" && <circle cx={pt.x} cy={pt.y} r={6} fill={color} opacity={0.25} />}
                <circle cx={pt.x} cy={pt.y} r={3} fill={color} stroke="var(--app-bg)" strokeWidth={1} />
              </g>
            );
          })}
          {overlayPoints?.brake.map((f, index) => {
            const tk = fracToTick(f);
            if (!tk) return null;
            return <line key={`ob-${index}-${f}`} x1={tk.x1} y1={tk.y1} x2={tk.x2} y2={tk.y2} stroke="var(--ch-brake)" strokeWidth={1.5} strokeLinecap="round" />;
          })}
          {overlayPoints?.throttle.map((f, index) => {
            const tk = fracToTick(f);
            if (!tk) return null;
            return <line key={`ot-${index}-${f}`} x1={tk.x1} y1={tk.y1} x2={tk.x2} y2={tk.y2} stroke="var(--ch-throttle)" strokeWidth={1.5} strokeLinecap="round" />;
          })}
          {cursorPt && <circle cx={cursorPt.x} cy={cursorPt.y} r={4} fill="var(--app-accent)" stroke="var(--app-bg)" strokeWidth={1.2} />}
        </svg>
        {cursorFrac != null && cursorPt
          ? (() => {
              const leftPct = (cursorPt.x / VIEW) * 100;
              const topPct = (cursorPt.y / VIEW) * 100;
              const flipX = leftPct > 60;
              const flipY = topPct > 70;
              const speed = readoutFrame?.speedMps === undefined ? null : `${(readoutFrame.speedMps * 3.6).toFixed(0)} km/h`;
              return (
                <div
                  className="absolute pointer-events-none text-app-caption font-mono tabular-nums bg-app-surface-alt/95 border border-app-border rounded px-1.5 py-0.5 text-app-text-muted whitespace-nowrap shadow"
                  style={{
                    left: `${leftPct}%`,
                    top: `${topPct}%`,
                    transform: `translate(${flipX ? "-110%" : "10px"}, ${flipY ? "calc(-100% - 10px)" : "10px"})`,
                  }}
                >
                  {(cursorFrac * 100).toFixed(0)}%{speed ? ` · ${speed}` : ""}
                </div>
              );
            })()
          : null}
      </div>
    </div>
  );
}
