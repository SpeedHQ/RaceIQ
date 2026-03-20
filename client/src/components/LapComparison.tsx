import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import type { LapMeta, ComparisonData, TelemetryPacket } from "@shared/types";
import { TrackMap } from "./TrackMap";
import { TelemetryChart } from "./TelemetryChart";
import { TimeDelta } from "./TimeDelta";
import { CornerTable } from "./CornerTable";
import { speedLabel } from "../lib/speed";
import { useTelemetryStore } from "../stores/telemetry";
import { SearchSelect } from "./ui/SearchSelect";

const SYNC_KEY = "lap-compare";
const COLOR_A = "#f97316"; // orange
const COLOR_B = "#3b82f6"; // blue

interface OutlinePoint { x: number; z: number }

/** Find the telemetry index closest to a given distance value */
function findTelemetryAtDistance(telemetry: TelemetryPacket[], distance: number): number {
  const distStart = telemetry[0]?.DistanceTraveled ?? 0;
  let closest = 0;
  let closestDelta = Infinity;
  for (let i = 0; i < telemetry.length; i++) {
    const d = Math.abs((telemetry[i].DistanceTraveled - distStart) - distance);
    if (d < closestDelta) { closestDelta = d; closest = i; }
  }
  return closest;
}

/** Shared drawing logic for track outline + racing lines + position dots */
function drawTrackCanvas(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  outline: OutlinePoint[],
  telemetryA: TelemetryPacket[],
  telemetryB: TelemetryPacket[],
  hoveredDistance: number | null,
  zoom: { centerX: number; centerZ: number; range: number } | null,
) {
  ctx.clearRect(0, 0, w, h);

  // Bounding box of outline
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }

  const trackRangeX = (maxX - minX) || 1;
  const trackRangeZ = (maxZ - minZ) || 1;
  const padding = 24;

  let viewCenterX: number, viewCenterZ: number, viewRangeX: number, viewRangeZ: number;
  if (zoom) {
    viewCenterX = zoom.centerX;
    viewCenterZ = zoom.centerZ;
    viewRangeX = zoom.range;
    viewRangeZ = zoom.range;
  } else {
    viewCenterX = (minX + maxX) / 2;
    viewCenterZ = (minZ + maxZ) / 2;
    viewRangeX = trackRangeX;
    viewRangeZ = trackRangeZ;
  }

  const scaleX = (w - padding * 2) / viewRangeX;
  const scaleZ = (h - padding * 2) / viewRangeZ;
  const sc = Math.min(scaleX, scaleZ);

  const toCanvas = (x: number, z: number): [number, number] => [
    w / 2 + (viewCenterX - x) * sc,
    h / 2 + (z - viewCenterZ) * sc,
  ];

  // Jump detection for outline
  const worldDists: number[] = [];
  for (let i = 1; i < outline.length; i++) {
    const dx = outline[i].x - outline[i - 1].x;
    const dz = outline[i].z - outline[i - 1].z;
    worldDists.push(Math.sqrt(dx * dx + dz * dz));
  }
  const sortedDists = [...worldDists].sort((a, b) => a - b);
  const p90 = sortedDists[Math.floor(sortedDists.length * 0.9)] || 1;
  const jumpThreshold = Math.max(p90 * 3, 50);

  const drawOutlinePath = () => {
    const [sx, sy] = toCanvas(outline[0].x, outline[0].z);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < outline.length; i++) {
      const [px, py] = toCanvas(outline[i].x, outline[i].z);
      if (worldDists[i - 1] > jumpThreshold) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.lineTo(sx, sy);
  };

  // Outline thick
  ctx.beginPath();
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = zoom ? 6 : 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawOutlinePath();
  ctx.stroke();

  // Outline thin
  ctx.beginPath();
  ctx.strokeStyle = "#475569";
  ctx.lineWidth = zoom ? 3 : 2;
  drawOutlinePath();
  ctx.stroke();

  // Start/finish marker
  const [sx, sy] = toCanvas(outline[0].x, outline[0].z);
  ctx.beginPath();
  ctx.arc(sx, sy, zoom ? 5 : 4, 0, Math.PI * 2);
  ctx.fillStyle = "#10b981";
  ctx.fill();
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Racing lines
  const drawRacingLine = (telemetry: TelemetryPacket[], color: string) => {
    if (telemetry.length < 2) return;
    const hasPos = telemetry.some(p => p.PositionX !== 0 || p.PositionZ !== 0);
    if (!hasPos) return;
    ctx.lineWidth = zoom ? 3 : 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.strokeStyle = color;
    let moved = false;
    for (let i = 0; i < telemetry.length; i++) {
      const p = telemetry[i];
      if (p.PositionX === 0 && p.PositionZ === 0) continue;
      const [cx, cy] = toCanvas(p.PositionX, p.PositionZ);
      if (!moved) { ctx.moveTo(cx, cy); moved = true; }
      else ctx.lineTo(cx, cy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  drawRacingLine(telemetryA, COLOR_A);
  drawRacingLine(telemetryB, COLOR_B);

  // Position dots
  if (hoveredDistance != null) {
    const dotSize = zoom ? 7 : 5;
    const glowSize = zoom ? 14 : 10;
    const drawDot = (telemetry: TelemetryPacket[], color: string) => {
      if (telemetry.length < 2) return;
      const idx = findTelemetryAtDistance(telemetry, hoveredDistance);
      const p = telemetry[idx];
      if (!p || (p.PositionX === 0 && p.PositionZ === 0)) return;
      const [cx, cy] = toCanvas(p.PositionX, p.PositionZ);
      ctx.beginPath();
      ctx.arc(cx, cy, glowSize, 0, Math.PI * 2);
      ctx.fillStyle = color + "33";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, dotSize, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Direction line from Yaw (heading)
      if (zoom && p.Yaw !== undefined) {
        const lineLen = 22;
        // Yaw: 0 = +Z, positive = clockwise from above
        // Canvas: X is flipped (viewCenterX - x), Z is normal (z - viewCenterZ)
        const dx = -Math.sin(p.Yaw) * lineLen;
        const dy = Math.cos(p.Yaw) * lineLen;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + dx, cy + dy);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    };
    drawDot(telemetryA, COLOR_A);
    drawDot(telemetryB, COLOR_B);
  }
}

/**
 * Draw combined input HUD for both laps:
 * Layout: [Brake A][Brake B] — [Wheel A / Gear] — [Wheel B / Gear] — [Throttle A][Throttle B]
 */
function drawInputsHUD(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  pA: TelemetryPacket | null,
  pB: TelemetryPacket | null,
) {
  const barW = 14;
  const barH = 80;
  const wheelR = 28;
  const barGap = 4;
  const sectionGap = 16;
  const hudH = barH + 20; // total height with labels
  const y0 = h - hudH - 10;

  // Semi-transparent backdrop
  const totalW = (barW * 2 + barGap) * 2 + (wheelR * 2) * 2 + sectionGap * 4;
  const bx0 = (w - totalW) / 2;
  ctx.fillStyle = "rgba(15, 23, 42, 0.75)";
  ctx.beginPath();
  ctx.roundRect(bx0 - 8, y0 - 14, totalW + 16, hudH + 18, 8);
  ctx.fill();

  let cx = bx0;

  // --- Brake bars (A orange, B blue) ---
  const drawBar = (x: number, frac: number, color: string, borderColor: string) => {
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(x, y0, barW, barH);
    ctx.fillStyle = color;
    ctx.fillRect(x, y0 + barH * (1 - frac), barW, barH * frac);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y0, barW, barH);
  };

  const brakeA = pA ? pA.Brake / 255 : 0;
  const brakeB = pB ? pB.Brake / 255 : 0;
  drawBar(cx, brakeA, "#ef4444", COLOR_A);
  cx += barW + barGap;
  drawBar(cx, brakeB, "#ef4444", COLOR_B);
  cx += barW + sectionGap;

  // Label
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillStyle = "#64748b";
  ctx.textAlign = "center";
  ctx.fillText("Brake", bx0 + barW + barGap / 2, y0 + barH + 14);

  // --- Steering wheel A ---
  const drawWheel = (wcx: number, wcy: number, steer: number, gear: number, color: string) => {
    // Outer ring
    ctx.beginPath();
    ctx.arc(wcx, wcy, wheelR, 0, Math.PI * 2);
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 4;
    ctx.stroke();

    // Colored arc showing steer amount
    const steerAngle = (steer / 127) * Math.PI * 0.75;
    if (Math.abs(steerAngle) > 0.02) {
      ctx.beginPath();
      ctx.arc(wcx, wcy, wheelR, -Math.PI / 2, -Math.PI / 2 + steerAngle, steerAngle < 0);
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    // Indicator line
    const angle = -Math.PI / 2 + steerAngle;
    ctx.beginPath();
    ctx.moveTo(wcx + Math.cos(angle) * 6, wcy + Math.sin(angle) * 6);
    ctx.lineTo(wcx + Math.cos(angle) * (wheelR - 3), wcy + Math.sin(angle) * (wheelR - 3));
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.stroke();

    // Gear number in center
    ctx.font = "bold 20px ui-monospace, monospace";
    ctx.fillStyle = "#e2e8f0";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(gear > 0 ? String(gear) : gear === 0 ? "N" : "R", wcx, wcy);
    ctx.textBaseline = "alphabetic";
  };

  const steerA = pA ? pA.Steer : 0;
  const gearA = pA ? pA.Gear : 0;
  const wheelAcx = cx + wheelR;
  const wheelAcy = y0 + barH / 2 - 6;
  drawWheel(wheelAcx, wheelAcy, steerA, gearA, COLOR_A);
  cx += wheelR * 2 + sectionGap;

  // --- Steering wheel B ---
  const steerB = pB ? pB.Steer : 0;
  const gearB = pB ? pB.Gear : 0;
  const wheelBcx = cx + wheelR;
  const wheelBcy = y0 + barH / 2 - 6;
  drawWheel(wheelBcx, wheelBcy, steerB, gearB, COLOR_B);
  cx += wheelR * 2 + sectionGap;

  // Center label
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillStyle = "#64748b";
  ctx.textAlign = "center";
  ctx.fillText("Steering / Gear", (wheelAcx + wheelBcx) / 2, y0 + barH + 14);

  // --- Throttle bars (A orange, B blue) ---
  const throttleA = pA ? pA.Accel / 255 : 0;
  const throttleB = pB ? pB.Accel / 255 : 0;
  drawBar(cx, throttleA, "#22c55e", COLOR_A);
  cx += barW + barGap;
  drawBar(cx, throttleB, "#22c55e", COLOR_B);

  ctx.font = "10px ui-monospace, monospace";
  ctx.fillStyle = "#64748b";
  ctx.textAlign = "center";
  ctx.fillText("Throttle", cx - barGap / 2, y0 + barH + 14);
}

/** Compute zoom view centered on both car positions */
function computeZoom(
  telemetryA: TelemetryPacket[],
  telemetryB: TelemetryPacket[],
  hoveredDistance: number,
  trackRange: number,
): { centerX: number; centerZ: number; range: number } | null {
  const posA = telemetryA.length >= 2 ? telemetryA[findTelemetryAtDistance(telemetryA, hoveredDistance)] : null;
  const posB = telemetryB.length >= 2 ? telemetryB[findTelemetryAtDistance(telemetryB, hoveredDistance)] : null;
  const validA = posA && (posA.PositionX !== 0 || posA.PositionZ !== 0);
  const validB = posB && (posB.PositionX !== 0 || posB.PositionZ !== 0);

  if (!validA && !validB) return null;

  let cx: number, cz: number;
  if (validA && validB) {
    cx = (posA.PositionX + posB.PositionX) / 2;
    cz = (posA.PositionZ + posB.PositionZ) / 2;
  } else if (validA) {
    cx = posA.PositionX; cz = posA.PositionZ;
  } else {
    cx = posB!.PositionX; cz = posB!.PositionZ;
  }

  const zoomRange = trackRange * 0.02;
  let needed = zoomRange;
  if (validA && validB) {
    const spanX = Math.abs(posA.PositionX - posB.PositionX);
    const spanZ = Math.abs(posA.PositionZ - posB.PositionZ);
    needed = Math.max(zoomRange, spanX * 2.5, spanZ * 2.5);
  }

  return { centerX: cx, centerZ: cz, range: needed };
}

interface SegmentTiming {
  name: string;
  type: "corner" | "straight";
  timeA: number;
  timeB: number;
  startFrac: number;
  endFrac: number;
}

function formatSectionTime(seconds: number): string {
  if (seconds <= 0) return "-";
  return seconds.toFixed(3);
}


/** Dual-panel track map: overview (left) + zoomed follow (right) */
function CompareTrackMap({ outline, telemetryA, telemetryB, labelA, labelB, lapTimeA, lapTimeB, segments, hoveredDistanceRef, redrawRef }: {
  outline: OutlinePoint[];
  telemetryA: TelemetryPacket[];
  telemetryB: TelemetryPacket[];
  labelA: string;
  labelB: string;
  lapTimeA: string;
  lapTimeB: string;
  segments: SegmentTiming[];
  hoveredDistanceRef: React.RefObject<number | null>;
  redrawRef: React.RefObject<(() => void) | null>;
}) {
  const overviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const zoomCanvasRef = useRef<HTMLCanvasElement>(null);
  const overviewContainerRef = useRef<HTMLDivElement>(null);
  const zoomContainerRef = useRef<HTMLDivElement>(null);
  const segmentTableRef = useRef<HTMLTableSectionElement>(null);
  const prevActiveSegRef = useRef<number>(-1);

  const trackRange = useRef(1);

  // Compute track range once
  useEffect(() => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of outline) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    trackRange.current = Math.max((maxX - minX) || 1, (maxZ - minZ) || 1);
  }, [outline]);

  const drawBoth = useCallback(() => {
    const hd = hoveredDistanceRef.current;

    // Draw overview
    const oc = overviewCanvasRef.current;
    const ocont = overviewContainerRef.current;
    if (oc && ocont && outline.length >= 2) {
      const rect = ocont.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      oc.width = rect.width * dpr;
      oc.height = rect.height * dpr;
      oc.style.width = `${rect.width}px`;
      oc.style.height = `${rect.height}px`;
      const ctx = oc.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
        drawTrackCanvas(ctx, rect.width, rect.height, outline, telemetryA, telemetryB, hd, null);
      }
    }

    // Draw zoomed view
    const zc = zoomCanvasRef.current;
    const zcont = zoomContainerRef.current;
    if (zc && zcont && outline.length >= 2) {
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
          ? computeZoom(telemetryA, telemetryB, hd, trackRange.current)
          : null;
        drawTrackCanvas(ctx, rect.width, rect.height, outline, telemetryA, telemetryB, hd, zoom);

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
  }, [outline, telemetryA, telemetryB, hoveredDistanceRef, segments]);

  // Register redraw function so parent can trigger canvas updates without React re-render
  useEffect(() => {
    (redrawRef as React.MutableRefObject<(() => void) | null>).current = drawBoth;
    return () => { (redrawRef as React.MutableRefObject<(() => void) | null>).current = null; };
  }, [drawBoth, redrawRef]);

  useEffect(() => {
    drawBoth();
    const observer = new ResizeObserver(drawBoth);
    if (overviewContainerRef.current) observer.observe(overviewContainerRef.current);
    if (zoomContainerRef.current) observer.observe(zoomContainerRef.current);
    return () => observer.disconnect();
  }, [drawBoth]);

  return (
    <div className="bg-app-surface rounded-lg border border-app-border overflow-hidden">
      <div className="px-3 py-2 border-b border-app-border flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLOR_A }} />
            <span className="text-xs uppercase tracking-wider" style={{ color: COLOR_A }}>{labelA}</span>
            <span className="text-xs font-mono text-app-text-muted ml-1">{lapTimeA}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLOR_B }} />
            <span className="text-xs uppercase tracking-wider" style={{ color: COLOR_B }}>{labelB}</span>
            <span className="text-xs font-mono text-app-text-muted ml-1">{lapTimeB}</span>
          </div>
        </div>
        <span className="text-[10px] text-app-text-dim uppercase tracking-wider">Racing Lines</span>
      </div>
      <div className="grid grid-cols-[minmax(280px,1fr)_1fr_1fr] h-[300px]">
        {/* Segment Times Table */}
        {segments.length > 0 ? (
          <div className="border-r border-app-border overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-app-surface z-10">
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
        ) : (
          <div className="border-r border-app-border w-[200px] flex items-center justify-center text-app-text-dim text-xs">
            No segment data
          </div>
        )}
        {/* Overview — full track, static */}
        <div ref={overviewContainerRef} className="relative border-r border-app-border">
          <span className="absolute top-2 left-2 text-[10px] text-app-text-dim uppercase tracking-wider z-10">Overview</span>
          {outline.length < 2 ? (
            <div className="absolute inset-0 flex items-center justify-center text-app-text-dim text-sm">No track outline</div>
          ) : (
            <canvas ref={overviewCanvasRef} className="absolute inset-0" />
          )}
        </div>
        {/* Zoomed — follows cursor position */}
        <div ref={zoomContainerRef} className="relative">
          <span className="absolute top-2 left-2 text-[10px] text-app-text-dim uppercase tracking-wider z-10">
Zoomed
          </span>
          {outline.length < 2 ? (
            <div className="absolute inset-0 flex items-center justify-center text-app-text-dim text-sm">No track outline</div>
          ) : (
            <canvas ref={zoomCanvasRef} className="absolute inset-0" />
          )}
        </div>
      </div>
    </div>
  );
}

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

interface TrackGroup {
  trackOrdinal: number;
  trackName: string;
  laps: LapMeta[];
}

export function LapComparison() {
  const search = useSearch({ from: "/compare" });
  const navigate = useNavigate({ from: "/compare" });
  const { displaySettings } = useTelemetryStore();
  const [laps, setLaps] = useState<LapMeta[]>([]);
  const [trackGroups, setTrackGroups] = useState<TrackGroup[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(search.track ?? null);
  const [carAOrd, setCarAOrd] = useState<number | null>(search.carA ?? null);
  const [carBOrd, setCarBOrd] = useState<number | null>(search.carB ?? null);
  const [lapAId, setLapAId] = useState<number | null>(search.lapA ?? null);
  const [lapBId, setLapBId] = useState<number | null>(search.lapB ?? null);
  const [comparison, setComparison] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [carNames, setCarNames] = useState<Map<number, string>>(new Map());
  const [trackOutline, setTrackOutline] = useState<OutlinePoint[] | null>(null);
  const [trackSegments, setTrackSegments] = useState<{ type: string; name: string; startFrac: number; endFrac: number }[] | null>(null);
  const prevTrackRef = useRef<number | null | undefined>(undefined);
  const prevCarARef = useRef<number | null | undefined>(undefined);
  const prevCarBRef = useRef<number | null | undefined>(undefined);
  const hoveredDistanceRef = useRef<number | null>(null);
  const mapRedrawRef = useRef<(() => void) | null>(null);
  const handleCursorMove = useCallback((d: number | null) => {
    hoveredDistanceRef.current = d;
    // Directly redraw the map canvas without React re-render
    mapRedrawRef.current?.();
  }, []);

  // Sync selections to URL
  useEffect(() => {
    navigate({
      search: {
        track: selectedTrack ?? undefined,
        carA: carAOrd ?? undefined,
        carB: carBOrd ?? undefined,
        lapA: lapAId ?? undefined,
        lapB: lapBId ?? undefined,
      },
      replace: true,
      resetScroll: false,
    });
  }, [selectedTrack, carAOrd, carBOrd, lapAId, lapBId, navigate]);

  // Fetch lap list and group by track
  useEffect(() => {
    async function fetchLaps() {
      try {
        const res = await fetch("/api/laps");
        if (!res.ok) return;
        const data: LapMeta[] = await res.json();
        const validLaps = data.filter((l) => l.lapTime > 0 && l.trackOrdinal);
        setLaps(validLaps);

        // Group by track
        const byTrack = new Map<number, LapMeta[]>();
        for (const lap of validLaps) {
          const t = lap.trackOrdinal!;
          if (!byTrack.has(t)) byTrack.set(t, []);
          byTrack.get(t)!.push(lap);
        }

        // Fetch track names
        const groups: TrackGroup[] = [];
        for (const [ordinal, trackLaps] of byTrack) {
          let name = `Track ${ordinal}`;
          try {
            const r = await fetch(`/api/track-name/${ordinal}`);
            if (r.ok) name = await r.text();
          } catch {}
          groups.push({ trackOrdinal: ordinal, trackName: name, laps: trackLaps });
        }
        groups.sort((a, b) => a.trackName.localeCompare(b.trackName));
        setTrackGroups(groups);

        // Fetch car names for unique car ordinals
        const carOrds = new Set(validLaps.map((l) => l.carOrdinal).filter((c): c is number => c != null));
        const names = new Map<number, string>();
        await Promise.all(
          Array.from(carOrds).map(async (ord) => {
            try {
              const r = await fetch(`/api/car-name/${ord}`);
              if (r.ok) names.set(ord, await r.text());
            } catch {}
          })
        );
        setCarNames(names);
      } catch {}
    }
    fetchLaps();
  }, []);

  // Reset car/lap selections when track changes (skip initial mount to preserve URL params)
  useEffect(() => {
    if (prevTrackRef.current === undefined) {
      prevTrackRef.current = selectedTrack;
    } else if (prevTrackRef.current !== selectedTrack) {
      prevTrackRef.current = selectedTrack;
      setCarAOrd(null);
      setCarBOrd(null);
      setLapAId(null);
      setLapBId(null);
      setComparison(null);
    }
    setTrackOutline(null);
    setTrackSegments(null);

    // Fetch track outline + segments
    if (selectedTrack != null) {
      fetch(`/api/track-outline/${selectedTrack}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.points && Array.isArray(data.points)) {
            setTrackOutline(data.points);
          } else if (Array.isArray(data)) {
            setTrackOutline(data);
          }
        })
        .catch(() => setTrackOutline(null));
      fetch(`/api/track-sectors/${selectedTrack}`)
        .then((r) => r.ok ? r.json() : null)
        .then((s) => { if (s?.segments) setTrackSegments(s.segments); else setTrackSegments(null); })
        .catch(() => setTrackSegments(null));
    }
  }, [selectedTrack]);

  // Reset lap A when car A changes, default car B to same
  useEffect(() => {
    if (prevCarARef.current === undefined) {
      prevCarARef.current = carAOrd;
    } else if (prevCarARef.current !== carAOrd) {
      prevCarARef.current = carAOrd;
      setLapAId(null);
      setComparison(null);
      if (carAOrd != null && carBOrd == null) {
        setCarBOrd(carAOrd);
      }
    }
  }, [carAOrd]);

  // Reset lap B when car B changes
  useEffect(() => {
    if (prevCarBRef.current === undefined) {
      prevCarBRef.current = carBOrd;
    } else if (prevCarBRef.current !== carBOrd) {
      prevCarBRef.current = carBOrd;
      setLapBId(null);
      setComparison(null);
    }
  }, [carBOrd]);

  // Laps filtered to selected track
  const trackLaps = selectedTrack != null
    ? (trackGroups.find((g) => g.trackOrdinal === selectedTrack)?.laps ?? [])
    : [];

  // Unique cars on this track
  const trackCars = Array.from(new Set(trackLaps.map((l) => l.carOrdinal).filter((c): c is number => c != null)));

  // Laps filtered by car
  const carALaps = trackLaps.filter((l) => l.carOrdinal === carAOrd);
  const carBLaps = trackLaps.filter((l) => l.carOrdinal === carBOrd);

  // Fetch comparison when both laps selected
  const fetchComparison = useCallback(async () => {
    if (!lapAId || !lapBId || lapAId === lapBId) {
      setComparison(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/laps/${lapAId}/compare/${lapBId}`);
      if (!res.ok) {
        setError(`Failed to load comparison: ${res.statusText}`);
        setComparison(null);
        return;
      }
      const data: ComparisonData = await res.json();
      setComparison(data);
    } catch (e) {
      setError("Failed to load comparison data");
      setComparison(null);
    } finally {
      setLoading(false);
    }
  }, [lapAId, lapBId]);

  useEffect(() => {
    fetchComparison();
  }, [fetchComparison]);

  // Compute per-segment times for both laps
  const segmentTimings = useMemo((): SegmentTiming[] => {
    if (!trackSegments || trackSegments.length === 0 || !comparison) return [];
    const telA = comparison.telemetryA;
    const telB = comparison.telemetryB;
    if (telA.length < 10 || telB.length < 10) return [];

    let sNum = 1;
    return trackSegments.map((seg) => {
      const displayName = (seg.type === "straight" && (!seg.name || /^S[\d?]*$/.test(seg.name)))
        ? `S${sNum++}`
        : (seg.type === "straight" ? (sNum++, seg.name) : seg.name);

      const computeTime = (tel: TelemetryPacket[]) => {
        const n = tel.length;
        const startIdx = Math.round(seg.startFrac * (n - 1));
        const endIdx = Math.min(Math.round(seg.endFrac * (n - 1)), n - 1);
        const startTime = tel[startIdx]?.CurrentLap ?? 0;
        const endTime = tel[endIdx]?.CurrentLap ?? 0;
        return Math.round((endTime - startTime) * 1000) / 1000;
      };

      return {
        name: displayName,
        type: seg.type as "corner" | "straight",
        timeA: computeTime(telA),
        timeB: computeTime(telB),
        startFrac: seg.startFrac,
        endFrac: seg.endFrac,
      };
    });
  }, [trackSegments, comparison]);

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      {/* Selectors: Track → Car A → Lap A → Car B → Lap B */}
      <div className="flex items-start gap-4 flex-wrap">
        {/* Track selector */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-app-text-muted uppercase tracking-wider">Track</label>
          <SearchSelect
            value={selectedTrack != null ? String(selectedTrack) : ""}
            onChange={(v) => setSelectedTrack(v ? Number(v) : null)}
            options={trackGroups.map((g) => ({ value: String(g.trackOrdinal), label: `${g.trackName} (${g.laps.length} laps)` }))}
            placeholder="Search tracks..."
            className="min-w-[200px]"
          />
        </div>

        {/* Car A */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-orange-500" />
            <label className="text-[10px] text-app-text-muted uppercase tracking-wider">Car A</label>
          </div>
          <SearchSelect
            value={carAOrd != null ? String(carAOrd) : ""}
            onChange={(v) => setCarAOrd(v ? Number(v) : null)}
            options={trackCars.map((ord) => ({ value: String(ord), label: carNames.get(ord) || `Car ${ord}` }))}
            placeholder="Search cars..."
            disabled={!selectedTrack}
            className="min-w-[200px]"
            focusColor="orange-500"
          />
        </div>

        {/* Lap A */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-app-text-muted uppercase tracking-wider">Lap A</label>
          <SearchSelect
            value={lapAId != null ? String(lapAId) : ""}
            onChange={(v) => setLapAId(v ? Number(v) : null)}
            options={carALaps.map((lap) => ({ value: String(lap.id), label: `Lap ${lap.lapNumber} — ${formatLapTime(lap.lapTime)}${!lap.isValid ? " (inv)" : ""}` }))}
            placeholder="Search laps..."
            disabled={!carAOrd}
            className="min-w-[180px]"
            focusColor="orange-500"
          />
        </div>

        {/* Car B */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
            <label className="text-[10px] text-app-text-muted uppercase tracking-wider">Car B</label>
          </div>
          <SearchSelect
            value={carBOrd != null ? String(carBOrd) : ""}
            onChange={(v) => setCarBOrd(v ? Number(v) : null)}
            options={trackCars.map((ord) => ({ value: String(ord), label: carNames.get(ord) || `Car ${ord}` }))}
            placeholder="Search cars..."
            disabled={!selectedTrack}
            className="min-w-[200px]"
            focusColor="blue-500"
          />
        </div>

        {/* Lap B */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-app-text-muted uppercase tracking-wider">Lap B</label>
          <SearchSelect
            value={lapBId != null ? String(lapBId) : ""}
            onChange={(v) => setLapBId(v ? Number(v) : null)}
            options={carBLaps.map((lap) => ({ value: String(lap.id), label: `Lap ${lap.lapNumber} — ${formatLapTime(lap.lapTime)}${!lap.isValid ? " (inv)" : ""}` }))}
            placeholder="Search laps..."
            disabled={!carBOrd}
            className="min-w-[180px]"
            focusColor="blue-500"
          />
        </div>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="text-app-text-muted text-sm">Loading comparison data...</div>
      )}
      {error && (
        <div className="text-red-400 text-sm">{error}</div>
      )}

      {/* No selection prompt */}
      {!lapAId || !lapBId ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">
          Select two laps above to compare
        </div>
      ) : lapAId === lapBId ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">
          Select two different laps to compare
        </div>
      ) : comparison?.traces?.distance ? (
        <div className="flex flex-col gap-4">
          {/* Track Map — both racing lines overlaid on outline */}
          {trackOutline && trackOutline.length >= 2 ? (
            <CompareTrackMap
              outline={trackOutline}
              telemetryA={comparison.telemetryA}
              telemetryB={comparison.telemetryB}
              labelA={`${carNames.get(comparison.lapA.carOrdinal!) || "Car A"} — Lap ${comparison.lapA.lapNumber}`}
              labelB={`${carNames.get(comparison.lapB.carOrdinal!) || "Car B"} — Lap ${comparison.lapB.lapNumber}`}
              lapTimeA={formatLapTime(comparison.lapA.lapTime)}
              lapTimeB={formatLapTime(comparison.lapB.lapTime)}
              segments={segmentTimings}
              hoveredDistanceRef={hoveredDistanceRef}
              redrawRef={mapRedrawRef}
            />
          ) : (
            /* Fallback: velocity-integrated racing lines side-by-side */
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-app-surface rounded-lg border border-app-border overflow-hidden">
                <div className="px-3 py-2 border-b border-app-border flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wider" style={{ color: COLOR_A }}>
                    {carNames.get(comparison.lapA.carOrdinal!) || "Car A"} — Lap {comparison.lapA.lapNumber}
                  </span>
                  <span className="text-xs font-mono text-app-text-secondary">{formatLapTime(comparison.lapA.lapTime)}</span>
                </div>
                <div className="h-[250px]">
                  <TrackMap telemetry={comparison.telemetryA} lineColor={COLOR_A} />
                </div>
              </div>
              <div className="bg-app-surface rounded-lg border border-app-border overflow-hidden">
                <div className="px-3 py-2 border-b border-app-border flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wider" style={{ color: COLOR_B }}>
                    {carNames.get(comparison.lapB.carOrdinal!) || "Car B"} — Lap {comparison.lapB.lapNumber}
                  </span>
                  <span className="text-xs font-mono text-app-text-secondary">{formatLapTime(comparison.lapB.lapTime)}</span>
                </div>
                <div className="h-[250px]">
                  <TrackMap telemetry={comparison.telemetryB} lineColor={COLOR_B} />
                </div>
              </div>
            </div>
          )}

          {/* Time Delta */}
          <div className="bg-app-surface rounded-lg border border-app-border p-3">
            <TimeDelta
              distances={comparison.traces.distance}
              timeDelta={comparison.timeDelta}
              syncKey={SYNC_KEY}
              height={140}
              onCursorMove={handleCursorMove}
            />
          </div>

          {/* Speed Chart */}
          <div className="bg-app-surface rounded-lg border border-app-border p-3">
            <TelemetryChart
              data={{
                distance: comparison.traces.distance,
                values: [comparison.traces.speedA, comparison.traces.speedB],
                labels: [`Speed A (${speedLabel(displaySettings.speedUnit)})`, `Speed B (${speedLabel(displaySettings.speedUnit)})`],
                colors: [COLOR_A, COLOR_B],
              }}
              syncKey={SYNC_KEY}
              height={200}
              title="Speed"
              onCursorMove={handleCursorMove}
            />
          </div>

          {/* Throttle + Brake Chart */}
          <div className="bg-app-surface rounded-lg border border-app-border p-3">
            <TelemetryChart
              data={{
                distance: comparison.traces.distance,
                values: [
                  comparison.traces.throttleA,
                  comparison.traces.throttleB,
                  comparison.traces.brakeA,
                  comparison.traces.brakeB,
                ],
                labels: ["Throttle A", "Throttle B", "Brake A", "Brake B"],
                colors: [COLOR_A, COLOR_B, "#f97316aa", "#3b82f6aa"],
              }}
              syncKey={SYNC_KEY}
              height={180}
              title="Throttle & Brake"
              onCursorMove={handleCursorMove}
            />
          </div>

          {/* RPM Chart */}
          <div className="bg-app-surface rounded-lg border border-app-border p-3">
            <TelemetryChart
              data={{
                distance: comparison.traces.distance,
                values: [comparison.traces.rpmA, comparison.traces.rpmB],
                labels: ["RPM A", "RPM B"],
                colors: [COLOR_A, COLOR_B],
              }}
              syncKey={SYNC_KEY}
              height={180}
              title="RPM"
              onCursorMove={handleCursorMove}
            />
          </div>

          {/* Tire Wear Chart */}
          {comparison.traces.tireWearA && (
            <div className="bg-app-surface rounded-lg border border-app-border p-3">
              <TelemetryChart
                data={{
                  distance: comparison.traces.distance,
                  values: [comparison.traces.tireWearA, comparison.traces.tireWearB],
                  labels: ["Tire Wear A (%)", "Tire Wear B (%)"],
                  colors: [COLOR_A, COLOR_B],
                }}
                syncKey={SYNC_KEY}
                height={160}
                title="Tire Wear (avg all 4)"
                onCursorMove={handleCursorMove}
              />
            </div>
          )}

          {/* Corner Table */}
          {comparison.corners.length > 0 && (
            <div className="bg-app-surface rounded-lg border border-app-border overflow-hidden">
              <div className="px-3 py-2 border-b border-app-border">
                <span className="text-xs text-app-text-muted uppercase tracking-wider">
                  Corner-by-Corner Delta
                </span>
              </div>
              <CornerTable corners={comparison.corners} />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
