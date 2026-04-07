import { useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from "react";
import type { TelemetryPacket } from "@shared/types";

export interface Point {
  x: number;
  z: number;
}

export interface TrackMapHandle {
  updateCursor: (idx: number) => void;
}

export interface TrackHighlight {
  startFrac: number;
  endFrac: number;
  color: "good" | "warning" | "critical";
  label: string;
}

const HIGHLIGHT_COLORS = {
  good: { stroke: "rgba(52, 211, 153, 0.7)", width: 6 },       // green
  warning: { stroke: "rgba(251, 191, 36, 0.7)", width: 6 },     // amber
  critical: { stroke: "rgba(239, 68, 68, 0.7)", width: 6 },     // red
};

export const AnalyseTrackMap = forwardRef<TrackMapHandle, {
  telemetry: TelemetryPacket[];
  cursorIdx: number;
  outline: Point[] | null;
  boundaries: { leftEdge: Point[]; rightEdge: Point[]; centerLine: Point[]; pitLane: Point[] | null; coordSystem: string } | null;
  sectors: { s1End: number; s2End: number } | null;
  segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  highlights?: TrackHighlight[] | null;
  rotateWithCar: boolean;
  zoom?: number;
  containerHeight?: number;
}>(function AnalyseTrackMap({
  telemetry,
  cursorIdx,
  outline,
  boundaries,
  sectors,
  segments,
  highlights,
  rotateWithCar,
  zoom = 1,
  containerHeight,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const carCanvasRef = useRef<HTMLCanvasElement>(null);
  const pulseRef = useRef<HTMLCanvasElement>(null);
  const carPosRef = useRef<{ x: number; y: number; w: number; h: number; angle?: number } | null>(null);
  // Store transform info so car overlay can draw without redrawing everything
  const transformRef = useRef<{
    w: number; h: number; offsetX: number; offsetZ: number; scale: number; maxX: number; minZ: number;
    displayOutline: Point[];
  } | null>(null);
  // Offscreen canvas caching the static track drawing (boundaries, segments, sectors, labels)
  const offscreenRef = useRef<OffscreenCanvas | null>(null);

  // Draw the static track (boundaries, outline, segments, sectors, start/finish) to the offscreen canvas.
  // Called once when data changes — NOT per cursor update.
  const drawStaticTrack = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const w = rect.width;
    const h = rect.height;

    const telemetryPoints = telemetry
      .filter((p) => p.PositionX !== 0 || p.PositionZ !== 0)
      .map((p) => ({ x: p.PositionX, z: p.PositionZ }));
    const displayOutline: Point[] = telemetryPoints.length > 2 ? telemetryPoints : (outline ?? []);

    if (displayOutline.length < 2) {
      transformRef.current = null;
      offscreenRef.current = null;
      return;
    }

    const hasBounds = (boundaries?.coordSystem === "forza" || boundaries?.coordSystem === "f1-2025") && boundaries.leftEdge?.length > 2;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const allBoundsPts: Point[][] = [displayOutline];
    if (hasBounds) allBoundsPts.push(boundaries!.leftEdge, boundaries!.rightEdge);
    for (const pts of allBoundsPts) {
      for (const p of pts) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
    }
    const rangeX = (maxX - minX) || 1;
    const rangeZ = (maxZ - minZ) || 1;
    const padding = rotateWithCar ? 60 : 24;
    const baseScale = Math.min(
      (w - padding * 2) / rangeX,
      (h - padding * 2) / rangeZ
    );
    const scale = baseScale * zoom * (rotateWithCar ? 3 : 1);
    const offsetX = (w - rangeX * scale) / 2;
    const offsetZ = (h - rangeZ * scale) / 2;

    transformRef.current = { w, h, offsetX, offsetZ, scale, maxX, minZ, displayOutline };

    function toCanvas(x: number, z: number): [number, number] {
      return [offsetX + (maxX - x) * scale, offsetZ + (z - minZ) * scale];
    }

    // Create offscreen canvas at full DPR resolution
    const offscreen = new OffscreenCanvas(canvas.width, canvas.height);
    const ctx = offscreen.getContext("2d")!;
    ctx.scale(dpr, dpr);

    // Draw track boundary surface
    if (hasBounds) {
      const left = boundaries!.leftEdge;
      const right = boundaries!.rightEdge;
      ctx.beginPath();
      const [lx0, ly0] = toCanvas(left[0].x, left[0].z);
      ctx.moveTo(lx0, ly0);
      for (let i = 1; i < left.length; i++) {
        const [lx, ly] = toCanvas(left[i].x, left[i].z);
        ctx.lineTo(lx, ly);
      }
      for (let i = right.length - 1; i >= 0; i--) {
        const [rx, ry] = toCanvas(right[i].x, right[i].z);
        ctx.lineTo(rx, ry);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(51, 65, 85, 0.25)";
      ctx.fill();
      ctx.strokeStyle = "rgba(100, 116, 139, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lx0, ly0);
      for (let i = 1; i < left.length; i++) ctx.lineTo(...toCanvas(left[i].x, left[i].z));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(...toCanvas(right[0].x, right[0].z));
      for (let i = 1; i < right.length; i++) ctx.lineTo(...toCanvas(right[i].x, right[i].z));
      ctx.stroke();
    }

    // Draw track outline (thick dark)
    ctx.beginPath();
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const [sx, sy] = toCanvas(displayOutline[0].x, displayOutline[0].z);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < displayOutline.length; i++) {
      const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
      ctx.lineTo(px, py);
    }
    if (outline) ctx.lineTo(sx, sy);
    ctx.stroke();

    // Cumulative distance for segment mapping
    const n = displayOutline.length;
    const cumDist = [0];
    for (let i = 1; i < n; i++) {
      const dx = displayOutline[i].x - displayOutline[i - 1].x;
      const dz = displayOutline[i].z - displayOutline[i - 1].z;
      cumDist.push(cumDist[i - 1] + Math.sqrt(dx * dx + dz * dz));
    }
    const totalDist = cumDist[n - 1] || 1;
    function fracToIdx(frac: number): number {
      const targetDist = frac * totalDist;
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumDist[mid] < targetDist) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    // Colored segments
    if (segments && segments.length > 0) {
      let sNum = 1;
      const segDisplayNames = segments.map((s) => {
        if (s.type === "straight" && (!s.name || /^S[\d?]*$/.test(s.name))) return `S${sNum++}`;
        if (s.type === "straight") sNum++;
        return s.name;
      });
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        const startIdx = fracToIdx(seg.startFrac);
        const endIdx = fracToIdx(seg.endFrac);
        if (startIdx >= endIdx) continue;
        ctx.beginPath();
        ctx.strokeStyle = seg.type === "corner" ? "#f59e0b" : "#3b82f6";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        const [mx, my] = toCanvas(displayOutline[startIdx].x, displayOutline[startIdx].z);
        ctx.moveTo(mx, my);
        for (let i = startIdx + 1; i <= endIdx && i < n; i++) {
          const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
          ctx.lineTo(px, py);
        }
        ctx.stroke();
        const displayName = segDisplayNames[si];
        const midIdx = Math.round((startIdx + endIdx) / 2);
        const midPt = displayOutline[Math.min(midIdx, n - 1)];
        if (midPt && displayName) {
          const [lx, ly] = toCanvas(midPt.x, midPt.z);
          ctx.font = "bold 16px monospace";
          ctx.textAlign = "center";
          const textWidth = ctx.measureText(displayName).width;
          const padX = 6, padY = 5;
          ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
          ctx.beginPath();
          ctx.roundRect(lx - textWidth / 2 - padX, ly - 18 - 12 - padY, textWidth + padX * 2, 20 + padY * 2, 4);
          ctx.fill();
          ctx.fillStyle = seg.type === "corner" ? "#fbbf24" : "#60a5fa";
          ctx.fillText(displayName, lx, ly - 18);
        }
      }
    } else {
      ctx.beginPath();
      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 2;
      ctx.moveTo(sx, sy);
      for (let i = 1; i < displayOutline.length; i++) {
        const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
        ctx.lineTo(px, py);
      }
      if (outline) ctx.lineTo(sx, sy);
      ctx.stroke();
    }

    // AI analysis highlights (problem/good zones)
    if (highlights && highlights.length > 0) {
      for (const hl of highlights) {
        const startIdx = fracToIdx(hl.startFrac);
        const endIdx = fracToIdx(hl.endFrac);
        if (startIdx >= endIdx) continue;
        const style = HIGHLIGHT_COLORS[hl.color];
        ctx.beginPath();
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = style.width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const [hx, hy] = toCanvas(displayOutline[startIdx].x, displayOutline[startIdx].z);
        ctx.moveTo(hx, hy);
        for (let i = startIdx + 1; i <= endIdx && i < n; i++) {
          const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }

    // Start/finish
    if (outline) {
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#10b981";
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Sector boundary markers
    if (sectors && displayOutline.length > 10) {
      const sectorColors = ["#ef4444", "#3b82f6", "#eab308"];
      const sectorFracs = [sectors.s1End, sectors.s2End];
      for (let si = 0; si < sectorFracs.length; si++) {
        const sIdx = Math.round(sectorFracs[si] * (displayOutline.length - 1));
        const pt = displayOutline[Math.min(sIdx, displayOutline.length - 1)];
        if (!pt) continue;
        const [mx, my] = toCanvas(pt.x, pt.z);
        const prevIdx = Math.max(0, sIdx - 3);
        const nextIdx = Math.min(displayOutline.length - 1, sIdx + 3);
        const dx = displayOutline[nextIdx].x - displayOutline[prevIdx].x;
        const dz = displayOutline[nextIdx].z - displayOutline[prevIdx].z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0) {
          const nx = dz / len;
          const nz = -dx / len;
          const tickLen = 8;
          ctx.beginPath();
          ctx.moveTo(mx - nx * tickLen, my + nz * tickLen);
          ctx.lineTo(mx + nx * tickLen, my - nz * tickLen);
          ctx.strokeStyle = sectorColors[si];
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(mx, my, 3, 0, Math.PI * 2);
        ctx.fillStyle = sectorColors[si];
        ctx.fill();
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    offscreenRef.current = offscreen;
  }, [telemetry, outline, boundaries, sectors, segments, rotateWithCar, zoom, highlights]);

  // Composite the cached offscreen track onto the main canvas, with optional rotation for car-view mode
  const compositeTrack = useCallback((idx: number) => {
    const canvas = canvasRef.current;
    const offscreen = offscreenRef.current;
    const t = transformRef.current;
    if (!canvas || !offscreen || !t) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.save();
    ctx.scale(dpr, dpr);

    if (rotateWithCar) {
      const pkt = telemetry[idx];
      if (pkt && (pkt.PositionX !== 0 || pkt.PositionZ !== 0)) {
        const carCx = t.offsetX + (t.maxX - pkt.PositionX) * t.scale;
        const carCy = t.offsetZ + (pkt.PositionZ - t.minZ) * t.scale;
        ctx.translate(t.w / 2, t.h / 2);
        ctx.rotate(Math.PI - pkt.Yaw);
        ctx.translate(-carCx, -carCy);
      }
    }

    // Draw the cached static track
    ctx.drawImage(offscreen, 0, 0, t.w, t.h);

    // Draw car on main canvas (in rotated space so it stays aligned)
    const pkt = telemetry[idx];
    if (pkt && (pkt.PositionX !== 0 || pkt.PositionZ !== 0)) {
      const cx = t.offsetX + (t.maxX - pkt.PositionX) * t.scale;
      const cy = t.offsetZ + (pkt.PositionZ - t.minZ) * t.scale;
      const fwdX = pkt.PositionX + Math.sin(pkt.Yaw) * 1;
      const fwdZ = pkt.PositionZ + Math.cos(pkt.Yaw) * 1;
      const fx = t.offsetX + (t.maxX - fwdX) * t.scale;
      const fy = t.offsetZ + (fwdZ - t.minZ) * t.scale;
      const angle = Math.atan2(fy - cy, fx - cx);
      const triSize = 8;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(triSize, 0);
      ctx.lineTo(-triSize * 0.6, -triSize * 0.6);
      ctx.lineTo(-triSize * 0.6, triSize * 0.6);
      ctx.closePath();
      ctx.fillStyle = "#22d3ee";
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      const px = rotateWithCar ? t.w / 2 : cx;
      const py = rotateWithCar ? t.h / 2 : cy;
      const pa = rotateWithCar ? -Math.PI / 2 : angle;
      carPosRef.current = { x: px, y: py, w: t.w, h: t.h, angle: pa };
    }

    ctx.restore();
  }, [telemetry, rotateWithCar]);

  // Draw car dot on overlay canvas (fixed view only — avoids full redraw)
  const drawCarOverlay = useCallback((idx: number) => {
    const carCanvas = carCanvasRef.current;
    const t = transformRef.current;
    if (!carCanvas || !t) return;
    const dpr = window.devicePixelRatio || 1;
    carCanvas.width = t.w * dpr;
    carCanvas.height = t.h * dpr;
    carCanvas.style.width = `${t.w}px`;
    carCanvas.style.height = `${t.h}px`;
    const ctx = carCanvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, t.w, t.h);

    const pkt = telemetry[idx];
    if (!pkt || (pkt.PositionX === 0 && pkt.PositionZ === 0)) return;

    function toCanvas(x: number, z: number): [number, number] {
      return [t!.offsetX + (t!.maxX - x) * t!.scale, t!.offsetZ + (z - t!.minZ) * t!.scale];
    }

    const [cx, cy] = toCanvas(pkt.PositionX, pkt.PositionZ);
    const triSize = 8;
    const fwdX = pkt.PositionX + Math.sin(pkt.Yaw) * 1;
    const fwdZ = pkt.PositionZ + Math.cos(pkt.Yaw) * 1;
    const [fx, fy] = toCanvas(fwdX, fwdZ);
    const angle = Math.atan2(fy - cy, fx - cx);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(triSize, 0);
    ctx.lineTo(-triSize * 0.6, -triSize * 0.6);
    ctx.lineTo(-triSize * 0.6, triSize * 0.6);
    ctx.closePath();
    ctx.fillStyle = "#22d3ee";
    ctx.fill();
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    carPosRef.current = { x: cx, y: cy, w: t.w, h: t.h, angle };
  }, [telemetry]);

  // Imperative cursor update — called from animation loop without React re-render
  const updateCursor = useCallback((idx: number) => {
    if (rotateWithCar) {
      // Car-view: composite cached track with rotation + draw car (no full redraw)
      compositeTrack(idx);
    }
    drawCarOverlay(idx);
  }, [rotateWithCar, compositeTrack, drawCarOverlay]);

  useImperativeHandle(ref, () => ({ updateCursor }), [updateCursor]);

  // Build offscreen cache + initial composite when data changes
  useEffect(() => {
    drawStaticTrack();
  }, [drawStaticTrack]);

  // Composite after offscreen is ready (and on data changes)
  useEffect(() => {
    if (rotateWithCar) {
      compositeTrack(cursorIdx);
    } else {
      // Fixed view: just blit the offscreen directly
      const canvas = canvasRef.current;
      const offscreen = offscreenRef.current;
      const t = transformRef.current;
      if (canvas && offscreen && t) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const dpr = window.devicePixelRatio || 1;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.restore();
          ctx.save();
          ctx.scale(dpr, dpr);
          ctx.drawImage(offscreen, 0, 0, t.w, t.h);
          ctx.restore();
        }
      }
    }
  }, [telemetry, outline, boundaries, sectors, segments, rotateWithCar, zoom, containerHeight]);

  // Update car overlay when cursorIdx changes via React state
  useEffect(() => {
    drawCarOverlay(cursorIdx);
  }, [cursorIdx, drawCarOverlay]);

  // Pulse ring animation on overlay canvas
  useEffect(() => {
    const pulse = pulseRef.current;
    if (!pulse) return;
    let animId: number;
    const draw = () => {
      const pos = carPosRef.current;
      const ctx2 = pulse.getContext("2d");
      if (!ctx2 || !pos) { animId = requestAnimationFrame(draw); return; }
      const dpr = window.devicePixelRatio || 1;
      pulse.width = pos.w * dpr;
      pulse.height = pos.h * dpr;
      pulse.style.width = `${pos.w}px`;
      pulse.style.height = `${pos.h}px`;
      ctx2.scale(dpr, dpr);
      ctx2.clearRect(0, 0, pos.w, pos.h);
      const cycle = Date.now() % 2500;
      if (cycle > 1000) { ctx2.restore(); animId = requestAnimationFrame(draw); return; }
      const t = cycle / 1000;
      const eased = 1 - Math.pow(1 - t, 3);
      const s = 10 + eased * 6;
      const opacity = 0.8 * (1 - t);
      ctx2.save();
      ctx2.translate(pos.x, pos.y);
      if (pos.angle !== undefined) ctx2.rotate(pos.angle);
      ctx2.beginPath();
      ctx2.moveTo(s, 0);
      ctx2.lineTo(-s * 0.6, -s * 0.6);
      ctx2.lineTo(-s * 0.6, s * 0.6);
      ctx2.closePath();
      ctx2.strokeStyle = `rgba(34, 211, 238, ${opacity})`;
      ctx2.lineWidth = 2;
      ctx2.stroke();
      ctx2.restore();
      animId = requestAnimationFrame(draw);
    };
    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, []);

  return (
    <div className="relative w-full h-full" style={{ minHeight: 220 }}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
      />
      <canvas
        ref={carCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />
      <canvas
        ref={pulseRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />
    </div>
  );
});
