import { useEffect, useRef, useState, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";

interface Props {
  packet: TelemetryPacket | null;
}

interface Point {
  x: number;
  z: number;
  speed: number;
}

export function LiveTrackMap({ packet }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [trackPoints, setTrackPoints] = useState<Point[]>([]);
  const lastFetchedSessionRef = useRef<number | null>(null);

  // Fetch track outline from the most recent completed lap
  const fetchTrackOutline = useCallback(async () => {
    try {
      const res = await fetch("/api/laps");
      if (!res.ok) return;
      const laps = await res.json();
      if (!laps.length) return;

      // Use the most recent valid lap
      const lap = laps.find((l: { isValid: boolean }) => l.isValid) ?? laps[0];
      const lapRes = await fetch(`/api/laps/${lap.id}`);
      if (!lapRes.ok) return;
      const lapData = await lapRes.json();

      const points: Point[] = [];
      for (let i = 0; i < lapData.telemetry.length; i += 5) {
        const p = lapData.telemetry[i];
        if (p.PositionX === 0 && p.PositionZ === 0) continue;
        points.push({
          x: p.PositionX,
          z: p.PositionZ,
          speed: (p.Speed ?? 0) * 2.23694,
        });
      }
      if (points.length > 10) {
        setTrackPoints(points);
      }
    } catch {}
  }, []);

  // Fetch track outline when session changes or on first lap completion
  useEffect(() => {
    if (!packet) return;
    // Refetch when we have no track points and laps exist, or on lap change
    if (trackPoints.length === 0 || packet.LapNumber > 1) {
      // Debounce: only fetch once per session
      const sessionCheck = packet.CarOrdinal;
      if (sessionCheck !== lastFetchedSessionRef.current) {
        lastFetchedSessionRef.current = sessionCheck;
        fetchTrackOutline();
      }
    }
  }, [packet?.LapNumber, packet?.CarOrdinal, trackPoints.length, fetchTrackOutline]);

  // Also try fetching on mount
  useEffect(() => {
    fetchTrackOutline();
  }, [fetchTrackOutline]);

  // Redraw on every packet
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

    if (trackPoints.length < 2) {
      ctx.fillStyle = "#475569";
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("Complete a lap to render track map", w / 2, h / 2);
      return;
    }

    // Find bounds from track outline
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let maxSpeed = 1;
    for (const p of trackPoints) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
      maxSpeed = Math.max(maxSpeed, p.speed);
    }

    const rangeX = (maxX - minX) || 1;
    const rangeZ = (maxZ - minZ) || 1;
    const padding = 25;
    const scaleX = (w - padding * 2) / rangeX;
    const scaleZ = (h - padding * 2) / rangeZ;
    const scale = Math.min(scaleX, scaleZ);
    const offsetX = (w - rangeX * scale) / 2;
    const offsetZ = (h - rangeZ * scale) / 2;

    function toCanvas(x: number, z: number): [number, number] {
      return [
        offsetX + (x - minX) * scale,
        offsetZ + (z - minZ) * scale,
      ];
    }

    function speedColor(speed: number): string {
      const t = Math.min(speed / maxSpeed, 1);
      if (t < 0.33) {
        const s = t / 0.33;
        return `rgb(${Math.round(s * 50)}, ${Math.round(100 + s * 155)}, ${Math.round(255 - s * 100)})`;
      } else if (t < 0.66) {
        const s = (t - 0.33) / 0.33;
        return `rgb(${Math.round(50 + s * 205)}, ${Math.round(255 - s * 55)}, ${Math.round(155 - s * 155)})`;
      }
      const s = (t - 0.66) / 0.34;
      return `rgb(255, ${Math.round(200 - s * 200)}, 0)`;
    }

    // Draw static track outline colored by speed
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < trackPoints.length; i++) {
      const [x1, y1] = toCanvas(trackPoints[i - 1].x, trackPoints[i - 1].z);
      const [x2, y2] = toCanvas(trackPoints[i].x, trackPoints[i].z);
      ctx.beginPath();
      ctx.strokeStyle = speedColor(trackPoints[i].speed);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Start/finish marker
    const [sx, sy] = toCanvas(trackPoints[0].x, trackPoints[0].z);
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#10b981";
    ctx.fill();
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Live car position dot
    if (packet && (packet.PositionX !== 0 || packet.PositionZ !== 0)) {
      const [cx, cy] = toCanvas(packet.PositionX, packet.PositionZ);
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#22d3ee";
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ minHeight: 200 }}
    />
  );
}
