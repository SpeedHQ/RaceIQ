import { useRef, useEffect, useCallback, useState } from "react";
import type { TelemetryPacket } from "@shared/types";
import { client } from "../lib/rpc";
import { useGameId } from "../stores/game";

interface Point {
  x: number;
  z: number;
}

interface BoundaryData {
  leftEdge: Point[];
  rightEdge: Point[];
  centerLine: Point[];
  pitLane: Point[] | null;
  coordSystem: string;
}

interface Props {
  telemetry: TelemetryPacket[];
  colorBy?: "speed" | "throttle" | "brake";
  highlightDistance?: number;
  lineColor?: string; // optional override color (for overlay mode)
  className?: string;
  trackOrdinal?: number; // when provided, fetches and draws track boundaries
}

function getSpeedMph(p: TelemetryPacket): number {
  return Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2) * 2.23694;
}

function speedToColor(speed: number, minSpeed: number, maxSpeed: number): string {
  const t = maxSpeed > minSpeed ? (speed - minSpeed) / (maxSpeed - minSpeed) : 0;
  // blue (slow) -> cyan -> green -> yellow -> red (fast)
  const r = Math.round(t < 0.5 ? 0 : (t - 0.5) * 2 * 255);
  const g = Math.round(t < 0.5 ? t * 2 * 255 : (1 - t) * 2 * 255);
  const b = Math.round(t < 0.5 ? (1 - t * 2) * 255 : 0);
  return `rgb(${r},${g},${b})`;
}

function channelToColor(value: number, min: number, max: number): string {
  return speedToColor(value, min, max);
}

/**
 * Check if telemetry has valid Forza world positions (not all zeros).
 */
function hasWorldPositions(telemetry: TelemetryPacket[]): boolean {
  // Check a sample of packets for non-zero positions
  for (let i = 0; i < Math.min(telemetry.length, 20); i++) {
    const idx = Math.floor(i * telemetry.length / 20);
    if (telemetry[idx].PositionX !== 0 || telemetry[idx].PositionZ !== 0) return true;
  }
  return false;
}

/**
 * Integrate positions from velocity when world positions aren't available.
 */
function integratePositions(packets: TelemetryPacket[]): { x: number[]; z: number[] } {
  const x: number[] = [0];
  const z: number[] = [0];
  for (let i = 1; i < packets.length; i++) {
    const dt = (packets[i].TimestampMS - packets[i - 1].TimestampMS) / 1000;
    if (dt <= 0 || dt > 1) {
      x.push(x[x.length - 1]);
      z.push(z[z.length - 1]);
      continue;
    }
    x.push(x[x.length - 1] + packets[i].VelocityX * dt);
    z.push(z[z.length - 1] + packets[i].VelocityZ * dt);
  }
  return { x, z };
}

export function TrackMap({ telemetry, colorBy = "speed", highlightDistance, lineColor, className, trackOrdinal }: Props) {
  const gameId = useGameId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [boundaries, setBoundaries] = useState<BoundaryData | null>(null);

  // Fetch boundaries when trackOrdinal is provided
  useEffect(() => {
    if (!trackOrdinal) { setBoundaries(null); return; }
    if (!gameId) return;
    client.api["track-boundaries"][":ordinal"].$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gameId ?? undefined } })
      .then((r) => r.json() as unknown as BoundaryData)
      .then((data) => setBoundaries(data))
      .catch(() => setBoundaries(null));
  }, [trackOrdinal, gameId]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || telemetry.length < 2) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    // Use Forza world positions when available, otherwise integrate from velocity
    const useWorld = hasWorldPositions(telemetry);
    let x: number[], z: number[];
    if (useWorld) {
      x = telemetry.map(p => p.PositionX);
      z = telemetry.map(p => p.PositionZ);
    } else {
      const integrated = integratePositions(telemetry);
      x = integrated.x;
      z = integrated.z;
    }

    // Compute bounds — include boundary edges if in same coord system
    const hasBounds = boundaries && (boundaries.coordSystem === "forza" || boundaries.coordSystem === "f1-2025" || boundaries.coordSystem === "acc") && useWorld;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    const allPointSets: { x: number; z: number }[][] = [
      x.map((xi, i) => ({ x: xi, z: z[i] })),
    ];
    if (hasBounds) {
      allPointSets.push(boundaries!.leftEdge, boundaries!.rightEdge);
    }
    for (const pts of allPointSets) {
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
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

    // All games normalized to same coord convention server-side.
    // X is flipped for display so right in-game = right on screen.
    const toScreenX = useWorld
      ? (px: number) => offsetX + (maxX - px) * scale
      : (px: number) => (px - minX) * scale + offsetX;
    const toScreenZ = (pz: number) => (pz - minZ) * scale + offsetZ;

    // Draw boundary surface
    if (hasBounds) {
      const left = boundaries!.leftEdge;
      const right = boundaries!.rightEdge;

      // Filled track surface
      ctx.beginPath();
      ctx.moveTo(toScreenX(left[0].x), toScreenZ(left[0].z));
      for (let i = 1; i < left.length; i++) {
        ctx.lineTo(toScreenX(left[i].x), toScreenZ(left[i].z));
      }
      for (let i = right.length - 1; i >= 0; i--) {
        ctx.lineTo(toScreenX(right[i].x), toScreenZ(right[i].z));
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(51, 65, 85, 0.25)";
      ctx.fill();

      // Edge lines
      ctx.strokeStyle = "rgba(100, 116, 139, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(toScreenX(left[0].x), toScreenZ(left[0].z));
      for (let i = 1; i < left.length; i++) ctx.lineTo(toScreenX(left[i].x), toScreenZ(left[i].z));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(toScreenX(right[0].x), toScreenZ(right[0].z));
      for (let i = 1; i < right.length; i++) ctx.lineTo(toScreenX(right[i].x), toScreenZ(right[i].z));
      ctx.stroke();

      // Center-line (faint)
      if (boundaries!.centerLine?.length > 2) {
        ctx.beginPath();
        ctx.strokeStyle = "rgba(148, 163, 184, 0.3)";
        ctx.lineWidth = 1;
        ctx.moveTo(toScreenX(boundaries!.centerLine[0].x), toScreenZ(boundaries!.centerLine[0].z));
        for (let i = 1; i < boundaries!.centerLine.length; i++) {
          ctx.lineTo(toScreenX(boundaries!.centerLine[i].x), toScreenZ(boundaries!.centerLine[i].z));
        }
        ctx.lineTo(toScreenX(boundaries!.centerLine[0].x), toScreenZ(boundaries!.centerLine[0].z));
        ctx.stroke();
      }
    }

    // Get color channel values
    let values: number[] = [];
    if (!lineColor) {
      if (colorBy === "speed") {
        values = telemetry.map(getSpeedMph);
      } else if (colorBy === "throttle") {
        values = telemetry.map((p) => (p.Accel / 255) * 100);
      } else {
        values = telemetry.map((p) => (p.Brake / 255) * 100);
      }
    }

    const minVal = values.length ? Math.min(...values) : 0;
    const maxVal = values.length ? Math.max(...values) : 1;

    // Draw lap trace
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let i = 1; i < x.length; i++) {
      ctx.beginPath();
      ctx.moveTo(toScreenX(x[i - 1]), toScreenZ(z[i - 1]));
      ctx.lineTo(toScreenX(x[i]), toScreenZ(z[i]));
      ctx.strokeStyle = lineColor || channelToColor(values[i], minVal, maxVal);
      ctx.stroke();
    }

    // Draw highlight dot
    if (highlightDistance !== undefined && telemetry.length > 0) {
      const distStart = telemetry[0].DistanceTraveled;
      let closestIdx = 0;
      let closestDist = Infinity;
      for (let i = 0; i < telemetry.length; i++) {
        const d = Math.abs((telemetry[i].DistanceTraveled - distStart) - highlightDistance);
        if (d < closestDist) {
          closestDist = d;
          closestIdx = i;
        }
      }
      ctx.beginPath();
      ctx.arc(toScreenX(x[closestIdx]), toScreenZ(z[closestIdx]), 6, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Start/finish indicator
    if (x.length > 0) {
      ctx.beginPath();
      ctx.arc(toScreenX(x[0]), toScreenZ(z[0]), 4, 0, Math.PI * 2);
      ctx.fillStyle = "#22c55e";
      ctx.fill();
    }
  }, [telemetry, colorBy, highlightDistance, lineColor, boundaries]);

  useEffect(() => {
    draw();
    const observer = new ResizeObserver(draw);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [draw]);

  return (
    <div ref={containerRef} className={`relative w-full h-full min-h-[200px] ${className ?? ""}`}>
      {telemetry.length < 2 ? (
        <div className="absolute inset-0 flex items-center justify-center text-app-text-dim text-sm">
          No position data
        </div>
      ) : (
        <canvas ref={canvasRef} className="absolute inset-0" />
      )}
    </div>
  );
}
