import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { TelemetryPacket, GameId } from "@shared/types";
import { client } from "../../lib/rpc";
import {
  COLOR_A,
  COLOR_B,
  drawTrackCanvas,
  drawInputsHUD,
  computeZoom,
  formatSectionTime,
  findTelemetryAtDistance,
  type Point,
  type BoundaryData,
} from "../../lib/comparison-utils";

export interface SegmentTiming {
  name: string;
  type: "corner" | "straight";
  timeA: number;
  timeB: number;
  startFrac: number;
  endFrac: number;
}

interface CompareTrackMapProps {
  outline: Point[];
  telemetryA: TelemetryPacket[];
  telemetryB: TelemetryPacket[];
  labelA: string;
  labelB: string;
  lapTimeA: string;
  lapTimeB: string;
  segments: SegmentTiming[];
  hoveredDistanceRef: React.RefObject<number | null>;
  redrawRef: React.MutableRefObject<(() => void) | null>;
  trackOrdinal?: number | null;
  gameId?: GameId | null;
}

/** Dual-panel track map: overview (left) + zoomed follow (right) */
export function CompareTrackMap({
  outline,
  telemetryA,
  telemetryB,
  segments,
  hoveredDistanceRef,
  redrawRef,
  trackOrdinal,
  gameId,
}: CompareTrackMapProps) {
  const overviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const zoomCanvasRef = useRef<HTMLCanvasElement>(null);
  const overviewContainerRef = useRef<HTMLDivElement>(null);
  const zoomContainerRef = useRef<HTMLDivElement>(null);
  const segmentTableRef = useRef<HTMLTableSectionElement>(null);
  const prevActiveSegRef = useRef<number>(-1);

  const [boundaries, setBoundaries] = useState<BoundaryData | null>(null);
  const [followCar, setFollowCar] = useState(false);
  const followCarRef = useRef(false);
  useEffect(() => { followCarRef.current = followCar; }, [followCar]);

  // Fetch track boundaries
  useEffect(() => {
    if (!trackOrdinal) { setBoundaries(null); return; }
    if (!gameId) return;
    client.api["track-boundaries"][":ordinal"].$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gameId ?? undefined } })
      .then((r) => r.json() as unknown as BoundaryData)
      .then((data) => setBoundaries(data))
      .catch(() => setBoundaries(null));
  }, [trackOrdinal, gameId]);

  // Align outline to telemetry coordinate space.
  // Extracted outlines (e.g. F1 2025 from AI spline data) may be in a different
  // coordinate system than telemetry PositionX/Z. Detect misalignment by checking
  // bounding box overlap, and if needed apply Procrustes (translate + rotate + scale).
  const { alignedOutline, alignedBoundaries, telXFn, trackRange } = useMemo(() => {
    const identity = (x: number) => x;

    const computeRange = (pts: Point[]) => {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
      return Math.max((maxX - minX) || 1, (maxZ - minZ) || 1);
    };

    // Extract telemetry positions from lap A
    const telPts: Point[] = [];
    for (const p of telemetryA) {
      if (p.PositionX !== 0 || p.PositionZ !== 0) telPts.push({ x: p.PositionX, z: p.PositionZ });
    }
    if (telPts.length < 20 || outline.length < 10) {
      return { alignedOutline: outline, alignedBoundaries: boundaries, telXFn: identity, trackRange: computeRange(outline) };
    }

    // Check bounding box overlap between outline and telemetry
    let oMinX = Infinity, oMaxX = -Infinity, oMinZ = Infinity, oMaxZ = -Infinity;
    for (const p of outline) { oMinX = Math.min(oMinX, p.x); oMaxX = Math.max(oMaxX, p.x); oMinZ = Math.min(oMinZ, p.z); oMaxZ = Math.max(oMaxZ, p.z); }
    let tMinX = Infinity, tMaxX = -Infinity, tMinZ = Infinity, tMaxZ = -Infinity;
    for (const p of telPts) { tMinX = Math.min(tMinX, p.x); tMaxX = Math.max(tMaxX, p.x); tMinZ = Math.min(tMinZ, p.z); tMaxZ = Math.max(tMaxZ, p.z); }

    const oRangeX = oMaxX - oMinX, oRangeZ = oMaxZ - oMinZ;
    const tRangeX = tMaxX - tMinX, tRangeZ = tMaxZ - tMinZ;
    const oCx = (oMinX + oMaxX) / 2;
    const tCx = (tMinX + tMaxX) / 2;

    // Check if bounding boxes overlap (with some tolerance)
    const overlapX = Math.max(0, Math.min(oMaxX, tMaxX) - Math.max(oMinX, tMinX));
    const overlapZ = Math.max(0, Math.min(oMaxZ, tMaxZ) - Math.max(oMinZ, tMinZ));
    const overlapRatioX = overlapX / Math.max(oRangeX, tRangeX, 1);
    const overlapRatioZ = overlapZ / Math.max(oRangeZ, tRangeZ, 1);
    const overlaps = overlapRatioX > 0.3 && overlapRatioZ > 0.3;

    // Also check if just X-flip fixes it (old F1 laps)
    if (overlaps) {
      // Check X sign flip
      if (oCx !== 0 && Math.sign(tCx) !== Math.sign(oCx) && Math.abs(tCx) > 50) {
        return { alignedOutline: outline, alignedBoundaries: boundaries, telXFn: (x: number) => -x, trackRange: computeRange(outline) };
      }
      return { alignedOutline: outline, alignedBoundaries: boundaries, telXFn: identity, trackRange: computeRange(outline) };
    }

    // No overlap — need full Procrustes alignment.
    // Downsample both to ~100 points for matching.
    const ds = (pts: Point[], n: number): Point[] => {
      if (pts.length <= n) return pts;
      const step = pts.length / n;
      const out: Point[] = [];
      for (let i = 0; i < n; i++) out.push(pts[Math.floor(i * step)]);
      return out;
    };
    const N = 100;
    const src = ds(outline, N); // outline points (source)
    const tgt = ds(telPts, N);  // telemetry points (target)

    const centroid = (pts: Point[]) => {
      let sx = 0, sz = 0;
      for (const p of pts) { sx += p.x; sz += p.z; }
      return { x: sx / pts.length, z: sz / pts.length };
    };

    // ICP: iteratively find closest points and compute rigid+scale transform
    let scale = 1, rotation = 0, tx = 0, tz = 0;
    let transformed = src.map(p => ({ ...p }));

    for (let iter = 0; iter < 30; iter++) {
      // Find closest target point for each transformed source point
      const pairs: { s: Point; t: Point }[] = [];
      for (const sp of transformed) {
        let bestD = Infinity, bestT = tgt[0];
        for (const tp of tgt) {
          const d = (sp.x - tp.x) ** 2 + (sp.z - tp.z) ** 2;
          if (d < bestD) { bestD = d; bestT = tp; }
        }
        pairs.push({ s: sp, t: bestT });
      }

      // Procrustes on original source → paired targets
      const srcPaired = pairs.map((_, i) => src[i]);
      const tgtPaired = pairs.map(p => p.t);
      const cSrc = centroid(srcPaired);
      const cTgt = centroid(tgtPaired);
      const srcC = srcPaired.map(p => ({ x: p.x - cSrc.x, z: p.z - cSrc.z }));
      const tgtC = tgtPaired.map(p => ({ x: p.x - cTgt.x, z: p.z - cTgt.z }));

      let num = 0, den = 0, srcSq = 0;
      for (let i = 0; i < srcC.length; i++) {
        num += srcC[i].x * tgtC[i].z - srcC[i].z * tgtC[i].x;
        den += srcC[i].x * tgtC[i].x + srcC[i].z * tgtC[i].z;
        srcSq += srcC[i].x ** 2 + srcC[i].z ** 2;
      }
      const newRot = Math.atan2(num, den);
      const cosR = Math.cos(newRot), sinR = Math.sin(newRot);
      let tgtSq = 0;
      for (const p of tgtC) tgtSq += p.x ** 2 + p.z ** 2;
      const newScale = srcSq > 0 ? Math.sqrt(tgtSq / srcSq) : 1;
      const newTx = cTgt.x - newScale * (cosR * cSrc.x - sinR * cSrc.z);
      const newTz = cTgt.z - newScale * (sinR * cSrc.x + cosR * cSrc.z);

      const dScale = Math.abs(newScale - scale);
      const dRot = Math.abs(newRot - rotation);
      scale = newScale; rotation = newRot; tx = newTx; tz = newTz;

      // Apply transform
      const cosA = Math.cos(rotation), sinA = Math.sin(rotation);
      transformed = src.map(p => ({
        x: scale * (cosA * p.x - sinA * p.z) + tx,
        z: scale * (sinA * p.x + cosA * p.z) + tz,
      }));

      if (dScale < 0.0001 && dRot < 0.0001) break;
    }

    // Apply final transform to full outline
    const cosA = Math.cos(rotation), sinA = Math.sin(rotation);
    const applyTransform = (p: Point): Point => ({
      x: scale * (cosA * p.x - sinA * p.z) + tx,
      z: scale * (sinA * p.x + cosA * p.z) + tz,
    });

    const newOutline = outline.map(applyTransform);

    // Also transform boundaries if available
    let newBoundaries = boundaries;
    if (boundaries?.leftEdge && boundaries?.rightEdge && boundaries?.centerLine) {
      newBoundaries = {
        ...boundaries,
        leftEdge: boundaries.leftEdge.map(applyTransform),
        rightEdge: boundaries.rightEdge.map(applyTransform),
        centerLine: boundaries.centerLine.map(applyTransform),
        pitLane: boundaries.pitLane?.map(applyTransform) ?? null,
      };
    }

    return { alignedOutline: newOutline, alignedBoundaries: newBoundaries, telXFn: identity, trackRange: computeRange(newOutline) };
  }, [outline, telemetryA, boundaries]);

  const drawBoth = useCallback(() => {
    const hd = hoveredDistanceRef.current;

    // Draw overview
    const oc = overviewCanvasRef.current;
    const ocont = overviewContainerRef.current;
    if (oc && ocont && alignedOutline.length >= 2) {
      const rect = ocont.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      oc.width = rect.width * dpr;
      oc.height = rect.height * dpr;
      oc.style.width = `${rect.width}px`;
      oc.style.height = `${rect.height}px`;
      const ctx = oc.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
        const segPts = segments.length > 0 && telemetryA.length >= 2
          ? segments.map(s => {
              const idx = Math.round(s.startFrac * (telemetryA.length - 1));
              const p = telemetryA[idx];
              return { x: telXFn(p.PositionX), z: p.PositionZ, type: s.type, label: s.name };
            }).filter(sp => sp.x !== 0 || sp.z !== 0)
          : undefined;
        drawTrackCanvas(ctx, rect.width, rect.height, alignedOutline, telemetryA, telemetryB, hd, null, segPts, undefined, alignedBoundaries, telXFn);
      }
    }

    // Draw zoomed view
    const zc = zoomCanvasRef.current;
    const zcont = zoomContainerRef.current;
    if (zc && zcont && alignedOutline.length >= 2) {
      const rect = zcont.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      zc.width = rect.width * dpr;
      zc.height = rect.height * dpr;
      zc.style.width = `${rect.width}px`;
      zc.style.height = `${rect.height}px`;
      const ctx = zc.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
        const zoom = hd != null
          ? computeZoom(telemetryA, telemetryB, hd, trackRange, telXFn)
          : null;
        drawTrackCanvas(ctx, rect.width, rect.height, alignedOutline, telemetryA, telemetryB, hd, zoom, undefined, followCarRef.current, alignedBoundaries, telXFn);

        // Draw input HUDs when zoomed
        if (hd != null) {
          const pA = telemetryA.length >= 2 ? telemetryA[findTelemetryAtDistance(telemetryA, hd)] : null;
          const pB = telemetryB.length >= 2 ? telemetryB[findTelemetryAtDistance(telemetryB, hd)] : null;
          drawInputsHUD(ctx, rect.width, rect.height, pA, pB);
        }
      }
    }
    // Highlight active segment row
    if (segmentTableRef.current && segments.length > 0) {
      let activeIdx = -1;
      if (hd != null && telemetryA.length >= 2) {
        const totalDist = telemetryA[telemetryA.length - 1].DistanceTraveled - telemetryA[0].DistanceTraveled;
        if (totalDist > 0) {
          const frac = hd / totalDist;
          activeIdx = segments.findIndex(s => frac >= s.startFrac && frac < s.endFrac);
        }
      }
      if (activeIdx !== prevActiveSegRef.current) {
        const rows = segmentTableRef.current.children;
        if (prevActiveSegRef.current >= 0 && prevActiveSegRef.current < rows.length) {
          (rows[prevActiveSegRef.current] as HTMLElement).style.backgroundColor = "";
        }
        if (activeIdx >= 0 && activeIdx < rows.length) {
          (rows[activeIdx] as HTMLElement).style.backgroundColor = "rgba(148, 163, 184, 0.15)";
          (rows[activeIdx] as HTMLElement).scrollIntoView({ block: "nearest" });
        }
        prevActiveSegRef.current = activeIdx;
      }
    }
  }, [alignedOutline, telemetryA, telemetryB, hoveredDistanceRef, segments, alignedBoundaries, telXFn, trackRange]);

  // Register redraw function so parent can trigger canvas updates without React re-render
  useEffect(() => {
    redrawRef.current = drawBoth;
    return () => { redrawRef.current = null; };
  }, [drawBoth, redrawRef]);

  useEffect(() => {
    drawBoth();
    const observer = new ResizeObserver(drawBoth);
    if (overviewContainerRef.current) observer.observe(overviewContainerRef.current);
    if (zoomContainerRef.current) observer.observe(zoomContainerRef.current);
    return () => observer.disconnect();
  }, [drawBoth]);

  return (
    <div className="bg-app-surface rounded-lg border border-app-border overflow-hidden h-full flex flex-col">

        {/* Overview — full track, static */}
        <div ref={overviewContainerRef} className="relative border-b border-app-border h-[220px] shrink-0">
          <span className="absolute top-2 left-2 text-[10px] text-app-text-dim uppercase tracking-wider z-10">Overview</span>
          {alignedOutline.length < 2 ? (
            <div className="absolute inset-0 flex items-center justify-center text-app-text-dim text-sm">No track outline</div>
          ) : (
            <canvas ref={overviewCanvasRef} className="absolute inset-0" />
          )}
        </div>
        {/* Zoomed — follows cursor position */}
        <div ref={zoomContainerRef} className="relative border-b border-app-border h-[320px] shrink-0">
          <span className="absolute top-2 left-2 text-[10px] text-app-text-dim uppercase tracking-wider z-10">Zoomed</span>
          <button
            onClick={() => { const next = !followCarRef.current; followCarRef.current = next; setFollowCar(next); drawBoth(); }}
            className={`absolute top-2 right-2 z-10 px-2 py-1 text-[10px] rounded border transition-colors ${
              followCar
                ? "bg-cyan-900/50 border-cyan-700 text-cyan-400"
                : "bg-app-surface-alt/80 border-app-border-input text-app-text-secondary hover:text-app-text"
            }`}
          >
            {followCar ? "Follow View" : "Fixed View"}
          </button>
          {alignedOutline.length < 2 ? (
            <div className="absolute inset-0 flex items-center justify-center text-app-text-dim text-sm">No track outline</div>
          ) : (
            <canvas ref={zoomCanvasRef} className="absolute inset-0" />
          )}
        </div>
        {/* Segment Times Table */}
        {segments.length > 0 ? (
          <div className="overflow-auto flex-1 min-h-0">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-[#0f172a]">
                <tr className="text-[10px] text-app-text-muted uppercase tracking-wider border-b border-app-border">
                  <th className="text-left px-2 py-1.5">Segment</th>
                  <th className="text-right px-2 py-1.5" style={{ color: COLOR_A }}>A</th>
                  <th className="text-right px-2 py-1.5" style={{ color: COLOR_B }}>B</th>
                  <th className="text-right px-2 py-1.5">+/-</th>
                </tr>
              </thead>
              <tbody ref={segmentTableRef}>
                {segments.map((s) => {
                  const fasterA = s.timeA > 0 && s.timeB > 0 && s.timeA < s.timeB;
                  const fasterB = s.timeA > 0 && s.timeB > 0 && s.timeB < s.timeA;
                  const delta = s.timeA - s.timeB;
                  const isNeutral = Math.abs(delta) < 0.005;
                  const deltaColor = isNeutral ? "text-app-text-secondary" : delta < 0 ? "text-emerald-400" : "text-red-400";
                  const sign = delta > 0 ? "+" : "";
                  return (
                    <tr key={s.name} className="border-b border-app-border/50 hover:bg-app-surface-alt/30">
                      <td className="px-2 py-1 font-mono text-app-text whitespace-nowrap">{s.name}</td>
                      <td className={`px-2 py-1 font-mono text-right ${fasterA ? "text-emerald-400" : "text-app-text-secondary"}`}>
                        {formatSectionTime(s.timeA)}
                      </td>
                      <td className={`px-2 py-1 font-mono text-right ${fasterB ? "text-emerald-400" : "text-app-text-secondary"}`}>
                        {formatSectionTime(s.timeB)}
                      </td>
                      <td className={`px-2 py-1 font-mono text-right ${deltaColor}`}>
                        {s.timeA > 0 && s.timeB > 0 ? `${sign}${delta.toFixed(3)}` : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
    </div>
  );
}
