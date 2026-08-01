import { tryGetGame } from "@shared/games/registry";
import { lapPath } from "@shared/lib/lap-path";
import type { TelemetryPacket } from "@shared/types";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { SECTOR_COLOR_VARS } from "@/lib/colors";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { flipPoints, needsTrackFlip } from "../../lib/track-coords";

export interface Point {
  x: number;
  z: number;
}

export interface TrackMapLabel extends Point {
  text: string;
}

export interface TrackMapHandle {
  updateCursor: (idx: number) => void;
}

export interface SectorBoundaries {
  sectorStarts: number[];
  sectorCount: number;
}

export interface TrackHighlight {
  startFrac: number;
  endFrac: number;
  color: "good" | "warning" | "critical";
  label: string;
}

const HIGHLIGHT_COLORS = {
  good: { stroke: "color-mix(in srgb, var(--severity-nominal) 70%, transparent)", width: 6 },
  warning: { stroke: "color-mix(in srgb, var(--severity-caution) 70%, transparent)", width: 6 },
  critical: { stroke: "color-mix(in srgb, var(--severity-critical) 70%, transparent)", width: 6 },
};

export const AnalyseTrackMap = forwardRef<
  TrackMapHandle,
  {
    telemetry: TelemetryPacket[];
    cursorIdx: number;
    outline: Point[] | null;
    mapLabels?: TrackMapLabel[] | null;
    boundaries: { leftEdge: Point[]; rightEdge: Point[]; centerLine: Point[]; pitLane: Point[] | null; coordSystem: string } | null;
    sectors: SectorBoundaries | null;
    segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
    highlights?: TrackHighlight[] | null;
    showInputs?: boolean;
    /** When false, the track shape is drawn from `outline` (real edges) instead
     *  of the telemetry-derived path — used by the live view to show only the
     *  track edges, not the accumulating driving line. Car dot still renders. */
    showTrace?: boolean;
    rotateWithCar: boolean;
    zoom?: number;
  }
>(function AnalyseTrackMap({ telemetry, cursorIdx, outline, mapLabels, boundaries, sectors, segments, highlights, showInputs, showTrace = true, rotateWithCar, zoom = 1 }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const carCanvasRef = useRef<HTMLCanvasElement>(null);
  const pulseRef = useRef<HTMLCanvasElement>(null);
  const carPosRef = useRef<{ x: number; y: number; w: number; h: number; angle?: number } | null>(null);
  // Store transform info so car overlay can draw without redrawing everything
  const transformRef = useRef<{
    w: number;
    h: number;
    offsetX: number;
    offsetZ: number;
    scale: number;
    maxX: number;
    minZ: number;
    displayOutline: Point[];
    offW: number;
    offH: number;
  } | null>(null);
  // Detached canvas caching the static track drawing (boundaries, segments, sectors, labels)
  const bufferCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const resolvedPositions = useMemo(() => {
    const path = lapPath(telemetry, outline);
    return telemetry.map((_, index) => ({
      x: path.x[index],
      z: path.z[index],
    }));
  }, [telemetry, outline]);

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

    const telemetryPointsWithIdx = resolvedPositions.map((point, idx) => ({ ...point, idx })).filter((point, index) => index === 0 || point.x !== 0 || point.z !== 0);
    const telemetryPoints = telemetryPointsWithIdx as { x: number; z: number }[];
    const displayOutline: Point[] = !showTrace ? (outline ?? (telemetryPoints.length > 2 ? telemetryPoints : [])) : telemetryPoints.length > 2 ? telemetryPoints : (outline ?? []);

    if (displayOutline.length < 2) {
      transformRef.current = null;
      bufferCanvasRef.current = null;
      return;
    }

    const flip = needsTrackFlip(telemetry[0]?.gameId);
    const flippedLeft = flip && boundaries?.leftEdge ? flipPoints(boundaries.leftEdge) : boundaries?.leftEdge;
    const flippedRight = flip && boundaries?.rightEdge ? flipPoints(boundaries.rightEdge) : boundaries?.rightEdge;
    const hasBounds = boundaries?.coordSystem && flippedLeft && flippedLeft.length > 2;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    const allBoundsPts: Point[][] = [displayOutline];
    if (hasBounds) allBoundsPts.push(flippedLeft!, flippedRight!);
    if (mapLabels && mapLabels.length > 0) allBoundsPts.push(mapLabels);
    for (const pts of allBoundsPts) {
      for (const p of pts) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
    }
    const rangeX = maxX - minX || 1;
    const rangeZ = maxZ - minZ || 1;
    const padding = 40;
    const baseScale = Math.min((w - padding * 2) / rangeX, (h - padding * 2) / rangeZ);
    const followZoom = rotateWithCar ? 3 : 1;
    const scale = baseScale * zoom * followZoom;

    // For follow view, the zoomed track is larger than the canvas.
    // Size the offscreen to fit the full track at the zoomed scale.
    const trackW = rangeX * scale + padding * 2;
    const trackH = rangeZ * scale + padding * 2;
    const offW = Math.max(w, trackW);
    const offH = Math.max(h, trackH);
    const offsetX = (offW - rangeX * scale) / 2;
    const offsetZ = (offH - rangeZ * scale) / 2;

    transformRef.current = { w, h, offsetX, offsetZ, scale, maxX, minZ, displayOutline, offW, offH };

    function toCanvas(x: number, z: number): [number, number] {
      return [offsetX + (maxX - x) * scale, offsetZ + (z - minZ) * scale];
    }

    // A detached HTML canvas keeps buffered drawing on the DOM main thread,
    // where theme variables can be resolved with getComputedStyle.
    const bufferCanvas = document.createElement("canvas");
    bufferCanvas.width = offW * dpr;
    bufferCanvas.height = offH * dpr;
    const ctx = getSemanticCanvasContext(bufferCanvas)!;
    ctx.scale(dpr, dpr);

    // Draw track boundary surface
    if (hasBounds) {
      const left = flippedLeft!;
      const right = flippedRight!;
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
      ctx.fillStyle = "color-mix(in srgb, var(--track-surface) 25%, transparent)";
      ctx.fill();
      ctx.strokeStyle = "color-mix(in srgb, var(--track-edge) 35%, transparent)";
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

    // Draw track outline
    ctx.beginPath();
    ctx.strokeStyle = showInputs ? "var(--track-outline-strong)" : "var(--track-outline)";
    ctx.lineWidth = showInputs ? 0.75 : 4;
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
      let lo = 0,
        hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumDist[mid] < targetDist) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    // Sector-colored driving line. Native games may define any count (#134).
    if (sectors && displayOutline.length > 10 && !showInputs) {
      const sectorBoundaries = [...sectors.sectorStarts, 1];
      for (let si = 0; si < sectors.sectorCount; si++) {
        const startIdx = fracToIdx(sectorBoundaries[si]);
        const endIdx = fracToIdx(sectorBoundaries[si + 1]);
        if (startIdx >= endIdx) continue;
        ctx.beginPath();
        ctx.strokeStyle = SECTOR_COLOR_VARS[si % SECTOR_COLOR_VARS.length];
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        const [mx, my] = toCanvas(displayOutline[startIdx].x, displayOutline[startIdx].z);
        ctx.moveTo(mx, my);
        for (let i = startIdx + 1; i <= endIdx && i < n; i++) {
          const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      // Colored segments and their curated corner/straight names.
    } else if (segments && segments.length > 0 && !showInputs) {
      const labelCandidates: {
        text: string;
        x: number;
        y: number;
        priority: number;
      }[] = [];
      const labelledNames = new Set<string>();
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        const startIdx = fracToIdx(seg.startFrac);
        const endIdx = fracToIdx(seg.endFrac);
        if (startIdx >= endIdx) continue;
        ctx.beginPath();
        ctx.strokeStyle = seg.type === "corner" ? "var(--track-corner-marker)" : "var(--track-straight-marker)";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        const [mx, my] = toCanvas(displayOutline[startIdx].x, displayOutline[startIdx].z);
        ctx.moveTo(mx, my);
        for (let i = startIdx + 1; i <= endIdx && i < n; i++) {
          const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
          ctx.lineTo(px, py);
        }
        ctx.stroke();

        if (!mapLabels?.length && seg.name && !labelledNames.has(seg.name)) {
          labelledNames.add(seg.name);
          const midIdx = Math.round((startIdx + endIdx) / 2);
          const point = displayOutline[Math.min(midIdx, n - 1)];
          const previous = displayOutline[Math.max(0, midIdx - 2)];
          const next = displayOutline[Math.min(n - 1, midIdx + 2)];
          const dx = next.x - previous.x;
          const dz = next.z - previous.z;
          const length = Math.hypot(dx, dz) || 1;
          const [labelX, labelY] = toCanvas(point.x, point.z);
          labelCandidates.push({
            text: seg.name,
            x: labelX + (-dz / length) * 14,
            y: labelY + (dx / length) * 14,
            priority: seg.type === "corner" ? 1 : 0,
          });
        }
      }

      ctx.font = "var(--font-weight-bold) var(--text-app-micro) var(--font-mono)";
      ctx.textAlign = "center";
      const occupied: { x: number; y: number; w: number; h: number }[] = [];
      for (const label of labelCandidates.sort((a, b) => b.priority - a.priority)) {
        const width = ctx.measureText(label.text).width + 8;
        const rect = {
          x: label.x - width / 2,
          y: label.y - 10,
          w: width,
          h: 14,
        };
        if (
          rect.x < 0 ||
          rect.y < 0 ||
          rect.x + rect.w > offW ||
          rect.y + rect.h > offH ||
          occupied.some((other) => rect.x < other.x + other.w && rect.x + rect.w > other.x && rect.y < other.y + other.h && rect.y + rect.h > other.y)
        ) {
          continue;
        }
        occupied.push(rect);
        ctx.fillStyle = "color-mix(in srgb, var(--track-label-background) 88%, transparent)";
        ctx.beginPath();
        ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 3);
        ctx.fill();
        ctx.fillStyle = "var(--track-label-text)";
        ctx.fillText(label.text, label.x, label.y);
      }
    } else {
      ctx.beginPath();
      ctx.strokeStyle = "var(--track-edge)";
      ctx.lineWidth = 2;
      ctx.moveTo(sx, sy);
      for (let i = 1; i < displayOutline.length; i++) {
        const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
        ctx.lineTo(px, py);
      }
      if (outline) ctx.lineTo(sx, sy);
      ctx.stroke();
    }

    // Official iRacing turns.svg text is already positioned for this exact
    // layout, so preserve it instead of attaching another layout's names.
    if (mapLabels && mapLabels.length > 0 && !showInputs) {
      ctx.font = "var(--font-weight-bold) var(--text-app-micro) var(--font-mono)";
      ctx.textAlign = "center";
      for (const label of mapLabels) {
        const [labelX, labelY] = toCanvas(label.x, label.z);
        const width = ctx.measureText(label.text).width + 6;
        ctx.fillStyle = "color-mix(in srgb, var(--track-label-background) 82%, transparent)";
        ctx.beginPath();
        ctx.roundRect(labelX - width / 2, labelY - 10, width, 13, 3);
        ctx.fill();
        ctx.fillStyle = "var(--track-label-text)";
        ctx.fillText(label.text, labelX, labelY);
      }
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

    // Start/finish. Prefer the telemetry-derived position (packet whose
    // CurrentLap is lowest = just past the line) so the marker lands exactly
    // where the car crossed, independent of where outline[0] happens to sit.
    // Falls back to outline[0] when no telemetry is available.
    if (outline) {
      let sfX = displayOutline[0].x;
      let sfZ = displayOutline[0].z;
      if (telemetry.length > 0) {
        let minLapIdx = 0;
        for (let i = 1; i < telemetry.length; i++) {
          if ((telemetry[i].CurrentLap ?? Infinity) < (telemetry[minLapIdx].CurrentLap ?? Infinity)) {
            minLapIdx = i;
          }
        }
        sfX = resolvedPositions[minLapIdx].x;
        sfZ = resolvedPositions[minLapIdx].z;
      }
      const [sfCx, sfCy] = toCanvas(sfX, sfZ);
      ctx.beginPath();
      ctx.arc(sfCx, sfCy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "var(--track-start)";
      ctx.fill();
      ctx.strokeStyle = "var(--track-label-background)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Sector boundary markers
    if (sectors && displayOutline.length > 10) {
      const sectorFracs = sectors.sectorStarts.slice(1);
      for (let si = 0; si < sectorFracs.length; si++) {
        const sIdx = fracToIdx(sectorFracs[si]);
        const pt = displayOutline[sIdx];
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
          ctx.strokeStyle = SECTOR_COLOR_VARS[si % SECTOR_COLOR_VARS.length];
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(mx, my, 3, 0, Math.PI * 2);
        ctx.fillStyle = SECTOR_COLOR_VARS[si % SECTOR_COLOR_VARS.length];
        ctx.fill();
        ctx.strokeStyle = "var(--track-label-background)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Throttle & brake input lines (two parallel lines offset from center)
    if (showInputs && telemetryPoints.length > 2) {
      const offsetPx = 1.5; // pixels offset from center line
      for (let i = 1; i < telemetryPoints.length; i++) {
        const [x0, y0] = toCanvas(telemetryPoints[i - 1].x, telemetryPoints[i - 1].z);
        const [x1, y1] = toCanvas(telemetryPoints[i].x, telemetryPoints[i].z);
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.01) continue;
        // Normal perpendicular to track direction
        const nx = -dy / len;
        const ny = dx / len;

        const pkt = telemetry[telemetryPointsWithIdx[i].idx];
        if (!pkt) continue;
        const throttle = (pkt.Accel ?? 0) / 255;
        const brake = (pkt.Brake ?? 0) / 255;

        // Throttle line (offset left) — only when input active
        if (throttle > 0) {
          ctx.beginPath();
          ctx.moveTo(x0 + nx * offsetPx, y0 + ny * offsetPx);
          ctx.lineTo(x1 + nx * offsetPx, y1 + ny * offsetPx);
          ctx.globalAlpha = throttle;
          ctx.strokeStyle = "var(--ch-throttle)";
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        // Brake line (offset right) — only when input active
        if (brake > 0) {
          ctx.beginPath();
          ctx.moveTo(x0 - nx * offsetPx, y0 - ny * offsetPx);
          ctx.lineTo(x1 - nx * offsetPx, y1 - ny * offsetPx);
          ctx.globalAlpha = brake;
          ctx.strokeStyle = "var(--ch-brake)";
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    bufferCanvasRef.current = bufferCanvas;

    // Immediately blit to visible canvas (fixed view only — car view uses compositeTrack with rotation)
    if (!rotateWithCar) {
      const mainCtx = getSemanticCanvasContext(canvas);
      if (mainCtx) {
        mainCtx.save();
        mainCtx.setTransform(1, 0, 0, 1, 0, 0);
        mainCtx.clearRect(0, 0, canvas.width, canvas.height);
        mainCtx.restore();
        mainCtx.save();
        mainCtx.scale(dpr, dpr);
        mainCtx.drawImage(bufferCanvas, 0, 0, w, h);
        mainCtx.restore();
      }
    }

    // Clear overlay canvas when in car view (car drawn on main canvas instead)
    if (rotateWithCar) {
      const carCanvas = carCanvasRef.current;
      if (carCanvas) {
        const carCtx = getSemanticCanvasContext(carCanvas);
        if (carCtx) {
          carCtx.clearRect(0, 0, carCanvas.width, carCanvas.height);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telemetry, resolvedPositions, outline, mapLabels, boundaries, sectors, segments, rotateWithCar, zoom, highlights, showInputs, showTrace]);

  // Composite the cached track buffer onto the main canvas with rotation for follow view.
  const compositeTrack = useCallback(
    (idx: number) => {
      const canvas = canvasRef.current;
      const bufferCanvas = bufferCanvasRef.current;
      const t = transformRef.current;
      if (!canvas || !bufferCanvas || !t) return;

      const ctx = getSemanticCanvasContext(canvas);
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      ctx.save();
      ctx.scale(dpr, dpr);

      const pkt = telemetry[idx];
      const position = resolvedPositions[idx];
      const game = pkt ? tryGetGame(pkt.gameId) : undefined;
      if (pkt && position) {
        const carCx = t.offsetX + (t.maxX - position.x) * t.scale;
        const carCy = t.offsetZ + (position.z - t.minZ) * t.scale;
        ctx.translate(t.w / 2, t.h / 2);
        ctx.rotate(game?.followViewRotation(pkt.Yaw) ?? Math.PI - pkt.Yaw);
        ctx.translate(-carCx, -carCy);
      }

      ctx.drawImage(bufferCanvas, 0, 0, t.offW, t.offH);

      const pkt2 = telemetry[idx];
      const position2 = resolvedPositions[idx];
      if (pkt2 && position2) {
        const cx = t.offsetX + (t.maxX - position2.x) * t.scale;
        const cy = t.offsetZ + (position2.z - t.minZ) * t.scale;
        const [dx, dz] = game?.carForwardOffset(pkt2.Yaw) ?? [Math.sin(pkt2.Yaw), Math.cos(pkt2.Yaw)];
        const fwdX = position2.x + dx;
        const fwdZ = position2.z + dz;
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
        ctx.fillStyle = "var(--app-accent)";
        ctx.fill();
        ctx.strokeStyle = "var(--track-label-background)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
        carPosRef.current = { x: t.w / 2, y: t.h / 2, w: t.w, h: t.h, angle: -Math.PI / 2 };
      }

      ctx.restore();
    },
    [telemetry, resolvedPositions, rotateWithCar],
  );

  // Draw car dot on overlay canvas (fixed view only — avoids full redraw)
  const drawCarOverlay = useCallback(
    (idx: number) => {
      const carCanvas = carCanvasRef.current;
      const t = transformRef.current;
      if (!carCanvas || !t) return;
      const dpr = window.devicePixelRatio || 1;
      carCanvas.width = t.w * dpr;
      carCanvas.height = t.h * dpr;
      carCanvas.style.width = `${t.w}px`;
      carCanvas.style.height = `${t.h}px`;
      const ctx = getSemanticCanvasContext(carCanvas);
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, t.w, t.h);

      const pkt = telemetry[idx];
      const position = resolvedPositions[idx];
      if (!pkt || !position) return;

      // The offscreen is blitted to the canvas scaled to fit: drawImage(offscreen, 0, 0, w, h).
      // When offW > w (e.g. wide tracks where Z dimension is the limiting scale), coordinates
      // must be scaled to match the displayed track position.
      const scaleX = t.w / t.offW;
      const scaleY = t.h / t.offH;

      function toCanvas(x: number, z: number): [number, number] {
        return [(t!.offsetX + (t!.maxX - x) * t!.scale) * scaleX, (t!.offsetZ + (z - t!.minZ) * t!.scale) * scaleY];
      }

      const [cx, cy] = toCanvas(position.x, position.z);
      const triSize = 8;
      const game = tryGetGame(pkt.gameId);
      const [dx, dz] = game?.carForwardOffset(pkt.Yaw) ?? [Math.sin(pkt.Yaw), Math.cos(pkt.Yaw)];
      const fwdX = position.x + dx;
      const fwdZ = position.z + dz;
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
      ctx.fillStyle = "var(--app-accent)";
      ctx.fill();
      ctx.strokeStyle = "var(--track-label-background)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      carPosRef.current = { x: cx, y: cy, w: t.w, h: t.h, angle };
    },
    [telemetry, resolvedPositions],
  );

  // Imperative cursor update — called from animation loop without React re-render
  const updateCursor = useCallback(
    (idx: number) => {
      if (rotateWithCar) {
        // Car-view: composite cached track with rotation + draw car on main canvas
        compositeTrack(idx);
      } else {
        // Fixed view: car drawn on separate overlay canvas only
        drawCarOverlay(idx);
      }
    },
    [rotateWithCar, compositeTrack, drawCarOverlay],
  );

  useImperativeHandle(ref, () => ({ updateCursor }), [updateCursor]);

  // Build offscreen cache + blit/composite — useLayoutEffect runs before browser paint (no flash)
  useLayoutEffect(() => {
    drawStaticTrack();
    // In car view, composite with rotation after offscreen is ready
    if (rotateWithCar) {
      compositeTrack(cursorIdx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawStaticTrack]);

  // ResizeObserver — rebuild the offscreen cache whenever the canvas
  // dimensions change (window resize, pane drag, layout toggles, etc).
  const cursorRef = useRef(cursorIdx);
  useEffect(() => {
    cursorRef.current = cursorIdx;
  }, [cursorIdx]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let lastW = 0;
    let lastH = 0;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width === lastW && height === lastH) return;
      lastW = width;
      lastH = height;
      drawStaticTrack();
      if (rotateWithCar) compositeTrack(cursorRef.current);
      else drawCarOverlay(cursorRef.current);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [drawStaticTrack, compositeTrack, drawCarOverlay, rotateWithCar]);

  // Update car overlay when cursorIdx changes via React state (fixed view only)
  useLayoutEffect(() => {
    if (!rotateWithCar) drawCarOverlay(cursorIdx);
  }, [cursorIdx, drawCarOverlay, rotateWithCar]);

  // Pulse ring animation on overlay canvas
  useEffect(() => {
    const pulse = pulseRef.current;
    if (!pulse) return;
    let animId: number;
    const draw = () => {
      const pos = carPosRef.current;
      const ctx2 = getSemanticCanvasContext(pulse);
      if (!ctx2 || !pos) {
        animId = requestAnimationFrame(draw);
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      pulse.width = pos.w * dpr;
      pulse.height = pos.h * dpr;
      pulse.style.width = `${pos.w}px`;
      pulse.style.height = `${pos.h}px`;
      ctx2.scale(dpr, dpr);
      ctx2.clearRect(0, 0, pos.w, pos.h);
      const cycle = Date.now() % 2500;
      if (cycle > 1000) {
        ctx2.restore();
        animId = requestAnimationFrame(draw);
        return;
      }
      const t = cycle / 1000;
      const eased = 1 - (1 - t) ** 3;
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
      ctx2.globalAlpha = opacity;
      ctx2.strokeStyle = "var(--app-accent)";
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
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={carCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <canvas ref={pulseRef} className="absolute inset-0 w-full h-full pointer-events-none" />
    </div>
  );
});
