import { useEffect, useRef, useState, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";
import { api } from "../lib/api";

interface Props {
  packet: TelemetryPacket | null;
}

interface Point {
  x: number;
  z: number;
}

interface TrackSectors {
  s1End: number;
  s2End: number;
}

/**
 * LiveTrackMap — Renders the car's position on a 2D track outline.
 * Two modes: (1) pre-made outline fetched by track ordinal, or (2) live trace
 * built in real-time from position data when no outline exists.
 * Coordinates use Forza's world-space X/Z (Y is vertical/ignored).
 */
export function LiveTrackMap({ packet }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [noOutline, setNoOutline] = useState(false);
  const [isRecorded, setIsRecorded] = useState(false); // true = Forza coords, can plot directly
  const [startYaw, setStartYaw] = useState<number | null>(null); // Yaw at start/finish line
  const [sectors, setSectors] = useState<{ s1End: number; s2End: number } | null>(null);
  const lastTrackOrdRef = useRef<number | null>(null);

  // Distance-based position tracking
  const lapDistRef = useRef<{ startDist: number; totalDist: number; lastLap: number }>({
    startDist: 0,
    totalDist: 0,
    lastLap: -1,
  });

  // Live trace: build outline from driving data when no pre-made outline exists.
  const liveTraceRef = useRef<Point[]>([]);
  const lastTracePos = useRef<Point | null>(null);
  const traceMinDist = 3;

  // Auto-detect track changes from packet.TrackOrdinal and fetch outline
  useEffect(() => {
    if (!packet || !packet.TrackOrdinal) return;
    const trackOrd = packet.TrackOrdinal;
    if (trackOrd === lastTrackOrdRef.current) return;
    lastTrackOrdRef.current = trackOrd;

    // Reset state for new track
    liveTraceRef.current = [];
    lastTracePos.current = null;
    lapDistRef.current = { startDist: 0, totalDist: 0, lastLap: -1 };
    setOutline(null);
    setNoOutline(false);
    setSectors(null);

    // Fetch sectors
    api.getTrackSectors(trackOrd)
      .then((data: any) => { if (data?.s1End) setSectors(data); })
      .catch(() => {});

    api.getTrackOutline(trackOrd)
      .then((data: any) => {
        // New format: { points, recorded, startYaw } or legacy array format
        if (data.points && Array.isArray(data.points)) {
          setOutline(data.points);
          setIsRecorded(!!data.recorded);
          setStartYaw(data.startYaw ?? null);
        } else if (Array.isArray(data)) {
          setOutline(data);
          setIsRecorded(false);
          setStartYaw(null);
        } else {
          throw new Error("invalid format");
        }
        setNoOutline(false);
      })
      .catch(() => {
        setOutline(null);
        setIsRecorded(false);
        setStartYaw(null);
        setNoOutline(true);
      });
  }, [packet?.TrackOrdinal]);

  // Re-fetch outline on lap completion if we don't have a recorded one yet.
  // The server may have just recorded the first lap trace.
  useEffect(() => {
    if (!packet || isRecorded) return;
    const trackOrd = lastTrackOrdRef.current;
    if (!trackOrd) return;

    api.getTrackOutline(trackOrd)
      .then((data: any) => {
        if (data?.points && data.recorded) {
          setOutline(data.points);
          setIsRecorded(true);
          setStartYaw(data.startYaw ?? null);
        }
      })
      .catch(() => {});
  }, [packet?.LapNumber]);

  // Track distance at lap boundaries for position estimation
  useEffect(() => {
    if (!packet) return;
    const d = lapDistRef.current;
    if (packet.LapNumber !== d.lastLap) {
      // Lap boundary: record total distance of completed lap, reset start
      if (d.lastLap >= 0 && d.startDist > 0) {
        const completedDist = packet.DistanceTraveled - d.startDist;
        if (completedDist > 50) {
          d.totalDist = completedDist;
        }
      }
      d.startDist = packet.DistanceTraveled;
      d.lastLap = packet.LapNumber;
    }
  }, [packet?.LapNumber, packet?.DistanceTraveled]);


  // Always collect Forza positions — used for live trace (no outline) and
  // for nearest-point mapping (pre-made outline where coords don't match)
  useEffect(() => {
    if (!packet) return;
    if (packet.PositionX === 0 && packet.PositionZ === 0) return;

    const pos = { x: packet.PositionX, z: packet.PositionZ };
    const last = lastTracePos.current;

    if (last) {
      const dx = pos.x - last.x;
      const dz = pos.z - last.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < traceMinDist) return;
    }

    liveTraceRef.current.push(pos);
    lastTracePos.current = pos;

    // Cap at 2000 points (enough for most tracks)
    if (liveTraceRef.current.length > 2000) {
      liveTraceRef.current.shift();
    }
  }, [packet]);

  // Redraw
  useEffect(() => {
    draw();
  });

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
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

    // Use live trace as fallback when no pre-made outline
    const displayOutline = outline ?? (liveTraceRef.current.length >= 5 ? liveTraceRef.current : null);

    if (!displayOutline || displayOutline.length < 2) {
      if (noOutline) {
        ctx.fillStyle = "#475569";
        ctx.font = "12px system-ui";
        ctx.textAlign = "center";
        ctx.fillText("Drive to map track...", w / 2, h / 2);
      }
      return;
    }

    const isLiveTrace = !outline;

    // Fit-to-canvas: compute bounding box, then uniform scale to preserve aspect ratio
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of displayOutline) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }

    const rangeX = (maxX - minX) || 1;
    const rangeZ = (maxZ - minZ) || 1;
    const padding = 20;
    const scaleX = (w - padding * 2) / rangeX;
    const scaleZ = (h - padding * 2) / rangeZ;
    const scale = Math.min(scaleX, scaleZ);
    const offsetX = (w - rangeX * scale) / 2;
    const offsetZ = (h - rangeZ * scale) / 2;

    // Transform world-space (meters) to canvas pixels, centered with uniform scale.
    // X is flipped so that turning right in-game shows as right on the map.
    function toCanvas(x: number, z: number): [number, number] {
      return [
        offsetX + (maxX - x) * scale,
        offsetZ + (z - minZ) * scale,
      ];
    }

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

    // Draw track outline, breaking at jumps
    ctx.beginPath();
    ctx.strokeStyle = isLiveTrace ? "#1e3a5f" : "#334155";
    ctx.lineWidth = isLiveTrace ? 3 : 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const [sx, sy] = toCanvas(displayOutline[0].x, displayOutline[0].z);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < displayOutline.length; i++) {
      const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
      if (isJump(i)) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    if (!isLiveTrace) ctx.lineTo(sx, sy);
    ctx.stroke();

    // Draw thinner colored line on top
    ctx.beginPath();
    ctx.strokeStyle = isLiveTrace ? "#22d3ee" : "#64748b";
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

    // Start/finish marker + direction arrow
    if (!isLiveTrace) {
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#10b981";
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Direction arrow: use Yaw from telemetry if available, else fallback to outline geometry
      let nx: number, ny: number;
      let hasDirection = false;

      if (startYaw != null) {
        // Forza Yaw: radians, 0 = +Z, positive = clockwise when viewed from above
        // Canvas X is flipped (maxX - x), so negate the X component
        // Direction in world space: dx = sin(yaw), dz = cos(yaw)
        nx = -Math.sin(startYaw);
        ny = Math.cos(startYaw);
        const len = Math.sqrt(nx * nx + ny * ny);
        if (len > 0) { nx /= len; ny /= len; hasDirection = true; }
      }

      if (!hasDirection) {
        // Fallback: compute from first few outline points
        const aheadIdx = Math.min(Math.floor(displayOutline.length * 0.03) + 1, displayOutline.length - 1);
        const [aheadX, aheadY] = toCanvas(displayOutline[aheadIdx].x, displayOutline[aheadIdx].z);
        const adx = aheadX - sx;
        const ady = aheadY - sy;
        const alen = Math.sqrt(adx * adx + ady * ady);
        if (alen > 3) { nx = adx / alen; ny = ady / alen; hasDirection = true; }
        else { nx = 0; ny = 0; }
      }

      if (hasDirection) {
        const tipX = sx + nx * 20;
        const tipY = sy + ny * 20;
        const wl = 5;

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tipX, tipY);
        ctx.strokeStyle = "#10b981";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - nx * wl * 2 + ny * wl, tipY - ny * wl * 2 - nx * wl);
        ctx.lineTo(tipX - nx * wl * 2 - ny * wl, tipY - ny * wl * 2 + nx * wl);
        ctx.closePath();
        ctx.fillStyle = "#10b981";
        ctx.fill();
      }
    }

    // Sector boundary markers on the outline
    if (!isLiveTrace && sectors && displayOutline.length > 10) {
      const sectorColors = ["#ef4444", "#3b82f6", "#eab308"];
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
          ctx.strokeStyle = sectorColors[si];
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Small dot at sector boundary
        ctx.beginPath();
        ctx.arc(mx, my, 3, 0, Math.PI * 2);
        ctx.fillStyle = sectorColors[si];
        ctx.fill();
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // "Building map..." label for live trace
    if (isLiveTrace) {
      ctx.fillStyle = "#475569";
      ctx.font = "10px system-ui";
      ctx.textAlign = "left";
      ctx.fillText(`Mapping... ${displayOutline.length} pts`, 8, h - 8);
    }

    // Live car position
    if (packet) {
      let cx: number, cy: number;
      let hasPos = false;

      if (isLiveTrace || isRecorded) {
        // Forza coords: live trace or recorded outline — plot directly
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
          ctx.fillStyle = "#475569";
          ctx.font = "9px system-ui";
          ctx.textAlign = "left";
          ctx.fillText("Complete a lap to track position", 8, h - 8);
        }
      }

      if (hasPos) {
        // Glow
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(34, 211, 238, 0.2)";
        ctx.fill();
        // Dot
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#22d3ee";
        ctx.fill();
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  async function handleDeleteMap() {
    const trackOrd = lastTrackOrdRef.current;
    if (!trackOrd) return;
    try {
      await api.deleteTrackOutline(trackOrd);
      setOutline(null);
      setIsRecorded(false);
      setStartYaw(null);
      setNoOutline(true);
      liveTraceRef.current = [];
      lastTracePos.current = null;
    } catch {}
  }

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        className="w-full"
        style={{ height: 250 }}
      />
      {isRecorded && (
        <button
          onClick={handleDeleteMap}
          className="absolute top-2 right-2 px-2 py-1 text-xs bg-app-surface-alt/80 hover:bg-red-900/80 text-app-text-secondary hover:text-red-300 rounded border border-app-border-input hover:border-red-700 transition-colors"
          title="Delete recorded track map and re-record from driving"
        >
          Reset Map
        </button>
      )}
    </div>
  );
}
