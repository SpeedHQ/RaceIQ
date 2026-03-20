import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import type { TelemetryPacket, LapMeta } from "@shared/types";
import { CAR_CLASS_NAMES, DRIVETRAIN_NAMES } from "@shared/types";
import { formatLapTime, TireDiagram, GForceCircle } from "./LiveTelemetry";
import { SteeringWheel } from "./SteeringWheel";
import { getSteeringLock } from "./Settings";
import { Compass } from "./Compass";
import { BodyAttitude } from "./BodyAttitude";
import {
  allWheelStates,
  allFrictionCircle,
  steerBalance,
  corneringEfficiency,
  slipRatioColor,
  frictionUtilColor,
  balanceColor,
} from "../lib/vehicle-dynamics";
import { convertSpeed, speedLabel } from "../lib/speed";
import { useSettings, useLaps as useLapsQuery } from "../hooks/queries";
import { api } from "../lib/api";
import { analyzeLap } from "../lib/lap-insights";
import { InsightPanel } from "./InsightPanel";
import { AiAnalysisModal } from "./AiAnalysisModal";
import { Sparkles } from "lucide-react";
import { SearchSelect } from "./ui/SearchSelect";

interface Point {
  x: number;
  z: number;
}

// ── Track Map (analyse version) ──────────────────────────────────────

function AnalyseTrackMap({
  telemetry,
  cursorIdx,
  outline,
  sectors,
  segments,
  rotateWithCar,
  zoom = 1,
}: {
  telemetry: TelemetryPacket[];
  cursorIdx: number;
  outline: Point[] | null;
  sectors: { s1End: number; s2End: number } | null;
  segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  rotateWithCar: boolean;
  zoom?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
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

    // In Analyse, always use telemetry positions for the track line so the car dot aligns perfectly.
    // The outline is only used for the start/finish marker.
    const telemetryPoints = telemetry
      .filter((p) => p.PositionX !== 0 || p.PositionZ !== 0)
      .map((p) => ({ x: p.PositionX, z: p.PositionZ }));
    const displayOutline: Point[] = telemetryPoints.length > 2 ? telemetryPoints : (outline ?? []);

    if (displayOutline.length < 2) return;

    // Bounds
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const p of displayOutline) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const rangeX = (maxX - minX) || 1;
    const rangeZ = (maxZ - minZ) || 1;
    const padding = rotateWithCar ? 60 : 24;
    const baseScale = Math.min(
      (w - padding * 2) / rangeX,
      (h - padding * 2) / rangeZ
    );
    const scale = baseScale * zoom;
    const offsetX = (w - rangeX * scale) / 2;
    const offsetZ = (h - rangeZ * scale) / 2;

    function toCanvas(x: number, z: number): [number, number] {
      return [offsetX + (maxX - x) * scale, offsetZ + (z - minZ) * scale];
    }

    // Rotate map so car always points up when toggled, anchored to screen center
    if (rotateWithCar) {
      const pkt = telemetry[cursorIdx];
      if (pkt && (pkt.PositionX !== 0 || pkt.PositionZ !== 0)) {
        const [carCx, carCy] = toCanvas(pkt.PositionX, pkt.PositionZ);
        // Move car to screen center, rotate around it
        ctx.translate(w / 2, h / 2);
        ctx.rotate(Math.PI - pkt.Yaw);
        ctx.translate(-carCx, -carCy);
      }
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

    // Thinner line — colored by segments (corners vs straights) if available
    if (segments && segments.length > 0) {
      const n = displayOutline.length;

      // Auto-number unnamed straights for display
      let sNum = 1;
      const segDisplayNames = segments.map((s) => {
        if (s.type === "straight" && (!s.name || /^S[\d?]*$/.test(s.name))) return `S${sNum++}`;
        if (s.type === "straight") sNum++;
        return s.name;
      });

      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        const startIdx = Math.round(seg.startFrac * (n - 1));
        const endIdx = Math.round(seg.endFrac * (n - 1));
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

        // Label at midpoint
        const displayName = segDisplayNames[si];
        const midIdx = Math.round((startIdx + endIdx) / 2);
        const midPt = displayOutline[Math.min(midIdx, n - 1)];
        if (midPt && displayName) {
          const [lx, ly] = toCanvas(midPt.x, midPt.z);
          ctx.font = "bold 7px monospace";
          ctx.fillStyle = seg.type === "corner" ? "#fbbf24" : "#60a5fa";
          ctx.textAlign = "center";
          ctx.fillText(displayName, lx, ly - 6);
        }
      }
    } else {
      // Fallback: solid thin line
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

    // Sector boundary markers on the telemetry line
    if (sectors && displayOutline.length > 10) {
      const sectorColors = ["#ef4444", "#3b82f6", "#eab308"];
      const sectorFracs = [sectors.s1End, sectors.s2End];

      for (let si = 0; si < sectorFracs.length; si++) {
        const idx = Math.round(sectorFracs[si] * (displayOutline.length - 1));
        const pt = displayOutline[Math.min(idx, displayOutline.length - 1)];
        if (!pt) continue;
        const [mx, my] = toCanvas(pt.x, pt.z);

        // Perpendicular tick
        const prevIdx = Math.max(0, idx - 3);
        const nextIdx = Math.min(displayOutline.length - 1, idx + 3);
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

    // Car position dot at cursor
    const pkt = telemetry[cursorIdx];
    if (pkt && (pkt.PositionX !== 0 || pkt.PositionZ !== 0)) {
      const [cx, cy] = toCanvas(pkt.PositionX, pkt.PositionZ);
      // Glow
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(34, 211, 238, 0.25)";
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
  }, [telemetry, cursorIdx, outline, sectors, segments, rotateWithCar, zoom]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ minHeight: 220 }}
    />
  );
}

// ── Telemetry Chart (canvas) ─────────────────────────────────────────

interface ChartSeries {
  data: number[];
  color: string;
  label: string;
}

function TelemetryChart({
  series,
  cursorIdx,
  totalPackets,
  onClickIndex,
  onScrubStart,
  height = 100,
}: {
  series: ChartSeries[];
  cursorIdx: number;
  totalPackets: number;
  onClickIndex: (idx: number) => void;
  onScrubStart?: () => void;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = container.clientWidth;
    const h = height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (totalPackets < 2) return;

    const leftPad = 40;
    const rightPad = 8;
    const topPad = 16;
    const botPad = 4;
    const chartW = w - leftPad - rightPad;
    const chartH = h - topPad - botPad;

    // Compute global min/max across all series
    let gMin = Infinity,
      gMax = -Infinity;
    for (const s of series) {
      for (const v of s.data) {
        if (v < gMin) gMin = v;
        if (v > gMax) gMax = v;
      }
    }
    const pad = (gMax - gMin) * 0.05 || 1;
    gMin -= pad;
    gMax += pad;
    const range = gMax - gMin;

    // Y axis ticks (3)
    ctx.font = "9px monospace";
    ctx.fillStyle = "#475569";
    ctx.textAlign = "right";
    for (let i = 0; i <= 2; i++) {
      const val = gMin + (range * i) / 2;
      const y = topPad + chartH - (i / 2) * chartH;
      ctx.fillText(val.toFixed(0), leftPad - 4, y + 3);
      ctx.strokeStyle = "rgba(100,116,139,0.08)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(w - rightPad, y);
      ctx.stroke();
    }

    // Draw each series
    for (const s of series) {
      ctx.beginPath();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.2;
      const n = s.data.length;
      for (let i = 0; i < n; i++) {
        const x = leftPad + (i / (n - 1)) * chartW;
        const y = topPad + chartH - ((s.data[i] - gMin) / range) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Cursor line
    const cx = leftPad + (cursorIdx / (totalPackets - 1)) * chartW;
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, topPad);
    ctx.lineTo(cx, topPad + chartH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Labels
    ctx.font = "bold 9px system-ui";
    ctx.textAlign = "left";
    let ly = 10;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillText(s.label, leftPad + 4, ly);
      ly += 11;
    }
  }, [series, cursorIdx, totalPackets, height]);

  const idxFromEvent = useCallback(
    (clientX: number): number | null => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container || totalPackets < 2) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const w = container.clientWidth;
      const leftPad = 40;
      const rightPad = 8;
      const chartW = w - leftPad - rightPad;
      const frac = (x - leftPad) / chartW;
      const idx = Math.round(frac * (totalPackets - 1));
      return idx >= 0 && idx < totalPackets ? idx : null;
    },
    [totalPackets]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      onScrubStart?.();
      const idx = idxFromEvent(e.clientX);
      if (idx !== null) onClickIndex(idx);

      const handleMouseMove = (ev: MouseEvent) => {
        const i = idxFromEvent(ev.clientX);
        if (i !== null) onClickIndex(i);
      };
      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [idxFromEvent, onClickIndex, onScrubStart]
  );

  return (
    <div ref={containerRef} className="w-full">
      <canvas
        ref={canvasRef}
        className="w-full cursor-crosshair rounded bg-app-surface/40"
        style={{ height }}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}

// ── Metrics Panel ────────────────────────────────────────────────────

function MetricsPanel({ pkt, startFuel }: { pkt: TelemetryPacket; startFuel?: number }) {
  const { displaySettings } = useSettings();
  const speed = convertSpeed(pkt.Speed, displaySettings.speedUnit);
  const throttlePct = ((pkt.Accel / 255) * 100).toFixed(0);
  const brakePct = ((pkt.Brake / 255) * 100).toFixed(0);
  const lock = getSteeringLock();
  const steerDeg = (pkt.Steer / 127) * (lock / 2);

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
      <MetricRow label="Speed" value={`${speed.toFixed(0)} ${speedLabel(displaySettings.speedUnit)}`} />
      <MetricRow label="RPM" value={`${pkt.CurrentEngineRpm.toFixed(0)}`} />
      <MetricRow label="Gear" value={`${pkt.Gear}`} />
      <MetricRow label="Throttle" value={`${throttlePct}%`} color={Number(throttlePct) > 50 ? "#34d399" : undefined} />
      <MetricRow label="Brake" value={`${brakePct}%`} color={Number(brakePct) > 10 ? "#ef4444" : undefined} />
      <MetricRow label="Steer" value={`${steerDeg > 0 ? "+" : ""}${steerDeg.toFixed(0)}°`} />
      <MetricRow label="Boost" value={`${pkt.Boost.toFixed(1)} psi`} />
      <MetricRow label="Power" value={`${(pkt.Power / 745.7).toFixed(0)} hp`} />
      <MetricRow label="Torque" value={`${pkt.Torque.toFixed(0)} Nm`} />
      <div className="col-span-2 flex justify-between">
        <span className="text-app-text-muted">Fuel</span>
        <span className="tabular-nums">
          <span className="text-amber-400">{startFuel != null ? ((startFuel - pkt.Fuel) * 100).toFixed(1) : "?"}</span>
          <span className="text-app-text-dim"> used </span>
          <span className="text-app-text">{(pkt.Fuel * 100).toFixed(1)}%</span>
          <span className="text-app-text-dim"> left</span>
        </span>
      </div>
    </div>
  );
}

function MetricRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-app-text-muted">{label}</span>
      <span className={color ? "" : "text-app-text"} style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}

function WearValue({ label, value }: { label: string; value: number }) {
  const pct = (value * 100).toFixed(1);
  const color = value > 0.7 ? "#34d399" : value > 0.4 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{pct}%</span></span>
  );
}

function SlipValue({ label, value }: { label: string; value: number }) {
  const color = Math.abs(value) < 0.5 ? "#34d399" : Math.abs(value) < 1.5 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{value.toFixed(2)}</span></span>
  );
}

function SlipAngleValue({ label, value, speedMph }: { label: string; value: number; speedMph?: number }) {
  const deg = value * (180 / Math.PI);
  const a = Math.abs(deg);
  // Scale thresholds by speed — high slip angles are normal at low speed
  const speedFactor = speedMph != null ? Math.max(0.3, Math.min(1, speedMph / 80)) : 1;
  const t1 = 4 / speedFactor;  // green->yellow: 4° at 80mph, ~13° at 25mph
  const t2 = 8 / speedFactor;  // yellow->orange
  const t3 = 14 / speedFactor; // orange->red
  const color = a < t1 ? "#34d399" : a < t2 ? "#fbbf24" : a < t3 ? "#fb923c" : "#ef4444";
  return (
    <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{deg.toFixed(1)}°</span></span>
  );
}

function WheelRow({ label, unit, fl, fr, rl, rr, fmt, colorFn }: {
  label: string; unit: string; fl: number; fr: number; rl: number; rr: number;
  fmt: (v: number) => string; colorFn?: (v: number) => string;
}) {
  const cell = (v: number) => (
    <td className="text-right px-1 py-0.5" style={colorFn ? { color: colorFn(v) } : undefined}>
      {fmt(v)}{unit}
    </td>
  );
  return (
    <tr className="border-t border-app-border/50">
      <td className="text-app-text-muted text-[10px] pr-2 py-0.5">{label}</td>
      {cell(fl)}{cell(fr)}{cell(rl)}{cell(rr)}
    </tr>
  );
}

function WheelSpeedValue({ label, value }: { label: string; value: number }) {
  const abs = Math.abs(value);
  const color = abs < 10 ? "#94a3b8" : abs < 50 ? "#34d399" : abs < 100 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{value.toFixed(1)}</span></span>
  );
}

function SuspValue({ label, value }: { label: string; value: number }) {
  const pct = (value * 100).toFixed(0);
  const color = value < 0.6 ? "#22d3ee" : value < 0.85 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-app-text-secondary">{label}: <span className="tabular-nums" style={{ color }}>{pct}%</span></span>
  );
}

// ── Main Component ───────────────────────────────────────────────────

export function LapAnalyse() {
  const search = useSearch({ from: "/analyse" });
  const navigate = useNavigate({ from: "/analyse" });
  const { displaySettings } = useSettings();

  const [laps, setLaps] = useState<LapMeta[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(search.track ?? null);
  const [selectedCar, setSelectedCar] = useState<number | null>(search.car ?? null);
  const [selectedLapId, setSelectedLapId] = useState<number | null>(search.lap ?? null);
  const [telemetry, setTelemetry] = useState<TelemetryPacket[]>([]);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [sectors, setSectors] = useState<{ s1End: number; s2End: number } | null>(null);
  const [segments, setSegments] = useState<{ type: string; name: string; startFrac: number; endFrac: number }[] | null>(null);
  const [carName, setCarName] = useState("");
  const [trackName, setTrackName] = useState("");
  const [cursorIdx, setCursorIdx] = useState(0);
  const [sidebarTab, setSidebarTab] = useState<"live" | "insights">("live");
  const [playing, setPlaying] = useState(false);
  const [rotateWithCar, setRotateWithCar] = useState(false);
  const [mapZoom, setMapZoom] = useState(1);
  const [loading, setLoading] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const playRef = useRef(false);
  const speedRef = useRef(1);
  const cursorRef = useRef(0);
  const seekRef = useRef(0);

  // Name caches for track/car ordinals
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});
  const [carNames, setCarNames] = useState<Record<number, string>>({});

  // Fetch lap list
  const { data: allLaps = [] } = useLapsQuery();
  useEffect(() => {
    const valid = allLaps.filter((l) => l.lapTime > 0);
    if (valid.length !== laps.length || valid.some((l, i) => l.id !== laps[i]?.id)) {
      setLaps(valid);
    }
  }, [allLaps]);

  // Derive unique tracks from laps
  const tracks = useMemo(() => {
    const seen = new Map<number, number>(); // trackOrdinal -> lap count
    for (const l of laps) {
      if (l.trackOrdinal != null) seen.set(l.trackOrdinal, (seen.get(l.trackOrdinal) ?? 0) + 1);
    }
    return Array.from(seen.entries())
      .sort((a, b) => (trackNames[a[0]] ?? `Track ${a[0]}`).localeCompare(trackNames[b[0]] ?? `Track ${b[0]}`));
  }, [laps, trackNames]);

  // Derive unique cars for the selected track
  const carsForTrack = useMemo(() => {
    if (selectedTrack == null) return [];
    const seen = new Map<number, number>();
    for (const l of laps) {
      if (l.trackOrdinal === selectedTrack && l.carOrdinal != null) {
        seen.set(l.carOrdinal, (seen.get(l.carOrdinal) ?? 0) + 1);
      }
    }
    return Array.from(seen.entries())
      .sort((a, b) => (carNames[a[0]] ?? `Car ${a[0]}`).localeCompare(carNames[b[0]] ?? `Car ${b[0]}`));
  }, [laps, selectedTrack, carNames]);

  // Derive laps for the selected track + car
  const filteredLaps = useMemo(() => {
    if (selectedTrack == null || selectedCar == null) return [];
    return laps.filter((l) => l.trackOrdinal === selectedTrack && l.carOrdinal === selectedCar);
  }, [laps, selectedTrack, selectedCar]);

  // Fetch names for URL-param values immediately (before laps load)
  useEffect(() => {
    if (selectedTrack != null) {
      api.getTrackName(selectedTrack)
        .then((name) => { if (name) setTrackNames((prev) => ({ ...prev, [selectedTrack]: name })); })
        .catch(() => {});
    }
    if (selectedCar != null) {
      api.getCarName(selectedCar)
        .then((name) => { if (name) setCarNames((prev) => ({ ...prev, [selectedCar]: name })); })
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch track/car names for display
  useEffect(() => {
    const trackOrdinals = new Set<number>();
    const carOrdinals = new Set<number>();
    for (const l of laps) {
      if (l.trackOrdinal != null) trackOrdinals.add(l.trackOrdinal);
      if (l.carOrdinal != null) carOrdinals.add(l.carOrdinal);
    }
    for (const ord of trackOrdinals) {
      if (!trackNames[ord]) {
        api.getTrackName(ord)
          .then((name) => { if (name) setTrackNames((prev) => ({ ...prev, [ord]: name })); })
          .catch(() => {});
      }
    }
    for (const ord of carOrdinals) {
      if (!carNames[ord]) {
        api.getCarName(ord)
          .then((name) => { if (name) setCarNames((prev) => ({ ...prev, [ord]: name })); })
          .catch(() => {});
      }
    }
  }, [laps]);

  // Sync selections to URL
  useEffect(() => {
    navigate({
      search: {
        track: selectedTrack ?? undefined,
        car: selectedCar ?? undefined,
        lap: selectedLapId ?? undefined,
      },
      replace: true,
    });
  }, [selectedTrack, selectedCar, selectedLapId, navigate]);

  // Reset downstream selections when track changes
  const handleTrackChange = useCallback((trackOrd: number | null) => {
    setSelectedTrack(trackOrd);
    setSelectedCar(null);
    setSelectedLapId(null);
  }, []);

  // Reset lap selection when car changes
  const handleCarChange = useCallback((carOrd: number | null) => {
    setSelectedCar(carOrd);
    setSelectedLapId(null);
  }, []);

  // Fetch telemetry when lap selected
  useEffect(() => {
    if (selectedLapId == null) return;
    setLoading(true);
    setPlaying(false);
    playRef.current = false;

    // Set car/track name from caches
    setCarName(selectedCar != null ? (carNames[selectedCar] ?? "") : "");
    setTrackName(selectedTrack != null ? (trackNames[selectedTrack] ?? "") : "");

    api.getLap(selectedLapId)
      .then((data: any) => {
        if (data && Array.isArray(data.telemetry)) {
          setTelemetry(data.telemetry);
          setCursorIdx(0);
          cursorRef.current = 0;

          const trackOrd = selectedTrack ?? data.meta?.trackOrdinal ?? data.telemetry[0]?.TrackOrdinal;
          if (trackOrd != null) {
            api.getTrackOutline(trackOrd)
              .then((d: any) => {
                if (d?.points && Array.isArray(d.points)) setOutline(d.points);
                else if (Array.isArray(d)) setOutline(d);
                else setOutline(null);
              })
              .catch(() => setOutline(null));
            api.getTrackSectorBoundaries(trackOrd)
              .then((s: any) => { if (s?.s1End) setSectors(s); else setSectors(null); })
              .catch(() => setSectors(null));
            api.getTrackSectors(trackOrd)
              .then((s: any) => { if (s?.segments) setSegments(s.segments); else setSegments(null); })
              .catch(() => setSegments(null));
          } else {
            setOutline(null);
            setSectors(null);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedLapId]);

  // Keep speedRef in sync and signal the animation to re-anchor timing
  const speedChangeRef = useRef(0);
  useEffect(() => {
    speedRef.current = playbackSpeed;
    speedChangeRef.current++;
  }, [playbackSpeed]);

  // Play/pause animation — uses CurrentLap timer for accurate real-time playback
  useEffect(() => {
    playRef.current = playing;
    if (!playing || telemetry.length < 2) return;

    let rafId: number;
    // Track wall-clock time elapsed since playback started at current index
    let wallStart = performance.now();
    let gameStart = telemetry[cursorRef.current].CurrentLap;
    let lastSpeedChange = speedChangeRef.current;
    let lastSeek = seekRef.current;

    function step(now: number) {
      if (!playRef.current) return;
      const idx = cursorRef.current;
      if (idx >= telemetry.length - 1) {
        setPlaying(false);
        playRef.current = false;
        return;
      }

      // Re-anchor timing when user seeks or speed changes mid-playback
      if (seekRef.current !== lastSeek) {
        lastSeek = seekRef.current;
        wallStart = now;
        gameStart = telemetry[idx].CurrentLap;
      }
      if (speedChangeRef.current !== lastSpeedChange) {
        lastSpeedChange = speedChangeRef.current;
        wallStart = now;
        gameStart = telemetry[idx].CurrentLap;
      }

      // How much game-time should have elapsed based on wall-clock and speed
      const wallElapsed = (now - wallStart) / 1000; // seconds
      const gameTarget = gameStart + wallElapsed * speedRef.current;

      // Advance cursor to the packet matching the target game time
      let nextIdx = idx;
      while (nextIdx < telemetry.length - 1 && telemetry[nextIdx + 1].CurrentLap <= gameTarget) {
        nextIdx++;
      }

      if (nextIdx !== idx) {
        cursorRef.current = nextIdx;
        setCursorIdx(nextIdx);
      }

      rafId = requestAnimationFrame(step);
    }
    rafId = requestAnimationFrame(step);

    return () => cancelAnimationFrame(rafId);
  }, [playing, telemetry]);

  // Keyboard controls
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (telemetry.length === 0) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCursorIdx((prev) => {
          const next = Math.max(0, prev - 1);
          cursorRef.current = next;
          return next;
        });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setCursorIdx((prev) => {
          const next = Math.min(telemetry.length - 1, prev + 1);
          cursorRef.current = next;
          return next;
        });
      } else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [telemetry]);

  // Pre-compute chart data
  const chartData = useMemo(() => {
    if (telemetry.length === 0) return null;
    const speed: number[] = [];
    const throttle: number[] = [];
    const brake: number[] = [];
    const rpm: number[] = [];
    const steering: number[] = [];

    for (const p of telemetry) {
      speed.push(convertSpeed(p.Speed, displaySettings.speedUnit));
      throttle.push((p.Accel / 255) * 100);
      brake.push((p.Brake / 255) * 100);
      rpm.push(p.CurrentEngineRpm);
      steering.push(p.Steer);
    }
    return { speed, throttle, brake, rpm, steering };
  }, [telemetry]);

  // Compute sector times from telemetry distance + sector boundaries
  const sectorTimes = useMemo(() => {
    if (!sectors || telemetry.length < 10) return null;

    const firstDist = telemetry[0].DistanceTraveled;
    const lastDist = telemetry[telemetry.length - 1].DistanceTraveled;
    const lapDist = lastDist - firstDist;
    if (lapDist <= 0) return null;

    let s1Time = 0;
    let s2Time = 0;
    let s3Time = 0;
    let s1Idx = -1;
    let s2Idx = -1;

    // Find sector boundary packet indices
    for (let i = 0; i < telemetry.length; i++) {
      const frac = (telemetry[i].DistanceTraveled - firstDist) / lapDist;
      if (s1Idx < 0 && frac >= sectors.s1End) {
        s1Idx = i;
        s1Time = telemetry[i].CurrentLap - telemetry[0].CurrentLap;
      }
      if (s2Idx < 0 && frac >= sectors.s2End) {
        s2Idx = i;
        s2Time = telemetry[i].CurrentLap - (s1Idx >= 0 ? telemetry[s1Idx].CurrentLap : telemetry[0].CurrentLap);
      }
    }

    const lapMeta = laps.find((l) => l.id === selectedLapId);
    const totalLapTime = lapMeta?.lapTime ?? (telemetry[telemetry.length - 1].CurrentLap - telemetry[0].CurrentLap);
    s3Time = totalLapTime - s1Time - s2Time;
    if (s3Time < 0) s3Time = 0;

    // Determine which sector the cursor is in
    const cursorFrac = telemetry.length > 1
      ? (telemetry[cursorIdx]?.DistanceTraveled - firstDist) / lapDist
      : 0;
    const cursorSector = cursorFrac < sectors.s1End ? 0 : cursorFrac < sectors.s2End ? 1 : 2;

    return {
      times: [s1Time, s2Time, s3Time] as [number, number, number],
      s1Idx,
      s2Idx,
      cursorSector,
    };
  }, [telemetry, sectors, cursorIdx, selectedLapId, laps]);

  // Compute per-segment (turn/straight) times from telemetry
  const segmentTimes = useMemo(() => {
    if (!segments || segments.length === 0 || telemetry.length < 10) return null;

    const n = telemetry.length;

    // Segment fracs are based on outline point-index (time-sampled), so use
    // telemetry packet-index fraction to match (both are ~60Hz time-sampled).
    const cursorFrac = cursorIdx / (n - 1);

    // Auto-number unnamed straights for display
    let sNum = 1;
    const displayNames = segments.map((s) => {
      if (s.type === "straight" && (!s.name || /^S[\d?]*$/.test(s.name))) return `S${sNum++}`;
      if (s.type === "straight") sNum++;
      return s.name;
    });

    const result: { name: string; type: string; time: number; active: boolean }[] = [];

    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      // Map fractions to packet indices
      const startIdx = Math.round(seg.startFrac * (n - 1));
      const endIdx = Math.min(Math.round(seg.endFrac * (n - 1)), n - 1);

      const startTime = telemetry[startIdx]?.CurrentLap ?? 0;
      const endTime = telemetry[endIdx]?.CurrentLap ?? 0;

      const active = cursorFrac >= seg.startFrac && cursorFrac < seg.endFrac;
      const completed = cursorFrac >= seg.endFrac;
      result.push({
        name: displayNames[si],
        type: seg.type,
        time: endTime - startTime,
        active,
        completed,
      });
    }

    return result;
  }, [segments, telemetry, cursorIdx]);

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const idx = Number(e.target.value);
      setCursorIdx(idx);
      cursorRef.current = idx;
      seekRef.current++;
    },
    []
  );

  const handleChartClick = useCallback((idx: number) => {
    setCursorIdx(idx);
    cursorRef.current = idx;
    seekRef.current++;
  }, []);

  const handleScrubStart = useCallback(() => {
    setPlaying(false);
    playRef.current = false;
  }, []);

  const currentPacket = telemetry[cursorIdx] ?? null;
  const lapInsights = useMemo(() => analyzeLap(telemetry), [telemetry]);

  // Time display
  const currentTime = currentPacket ? currentPacket.CurrentLap : 0;
  const selectedLap = laps.find((l) => l.id === selectedLapId);
  const totalTime = selectedLap?.lapTime ?? 0;

  // Export handler
  const handleExport = useCallback(() => {
    if (telemetry.length === 0) return;
    const header = [
      `# Car: ${carName || `Ordinal ${telemetry[0].CarOrdinal}`}`,
      `# Track: ${trackName || `Ordinal ${telemetry[0].TrackOrdinal}`}`,
      `# Lap: ${selectedLap?.lapNumber ?? "?"} | Time: ${selectedLap ? formatLapTime(selectedLap.lapTime) : "?"}`,
    ].join("\n");
    const csv = [
      header,
      Object.keys(telemetry[0]).join(","),
      ...telemetry.map((p) => Object.values(p).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lap-${selectedLapId}-telemetry.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [telemetry, selectedLapId, selectedLap, carName, trackName]);

  const handleCopyMetrics = useCallback(() => {
    if (!currentPacket) return;
    const p = currentPacket;
    const lock = getSteeringLock();
    const steerDeg = (p.Steer / 127) * (lock / 2);
    const startFuel = telemetry[0]?.Fuel ?? 0;
    const lines = [
      `Packet ${cursorIdx + 1}/${telemetry.length} | ${formatLapTime(p.CurrentLap)} / ${formatLapTime(totalTime)}`,
      `Track: ${trackName} | Car: ${carName} | Lap: ${selectedLap?.lapNumber ?? "?"}`,
      ``,
      `Speed: ${convertSpeed(p.Speed, displaySettings.speedUnit).toFixed(0)} ${speedLabel(displaySettings.speedUnit)}`,
      `RPM: ${p.CurrentEngineRpm.toFixed(0)} / ${p.EngineMaxRpm.toFixed(0)}`,
      `Gear: ${p.Gear}`,
      `Throttle: ${((p.Accel / 255) * 100).toFixed(0)}%`,
      `Brake: ${((p.Brake / 255) * 100).toFixed(0)}%`,
      `Steer: ${steerDeg > 0 ? "+" : ""}${steerDeg.toFixed(0)}°`,
      `Boost: ${p.Boost.toFixed(1)} psi`,
      `Power: ${(p.Power / 745.7).toFixed(0)} hp`,
      `Torque: ${p.Torque.toFixed(0)} Nm`,
      `Fuel: ${(p.Fuel * 100).toFixed(1)}% left, ${((startFuel - p.Fuel) * 100).toFixed(1)}% used`,
      ``,
      `Wheel Speed (rad/s): FL=${p.WheelRotationSpeedFL.toFixed(1)} FR=${p.WheelRotationSpeedFR.toFixed(1)} RL=${p.WheelRotationSpeedRL.toFixed(1)} RR=${p.WheelRotationSpeedRR.toFixed(1)}`,
      `Tire Temp: FL=${p.TireTempFL.toFixed(0)}° FR=${p.TireTempFR.toFixed(0)}° RL=${p.TireTempRL.toFixed(0)}° RR=${p.TireTempRR.toFixed(0)}°`,
      `Tire Wear: FL=${(p.TireWearFL*100).toFixed(1)}% FR=${(p.TireWearFR*100).toFixed(1)}% RL=${(p.TireWearRL*100).toFixed(1)}% RR=${(p.TireWearRR*100).toFixed(1)}%`,
      `Slip Combined: FL=${p.TireCombinedSlipFL.toFixed(2)} FR=${p.TireCombinedSlipFR.toFixed(2)} RL=${p.TireCombinedSlipRL.toFixed(2)} RR=${p.TireCombinedSlipRR.toFixed(2)}`,
      `Slip Angle: FL=${(p.TireSlipAngleFL*180/Math.PI).toFixed(1)}° FR=${(p.TireSlipAngleFR*180/Math.PI).toFixed(1)}° RL=${(p.TireSlipAngleRL*180/Math.PI).toFixed(1)}° RR=${(p.TireSlipAngleRR*180/Math.PI).toFixed(1)}°`,
      `Suspension: FL=${(p.NormSuspensionTravelFL*100).toFixed(0)}% FR=${(p.NormSuspensionTravelFR*100).toFixed(0)}% RL=${(p.NormSuspensionTravelRL*100).toFixed(0)}% RR=${(p.NormSuspensionTravelRR*100).toFixed(0)}%`,
    ];
    navigator.clipboard.writeText(lines.join("\n"));
  }, [currentPacket, cursorIdx, telemetry, totalTime, trackName, carName, selectedLap]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header: cascading selectors + export */}
      <div className="flex items-center gap-2 p-3 border-b border-app-border flex-wrap shrink-0">
        {/* Track selector */}
        <SearchSelect
          value={selectedTrack != null ? String(selectedTrack) : ""}
          onChange={(v) => handleTrackChange(v ? Number(v) : null)}
          options={tracks.map(([ord, count]) => ({ value: String(ord), label: `${trackNames[ord] || `Track ${ord}`} (${count})` }))}
          placeholder="Search tracks..."
          className="min-w-[200px]"
          fallbackLabel={selectedTrack != null ? (trackNames[selectedTrack] || `Track ${selectedTrack}`) : undefined}
        />

        {/* Car selector */}
        <SearchSelect
          value={selectedCar != null ? String(selectedCar) : ""}
          onChange={(v) => handleCarChange(v ? Number(v) : null)}
          options={carsForTrack.map(([ord, count]) => ({ value: String(ord), label: `${carNames[ord] || `Car ${ord}`} (${count})` }))}
          placeholder="Search cars..."
          disabled={selectedTrack == null}
          className="min-w-[200px]"
          fallbackLabel={selectedCar != null ? (carNames[selectedCar] || `Car ${selectedCar}`) : undefined}
        />

        {/* Lap selector */}
        <SearchSelect
          value={selectedLapId != null ? String(selectedLapId) : ""}
          onChange={(v) => setSelectedLapId(v ? Number(v) : null)}
          options={filteredLaps.map((lap) => ({ value: String(lap.id), label: `Lap ${lap.lapNumber} - ${formatLapTime(lap.lapTime)}` }))}
          placeholder="Search laps..."
          disabled={selectedCar == null}
          className="min-w-[200px]"
          fallbackLabel={selectedLapId != null ? `Lap ${selectedLapId}` : undefined}
        />

        <div className="ml-auto flex items-center gap-2">
          {telemetry.length > 0 && (
            <button
              onClick={handleCopyMetrics}
              className="text-xs text-app-text-secondary hover:text-app-text border border-app-border-input rounded px-3 py-1.5 transition-colors"
            >
              Copy
            </button>
          )}
          {telemetry.length > 0 && (
            <button
              onClick={handleExport}
              className="text-xs text-app-text-secondary hover:text-app-text border border-app-border-input rounded px-3 py-1.5 transition-colors"
            >
              Export CSV
            </button>
          )}
          {telemetry.length > 0 && (
            <button
              onClick={() => setAiModalOpen(true)}
              className="flex items-center gap-1.5 text-xs text-app-text-secondary hover:text-amber-400 border border-app-border-input rounded px-3 py-1.5 transition-colors"
            >
              <Sparkles className="size-3" />
              AI Analysis
            </button>
          )}
          {loading && (
            <span className="text-xs text-app-text-muted animate-pulse">
              Loading...
            </span>
          )}
        </div>
      </div>

      {telemetry.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">
          {selectedLapId ? "No telemetry data for this lap." : "Select a track, car, and lap to analyse."}
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Left: main content (map, charts, scrubber) */}
          <div className="flex-1 min-w-0 h-full overflow-y-auto">
          {/* Top section: Track Map + Metrics */}
          <div className="grid grid-cols-1 lg:grid-cols-[180px_1fr_320px] border-b border-app-border shrink-0">
            {/* Segment table + legend */}
            <div className="border-r border-app-border overflow-y-auto p-2" style={{ height: 420 }}>
              {/* Legend */}
              <div className="flex items-center gap-3 mb-2 pb-2 border-b border-app-border">
                <div className="flex items-center gap-1">
                  <div className="w-3 h-1.5 rounded-sm bg-amber-500" />
                  <span className="text-[9px] text-app-text-muted">Corner</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-1.5 rounded-sm bg-blue-500" />
                  <span className="text-[9px] text-app-text-muted">Straight</span>
                </div>
              </div>
              {/* Segment list */}
              {segmentTimes ? (
                <div className="space-y-0.5">
                  {segmentTimes.map((seg, i) => (
                    <div
                      key={i}
                      className={`flex items-center justify-between px-1.5 py-1 rounded text-[11px] font-mono ${
                        seg.active ? "bg-app-surface-alt ring-1 ring-inset ring-app-text-dim" : ""
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <div
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: seg.type === "corner" ? "#f59e0b" : "#3b82f6" }}
                        />
                        <span className={seg.active ? "text-app-text" : "text-app-text-secondary"}>{seg.name}</span>
                      </div>
                      <span className={seg.active ? "text-app-text" : "text-app-text-muted"}>
                        {seg.completed && seg.time > 0 ? seg.time.toFixed(3) + "s" : seg.active ? "..." : "-"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-app-text-dim">No segment data</div>
              )}
            </div>

            {/* Track map */}
            <div className="border-r border-app-border bg-app-bg p-2 relative" style={{ height: 420 }}>
              <AnalyseTrackMap
                telemetry={telemetry}
                cursorIdx={cursorIdx}
                outline={outline}
                sectors={sectors}
                segments={segments}
                rotateWithCar={rotateWithCar}
                zoom={mapZoom}
              />
              {/* Map controls overlay — top right */}
              <div className="absolute top-2 right-2 flex items-start gap-2">
                {/* Zoom controls */}
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => setMapZoom((z) => Math.min(z + 0.25, 4))}
                    className="w-6 h-6 text-xs bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
                  >+</button>
                  <button
                    onClick={() => setMapZoom((z) => Math.max(z - 0.25, 0.5))}
                    className="w-6 h-6 text-xs bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
                  >-</button>
                </div>
                {/* View toggle */}
                <button
                  onClick={() => setRotateWithCar((r) => !r)}
                  className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                    rotateWithCar
                      ? "bg-cyan-900/50 border-cyan-700 text-app-accent"
                      : "bg-app-surface-alt/80 border-app-border-input text-app-text-secondary hover:text-app-text"
                  }`}
                  title="Rotate map to follow car direction"
                >
                  {rotateWithCar ? "Car View" : "Fixed View"}
                </button>
                {/* Compass */}
                {currentPacket && <Compass yaw={currentPacket.Yaw} />}
              </div>
              {currentPacket && (
                <div className="absolute bottom-2 right-2 bg-app-bg/80 rounded p-1">
                  <BodyAttitude packet={currentPacket} />
                </div>
              )}
            </div>

            {/* Rev meter + Steering wheel + Tire diagram */}
            <div className="border-r border-app-border p-2 flex flex-col items-center justify-center gap-2">
              {currentPacket && (
                <div className="flex items-center justify-center gap-2">
                  <span className="text-lg font-mono font-bold text-app-accent">{currentPacket.Gear === 0 ? "R" : currentPacket.Gear === 11 ? "N" : currentPacket.Gear}</span>
                  <span className="text-xl font-mono font-bold tabular-nums text-app-text">{convertSpeed(currentPacket.Speed, displaySettings.speedUnit).toFixed(0)} <span className="text-[10px] text-app-text-muted">{speedLabel(displaySettings.speedUnit)}</span></span>
                </div>
              )}
              {currentPacket && (
                <div className="flex items-center gap-2">
                  {/* Pedal bars */}
                  <div className="flex gap-1 items-end shrink-0" style={{ height: 80 }}>
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[9px] font-mono text-emerald-400 font-bold tabular-nums">{((currentPacket.Accel / 255) * 100).toFixed(0)}</span>
                      <div className="w-5 bg-app-surface-alt rounded-sm overflow-hidden relative" style={{ height: 60 }}>
                        <div className="absolute bottom-0 w-full bg-emerald-400 rounded-sm transition-all" style={{ height: `${(currentPacket.Accel / 255) * 100}%` }} />
                      </div>
                      <span className="text-[8px] text-app-text-muted">T</span>
                    </div>
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[9px] font-mono text-red-400 font-bold tabular-nums">{((currentPacket.Brake / 255) * 100).toFixed(0)}</span>
                      <div className="w-5 bg-app-surface-alt rounded-sm overflow-hidden relative" style={{ height: 60 }}>
                        <div className="absolute bottom-0 w-full bg-red-500 rounded-sm transition-all" style={{ height: `${(currentPacket.Brake / 255) * 100}%` }} />
                      </div>
                      <span className="text-[8px] text-app-text-muted">B</span>
                    </div>
                  </div>
                  <SteeringWheel steer={currentPacket.Steer} rpm={currentPacket.CurrentEngineRpm} maxRpm={currentPacket.EngineMaxRpm} />
                  <GForceCircle packet={currentPacket} />
                </div>
              )}
              {currentPacket && <TireDiagram packet={currentPacket} />}
            </div>

          </div>

          {/* Lap time + Timeline scrubber */}
          <div className="px-3 py-2 border-b border-app-border bg-app-surface/50 shrink-0">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-[10px] text-app-text-muted">Lap {selectedLap?.lapNumber ?? "?"}</span>
              <span className="text-2xl font-mono font-bold tabular-nums text-app-accent">{formatLapTime(currentTime)}</span>
              <span className="text-sm font-mono tabular-nums text-app-text-secondary">/ {formatLapTime(totalTime)}</span>
              {sectorTimes && (["S1", "S2", "S3"] as const).map((name, i) => {
                const colors = ["#ef4444", "#3b82f6", "#eab308"];
                const isActive = sectorTimes.cursorSector === i;
                return (
                  <div
                    key={name}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded ${
                      isActive ? "bg-app-surface-alt ring-1" : "bg-app-surface-alt/30"
                    }`}
                    style={isActive ? { boxShadow: `inset 0 0 0 1px ${colors[i]}40` } : {}}
                  >
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: colors[i] }} />
                    <span className="text-[10px] font-semibold text-app-text-muted">{name}</span>
                    <span className={`text-xs font-mono font-bold tabular-nums ${isActive ? "text-app-text" : "text-app-text-secondary"}`}>
                      {formatLapTime(sectorTimes.times[i])}
                    </span>
                  </div>
                );
              })}
              <span className="text-[10px] font-mono text-app-text-dim ml-auto">
                Packet {cursorIdx + 1}/{telemetry.length}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setPlaying((p) => !p)}
                className="text-lg w-8 h-8 flex items-center justify-center rounded bg-app-surface-alt hover:bg-app-border-input text-app-text transition-colors"
                title={playing ? "Pause (Space)" : "Play (Space)"}
              >
                {playing ? "\u275A\u275A" : "\u25B6"}
              </button>
              <div className="flex gap-1">
                {[0.25, 0.5, 1, 1.5, 2, 2.5].map((s) => (
                  <button
                    key={s}
                    onClick={() => setPlaybackSpeed(s)}
                    className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                      playbackSpeed === s
                        ? "bg-cyan-600 text-white"
                        : "bg-app-surface-alt text-app-text-secondary hover:bg-app-border-input hover:text-app-text"
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
              <input
                type="range"
                min={0}
                max={telemetry.length - 1}
                value={cursorIdx}
                onChange={handleSliderChange}
                className="flex-1 h-2 bg-app-border-input rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
            </div>
          </div>

          {/* Stacked charts */}
          {chartData && (
            <div className="p-3 space-y-2">
              <TelemetryChart
                series={[
                  { data: chartData.speed, color: "#22d3ee", label: `Speed (${speedLabel(displaySettings.speedUnit)})` },
                ]}
                cursorIdx={cursorIdx}
                totalPackets={telemetry.length}
                onClickIndex={handleChartClick}
                onScrubStart={handleScrubStart}
                height={100}
              />
              <TelemetryChart
                series={[
                  { data: chartData.throttle, color: "#34d399", label: "Throttle %" },
                  { data: chartData.brake, color: "#ef4444", label: "Brake %" },
                ]}
                cursorIdx={cursorIdx}
                totalPackets={telemetry.length}
                onClickIndex={handleChartClick}
                onScrubStart={handleScrubStart}
                height={100}
              />
              <TelemetryChart
                series={[
                  { data: chartData.rpm, color: "#a855f7", label: "RPM" },
                ]}
                cursorIdx={cursorIdx}
                totalPackets={telemetry.length}
                onClickIndex={handleChartClick}
                onScrubStart={handleScrubStart}
                height={100}
              />
              <TelemetryChart
                series={[
                  { data: chartData.steering, color: "#fbbf24", label: "Steering" },
                ]}
                cursorIdx={cursorIdx}
                totalPackets={telemetry.length}
                onClickIndex={handleChartClick}
                onScrubStart={handleScrubStart}
                height={80}
              />
            </div>
          )}
          </div>

          {/* Right panel – full height */}
          <div className="w-80 shrink-0 border-l border-app-border bg-app-surface/50 flex flex-col overflow-hidden">
              {/* Tab switcher */}
              <div className="flex border-b border-app-border shrink-0">
                <button
                  onClick={() => setSidebarTab("live")}
                  className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
                    sidebarTab === "live"
                      ? "text-app-text border-b-2 border-app-accent"
                      : "text-app-text-muted hover:text-app-text"
                  }`}
                >
                  Live
                </button>
                <button
                  onClick={() => setSidebarTab("insights")}
                  className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
                    sidebarTab === "insights"
                      ? "text-app-text border-b-2 border-app-accent"
                      : "text-app-text-muted hover:text-app-text"
                  }`}
                >
                  Insights
                  {lapInsights.length > 0 && (
                    <span className="ml-1 text-[9px] bg-app-border-input text-app-text rounded-full px-1.5">
                      {lapInsights.length}
                    </span>
                  )}
                </button>
              </div>

              <div className="p-3 flex-1 overflow-y-auto">
              {sidebarTab === "live" ? (
                <>
                <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2 font-semibold">
                  Metrics at Cursor
                </h3>
              {currentPacket && <MetricsPanel pkt={currentPacket} startFuel={telemetry[0]?.Fuel} />}

              {currentPacket && (
                <>
                  <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2 mt-3 pt-2 border-t border-app-border font-semibold">
                    Dynamics
                  </h3>
                  {(() => {
                    const ws = allWheelStates(currentPacket);
                    const fc = allFrictionCircle(currentPacket);
                    const bal = steerBalance(currentPacket);
                    const latG = Math.abs(currentPacket.AccelerationX) / 9.81;
                    const lonG = currentPacket.AccelerationZ / 9.81;
                    return (
                      <div className="text-[11px] font-mono space-y-1.5 mb-3">
                        {/* Balance */}
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Balance</span>
                          <span className="tabular-nums" style={{ color: balanceColor(bal.state) }}>
                            {bal.state === "neutral" ? "Neutral" : bal.state === "understeer" ? "Understeer" : "Oversteer"}
                            <span className="text-app-text-dim ml-1">({bal.deltaDeg > 0 ? "+" : ""}{bal.deltaDeg.toFixed(1)}°)</span>
                          </span>
                        </div>
                        {/* G-Force */}
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Lat G</span>
                          <span className="tabular-nums" style={{ color: latG > 1.5 ? "#ef4444" : latG > 0.8 ? "#fbbf24" : "#34d399" }}>
                            {latG.toFixed(2)}g
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Lon G</span>
                          <span className="tabular-nums" style={{ color: lonG < -0.5 ? "#ef4444" : lonG > 0.3 ? "#34d399" : "#94a3b8" }}>
                            {lonG > 0 ? "+" : ""}{lonG.toFixed(2)}g
                          </span>
                        </div>
                        {/* Friction circle utilization */}
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Grip Used</span>
                          <span className="tabular-nums">
                            <span style={{ color: frictionUtilColor(fc.fl) }}>FL {(fc.fl * 100).toFixed(0)}</span>
                            <span className="text-app-text-dim"> </span>
                            <span style={{ color: frictionUtilColor(fc.fr) }}>FR {(fc.fr * 100).toFixed(0)}</span>
                            <span className="text-app-text-dim"> </span>
                            <span style={{ color: frictionUtilColor(fc.rl) }}>RL {(fc.rl * 100).toFixed(0)}</span>
                            <span className="text-app-text-dim"> </span>
                            <span style={{ color: frictionUtilColor(fc.rr) }}>RR {(fc.rr * 100).toFixed(0)}%</span>
                          </span>
                        </div>
                        {/* Slip ratios */}
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Slip Ratio</span>
                          <span className="tabular-nums">
                            <span style={{ color: slipRatioColor(ws.fl.slipRatio) }}>FL {(ws.fl.slipRatio * 100).toFixed(0)}</span>
                            <span className="text-app-text-dim"> </span>
                            <span style={{ color: slipRatioColor(ws.fr.slipRatio) }}>FR {(ws.fr.slipRatio * 100).toFixed(0)}</span>
                            <span className="text-app-text-dim"> </span>
                            <span style={{ color: slipRatioColor(ws.rl.slipRatio) }}>RL {(ws.rl.slipRatio * 100).toFixed(0)}</span>
                            <span className="text-app-text-dim"> </span>
                            <span style={{ color: slipRatioColor(ws.rr.slipRatio) }}>RR {(ws.rr.slipRatio * 100).toFixed(0)}%</span>
                          </span>
                        </div>
                        {/* Wheel states */}
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">State</span>
                          <span className="tabular-nums">
                            {[{l:"FL",s:ws.fl},{l:"FR",s:ws.fr},{l:"RL",s:ws.rl},{l:"RR",s:ws.rr}].map(({l,s}) => (
                              <span key={l} className="ml-1" style={{ color: s.state === "grip" ? "#34d399" : s.state === "lockup" ? "#ef4444" : s.state === "spin" ? "#fb923c" : "#94a3b8" }}>
                                {l} {s.state === "grip" ? "OK" : s.state.toUpperCase()}
                              </span>
                            ))}
                          </span>
                        </div>
                      </div>
                    );
                  })()}

                  <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2 pt-2 border-t border-app-border font-semibold">
                    Wheels
                  </h3>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] font-mono">
                    {/* Left column: Speed, Temp, Wear */}
                    <div className="space-y-2">
                      <div>
                        <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">Speed (rad/s)</div>
                        <div className="grid grid-cols-2 gap-x-2">
                          <WheelSpeedValue label="FL" value={currentPacket.WheelRotationSpeedFL} />
                          <WheelSpeedValue label="FR" value={currentPacket.WheelRotationSpeedFR} />
                          <WheelSpeedValue label="RL" value={currentPacket.WheelRotationSpeedRL} />
                          <WheelSpeedValue label="RR" value={currentPacket.WheelRotationSpeedRR} />
                        </div>
                      </div>
                      <div className="border-t border-app-border pt-1">
                        <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">Temp</div>
                        <div className="grid grid-cols-2 gap-x-2">
                          <span className="text-app-text-secondary">FL: <span className="tabular-nums text-app-text">{currentPacket.TireTempFL.toFixed(0)}°</span></span>
                          <span className="text-app-text-secondary">FR: <span className="tabular-nums text-app-text">{currentPacket.TireTempFR.toFixed(0)}°</span></span>
                          <span className="text-app-text-secondary">RL: <span className="tabular-nums text-app-text">{currentPacket.TireTempRL.toFixed(0)}°</span></span>
                          <span className="text-app-text-secondary">RR: <span className="tabular-nums text-app-text">{currentPacket.TireTempRR.toFixed(0)}°</span></span>
                        </div>
                      </div>
                      <div className="border-t border-app-border pt-1">
                        <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">Wear</div>
                        <div className="grid grid-cols-2 gap-x-2">
                          <WearValue label="FL" value={currentPacket.TireWearFL} />
                          <WearValue label="FR" value={currentPacket.TireWearFR} />
                          <WearValue label="RL" value={currentPacket.TireWearRL} />
                          <WearValue label="RR" value={currentPacket.TireWearRR} />
                        </div>
                      </div>
                    </div>
                    {/* Right column: Slip, Angle, Suspension */}
                    <div className="space-y-2">
                      <div>
                        <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">Slip</div>
                        <div className="grid grid-cols-2 gap-x-2">
                          <SlipValue label="FL" value={currentPacket.TireCombinedSlipFL} />
                          <SlipValue label="FR" value={currentPacket.TireCombinedSlipFR} />
                          <SlipValue label="RL" value={currentPacket.TireCombinedSlipRL} />
                          <SlipValue label="RR" value={currentPacket.TireCombinedSlipRR} />
                        </div>
                      </div>
                      <div className="border-t border-app-border pt-1">
                        <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">Slip Angle</div>
                        <div className="grid grid-cols-2 gap-x-2">
                          <SlipAngleValue label="FL" value={currentPacket.TireSlipAngleFL} speedMph={currentPacket.Speed * 2.23694} />
                          <SlipAngleValue label="FR" value={currentPacket.TireSlipAngleFR} speedMph={currentPacket.Speed * 2.23694} />
                          <SlipAngleValue label="RL" value={currentPacket.TireSlipAngleRL} speedMph={currentPacket.Speed * 2.23694} />
                          <SlipAngleValue label="RR" value={currentPacket.TireSlipAngleRR} speedMph={currentPacket.Speed * 2.23694} />
                        </div>
                      </div>
                      <div className="border-t border-app-border pt-1">
                        <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">Suspension</div>
                        <div className="grid grid-cols-2 gap-x-2">
                          <SuspValue label="FL" value={currentPacket.NormSuspensionTravelFL} />
                          <SuspValue label="FR" value={currentPacket.NormSuspensionTravelFR} />
                          <SuspValue label="RL" value={currentPacket.NormSuspensionTravelRL} />
                          <SuspValue label="RR" value={currentPacket.NormSuspensionTravelRR} />
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
              </>
            ) : (
              <InsightPanel insights={lapInsights} onJumpToFrame={setCursorIdx} />
            )}
            </div>
          </div>
        </div>
      )}
      {selectedLapId && (
        <AiAnalysisModal
          lapId={selectedLapId}
          open={aiModalOpen}
          onClose={() => setAiModalOpen(false)}
          carName={carName}
          trackName={trackName}
        />
      )}
    </div>
  );
}
