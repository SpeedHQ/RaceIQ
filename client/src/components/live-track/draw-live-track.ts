import { pointAtLapFraction } from "@shared/racing/tracks/path";
import type { TuneIssue } from "@shared/racing/tuning/issues";
import type { TelemetryPacket } from "@shared/telemetry/types";
import type { MutableRefObject, RefObject } from "react";
import { SECTOR_COLOR_VARS } from "@/lib/colors";
import { drawPitLines, type PitLine } from "@/lib/canvas/draw-track";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";

export interface Point {
  x: number;
  z: number;
}
export interface TrackBoundaryData {
  leftEdge: Point[] | null;
  rightEdge: Point[] | null;
  centerLine: Point[];
  pitLane: Point[] | null;
  coordSystem: string;
}
const ISSUE_COLORS: Record<TuneIssue["severity"], string> = { info: "var(--status-info)", warn: "var(--status-warning)", critical: "var(--status-danger)" };

export function drawLiveTrack({
  canvasRef,
  packet,
  outline,
  pitLines,
  noOutline,
  isRecorded,
  startYaw,
  sectors,
  boundaries,
  issues,
  liveTraceRef,
  deadReckonedPosRef,
  lapDistRef,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  packet: TelemetryPacket | null;
  outline: Point[] | null;
  pitLines: PitLine[];
  noOutline: boolean;
  isRecorded: boolean;
  startYaw: number | null;
  sectors: { s1End: number; s2End: number } | null;
  boundaries: TrackBoundaryData | null;
  issues?: TuneIssue[];
  liveTraceRef: MutableRefObject<Point[]>;
  deadReckonedPosRef: MutableRefObject<Point | null>;
  lapDistRef: MutableRefObject<{ startDist: number; totalDist: number; lastLap: number }>;
}) {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const ctx = getSemanticCanvasContext(canvas);
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  // Prefer boundary-derived center-line (geometric track center) over recorded driving line
  const isGameCoords = boundaries?.coordSystem === "forza" || boundaries?.coordSystem === "f1-2025";
  const boundaryCenter = isGameCoords && boundaries!.centerLine?.length > 2 ? boundaries!.centerLine : null;
  const displayOutline = boundaryCenter ?? outline ?? (liveTraceRef.current.length >= 5 ? liveTraceRef.current : null);

  if (!displayOutline || displayOutline.length < 2) {
    if (noOutline) {
      ctx.fillStyle = "var(--app-text-dim)";
      ctx.font = "var(--text-app-label) var(--font-sans)";
      ctx.textAlign = "center";
      ctx.fillText("Drive to map track...", w / 2, h / 2);
    }
    return;
  }

  const isLiveTrace = !outline && !boundaryCenter;

  // Fit the racing surface and boundary edges. Pit-road markings use this
  // transform without shrinking the main track.
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  const allPoints = [displayOutline];
  if (boundaries) {
    if (boundaries.leftEdge) allPoints.push(boundaries.leftEdge);
    if (boundaries.rightEdge) allPoints.push(boundaries.rightEdge);
  }
  for (const pts of allPoints) {
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  }

  const rangeX = maxX - minX || 1;
  const rangeZ = maxZ - minZ || 1;
  const padding = 20;
  const scaleX = (w - padding * 2) / rangeX;
  const scaleZ = (h - padding * 2) / rangeZ;
  const scale = Math.min(scaleX, scaleZ);
  const offsetX = (w - rangeX * scale) / 2;
  const offsetZ = (h - rangeZ * scale) / 2;

  // Transform world-space to canvas pixels. Coords normalized server-side.
  // X is flipped so right in-game = right on screen.
  function toCanvas(x: number, z: number): [number, number] {
    return [offsetX + (maxX - x) * scale, offsetZ + (z - minZ) * scale];
  }

  drawPitLines(ctx, pitLines, toCanvas);

  // Compute jump threshold: skip segments where world-space distance is abnormally large.
  // Use the 90th percentile * 3 to avoid breaking at normal sparse sections (straights).
  const worldDists: number[] = [];
  for (let i = 1; i < displayOutline.length; i++) {
    const dx = displayOutline[i].x - displayOutline[i - 1].x;
    const dz = displayOutline[i].z - displayOutline[i - 1].z;
    worldDists.push(Math.sqrt(dx * dx + dz * dz));
  }
  const sortedDists = [...worldDists].sort((a, b) => a - b);
  const p90 = sortedDists[Math.floor(sortedDists.length * 0.9)] || 1;
  const jumpThreshold = Math.max(p90 * 3, 50);

  function isJump(i: number): boolean {
    return i > 0 && i <= worldDists.length && worldDists[i - 1] > jumpThreshold;
  }

  // Draw track boundary surface (filled polygon behind center-line)
  if (boundaries?.leftEdge && boundaries.leftEdge.length > 2 && boundaries.rightEdge && boundaries.rightEdge.length > 2) {
    ctx.beginPath();
    // Left edge forward
    const [lx0, ly0] = toCanvas(boundaries.leftEdge[0].x, boundaries.leftEdge[0].z);
    ctx.moveTo(lx0, ly0);
    for (let i = 1; i < boundaries.leftEdge.length; i++) {
      const [lx, ly] = toCanvas(boundaries.leftEdge[i].x, boundaries.leftEdge[i].z);
      ctx.lineTo(lx, ly);
    }
    // Right edge reversed (to close the polygon)
    for (let i = boundaries.rightEdge.length - 1; i >= 0; i--) {
      const [rx, ry] = toCanvas(boundaries.rightEdge[i].x, boundaries.rightEdge[i].z);
      ctx.lineTo(rx, ry);
    }
    ctx.closePath();
    ctx.fillStyle = "color-mix(in srgb, var(--track-surface) 25%, transparent)";
    ctx.fill();

    // Stroke edges
    ctx.strokeStyle = "color-mix(in srgb, var(--track-edge) 35%, transparent)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx0, ly0);
    for (let i = 1; i < boundaries.leftEdge.length; i++) {
      const [lx, ly] = toCanvas(boundaries.leftEdge[i].x, boundaries.leftEdge[i].z);
      ctx.lineTo(lx, ly);
    }
    ctx.stroke();
    ctx.beginPath();
    const [rx0, ry0] = toCanvas(boundaries.rightEdge[0].x, boundaries.rightEdge[0].z);
    ctx.moveTo(rx0, ry0);
    for (let i = 1; i < boundaries.rightEdge.length; i++) {
      const [rx, ry] = toCanvas(boundaries.rightEdge[i].x, boundaries.rightEdge[i].z);
      ctx.lineTo(rx, ry);
    }
    ctx.stroke();
  }

  const [sx, sy] = toCanvas(displayOutline[0].x, displayOutline[0].z);

  if (isLiveTrace || !sectors) {
    // No sectors: draw uniform outline
    ctx.beginPath();
    ctx.strokeStyle = isLiveTrace ? "color-mix(in srgb, var(--app-accent) 25%, var(--app-surface))" : "var(--track-outline)";
    ctx.lineWidth = isLiveTrace ? 3 : 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.moveTo(sx, sy);
    for (let i = 1; i < displayOutline.length; i++) {
      const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
      if (isJump(i)) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    if (!isLiveTrace) ctx.lineTo(sx, sy);
    ctx.stroke();

    // Thinner highlight
    ctx.beginPath();
    ctx.strokeStyle = isLiveTrace ? "var(--app-accent)" : "var(--track-edge)";
    ctx.lineWidth = isLiveTrace ? 1.5 : 2;
    ctx.globalAlpha = isLiveTrace ? 0.6 : 1;
    ctx.moveTo(sx, sy);
    for (let i = 1; i < displayOutline.length; i++) {
      const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
      if (isJump(i)) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    if (!isLiveTrace) ctx.lineTo(sx, sy);
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else {
    // Sector-colored track using the theme-owned ordered identities.
    const sectorColors = SECTOR_COLOR_VARS;
    const sectorBgColors = sectorColors.slice(0, 3).map((color) => `color-mix(in srgb, ${color} 25%, var(--app-surface))`);
    const n = displayOutline.length;
    const s1Idx = Math.round(sectors.s1End * (n - 1));
    const s2Idx = Math.round(sectors.s2End * (n - 1));

    function getSectorForIdx(i: number): number {
      if (i < s1Idx) return 0;
      if (i < s2Idx) return 1;
      return 2;
    }

    // Draw dark background pass
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 5;
    let currentSector = getSectorForIdx(0);
    ctx.beginPath();
    ctx.strokeStyle = sectorBgColors[currentSector];
    ctx.moveTo(sx, sy);
    for (let i = 1; i < n; i++) {
      const sec = getSectorForIdx(i);
      const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
      if (isJump(i)) {
        ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = sectorBgColors[sec];
        ctx.moveTo(px, py);
      } else if (sec !== currentSector) {
        ctx.lineTo(px, py);
        ctx.stroke();
        currentSector = sec;
        ctx.beginPath();
        ctx.strokeStyle = sectorBgColors[currentSector];
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    // Close back to start
    ctx.lineTo(sx, sy);
    ctx.stroke();

    // Draw bright sector line on top
    ctx.lineWidth = 2.5;
    currentSector = getSectorForIdx(0);
    ctx.beginPath();
    ctx.strokeStyle = sectorColors[currentSector];
    ctx.moveTo(sx, sy);
    for (let i = 1; i < n; i++) {
      const sec = getSectorForIdx(i);
      const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
      if (isJump(i)) {
        ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = sectorColors[sec];
        ctx.moveTo(px, py);
      } else if (sec !== currentSector) {
        ctx.lineTo(px, py);
        ctx.stroke();
        currentSector = sec;
        ctx.beginPath();
        ctx.strokeStyle = sectorColors[currentSector];
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }

  // Start/finish marker + direction arrow
  if (!isLiveTrace) {
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "var(--track-start)";
    ctx.fill();
    ctx.strokeStyle = "var(--track-label-background)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Direction arrow: use Yaw from telemetry if available, else fallback to outline geometry
    let nx = 0;
    let ny = 0;
    let hasDirection = false;

    if (startYaw != null) {
      // Yaw: radians, 0 = +Z, positive = clockwise
      // X is flipped on canvas (maxX - x), so negate X component
      nx = -Math.sin(startYaw);
      ny = Math.cos(startYaw);
      const len = Math.sqrt(nx * nx + ny * ny);
      if (len > 0) {
        nx /= len;
        ny /= len;
        hasDirection = true;
      }
    }

    if (!hasDirection) {
      // Fallback: compute from first few outline points
      const aheadIdx = Math.min(Math.floor(displayOutline.length * 0.03) + 1, displayOutline.length - 1);
      const [aheadX, aheadY] = toCanvas(displayOutline[aheadIdx].x, displayOutline[aheadIdx].z);
      const adx = aheadX - sx;
      const ady = aheadY - sy;
      const alen = Math.sqrt(adx * adx + ady * ady);
      if (alen > 3) {
        nx = adx / alen;
        ny = ady / alen;
        hasDirection = true;
      } else {
        nx = 0;
        ny = 0;
      }
    }

    if (hasDirection) {
      const tipX = sx + nx * 20;
      const tipY = sy + ny * 20;
      const wl = 5;

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tipX, tipY);
      ctx.strokeStyle = "var(--track-start)";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - nx * wl * 2 + ny * wl, tipY - ny * wl * 2 - nx * wl);
      ctx.lineTo(tipX - nx * wl * 2 - ny * wl, tipY - ny * wl * 2 + nx * wl);
      ctx.closePath();
      ctx.fillStyle = "var(--track-start)";
      ctx.fill();
    }
  }

  // Sector boundary markers on the outline
  if (!isLiveTrace && sectors && displayOutline.length > 10) {
    const sectorFracs = [sectors.s1End, sectors.s2End];

    for (let si = 0; si < sectorFracs.length; si++) {
      const idx = Math.round(sectorFracs[si] * (displayOutline.length - 1));
      const pt = displayOutline[Math.min(idx, displayOutline.length - 1)];
      if (!pt) continue;
      const [mx, my] = toCanvas(pt.x, pt.z);

      // Small colored tick perpendicular to the track direction
      const prevIdx = Math.max(0, idx - 3);
      const nextIdx = Math.min(displayOutline.length - 1, idx + 3);
      const dx = displayOutline[nextIdx].x - displayOutline[prevIdx].x;
      const dz = displayOutline[nextIdx].z - displayOutline[prevIdx].z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0) {
        // Perpendicular direction (flipped for canvas X mirror)
        const nx = dz / len;
        const nz = -dx / len;
        // Account for X flip in toCanvas
        const tickLen = 8;
        ctx.beginPath();
        ctx.moveTo(mx - nx * tickLen, my + nz * tickLen);
        ctx.lineTo(mx + nx * tickLen, my - nz * tickLen);
        ctx.strokeStyle = SECTOR_COLOR_VARS[si];
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Small dot at sector boundary
      ctx.beginPath();
      ctx.arc(mx, my, 3, 0, Math.PI * 2);
      ctx.fillStyle = SECTOR_COLOR_VARS[si];
      ctx.fill();
      ctx.strokeStyle = "var(--track-label-background)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Live Tuning Dashboard: transient issue markers, placed by distanceFrac
  if (!isLiveTrace && issues && issues.length > 0 && displayOutline.length > 10) {
    for (const issue of issues) {
      if (issue.distanceFrac == null) continue;
      const idx = Math.round(issue.distanceFrac * (displayOutline.length - 1));
      const pt = displayOutline[Math.min(Math.max(idx, 0), displayOutline.length - 1)];
      if (!pt) continue;
      const [ix, iy] = toCanvas(pt.x, pt.z);
      ctx.beginPath();
      ctx.arc(ix, iy, 6, 0, Math.PI * 2);
      ctx.fillStyle = ISSUE_COLORS[issue.severity];
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "var(--track-label-background)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // "Building map..." label for live trace
  if (isLiveTrace) {
    ctx.fillStyle = "var(--app-text-dim)";
    ctx.font = "var(--text-app-caption) var(--font-sans)";
    ctx.textAlign = "left";
    ctx.fillText(`Mapping... ${displayOutline.length} pts`, 8, h - 8);
  }

  // Live car position
  if (packet) {
    let cx: number;
    let cy: number;
    let hasPos = false;

    const nativeLapFraction = packet.iracing?.lapDistancePct;
    if (packet.gameId === "iracing" && outline && Number.isFinite(nativeLapFraction)) {
      const point = pointAtLapFraction(displayOutline, nativeLapFraction!);
      if (point) {
        [cx, cy] = toCanvas(point.x, point.z);
        hasPos = true;
      } else {
        [cx, cy] = [0, 0];
      }
    } else if (isLiveTrace && packet.gameId === "iracing") {
      const point = deadReckonedPosRef.current;
      if (point) {
        [cx, cy] = toCanvas(point.x, point.z);
        hasPos = true;
      } else {
        [cx, cy] = [0, 0];
      }
    } else if (isLiveTrace || isRecorded || boundaryCenter) {
      // Forza coords: live trace, recorded outline, or boundary center — plot directly
      if (packet.PositionX !== 0 || packet.PositionZ !== 0) {
        [cx, cy] = toCanvas(packet.PositionX, packet.PositionZ);
        hasPos = true;
      } else {
        [cx, cy] = [0, 0];
      }
    } else {
      // Pre-made outline: use distance fraction to determine position.
      // (distance traveled this lap) / (total lap distance) = 0-1 progress
      const d = lapDistRef.current;
      if (d.totalDist > 50) {
        const lapDist = packet.DistanceTraveled - d.startDist;
        const frac = Math.max(0, Math.min(lapDist / d.totalDist, 1));
        const idx = Math.round(frac * (displayOutline.length - 1));
        const pt = displayOutline[Math.min(idx, displayOutline.length - 1)];
        if (pt) {
          [cx, cy] = toCanvas(pt.x, pt.z);
          hasPos = true;
        } else {
          [cx, cy] = [0, 0];
        }
      } else {
        [cx, cy] = [0, 0];
        ctx.fillStyle = "var(--app-text-dim)";
        ctx.font = "var(--text-app-micro) var(--font-sans)";
        ctx.textAlign = "left";
        ctx.fillText("Complete a lap to track position", 8, h - 8);
      }
    }

    if (hasPos) {
      // Glow
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.fillStyle = "color-mix(in srgb, var(--app-accent) 20%, transparent)";
      ctx.fill();
      // Dot
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "var(--app-accent)";
      ctx.fill();
      ctx.strokeStyle = "var(--track-label-background)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}
