import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import type { TelemetryPacket, LapMeta } from "@shared/types";
import { CAR_CLASS_NAMES, DRIVETRAIN_NAMES } from "@shared/types";
import { formatLapTime, TireDiagram } from "./LiveTelemetry";
import { SteeringWheel } from "./SteeringWheel";
import { getSteeringLock } from "./Settings";
import { Compass } from "./Compass";

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
  height = 100,
}: {
  series: ChartSeries[];
  cursorIdx: number;
  totalPackets: number;
  onClickIndex: (idx: number) => void;
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

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container || totalPackets < 2) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const w = container.clientWidth;
      const leftPad = 40;
      const rightPad = 8;
      const chartW = w - leftPad - rightPad;
      const frac = (x - leftPad) / chartW;
      const idx = Math.round(frac * (totalPackets - 1));
      if (idx >= 0 && idx < totalPackets) onClickIndex(idx);
    },
    [totalPackets, onClickIndex]
  );

  return (
    <div ref={containerRef} className="w-full">
      <canvas
        ref={canvasRef}
        className="w-full cursor-crosshair rounded bg-slate-900/40"
        style={{ height }}
        onClick={handleClick}
      />
    </div>
  );
}

// ── Metrics Panel ────────────────────────────────────────────────────

function MetricsPanel({ pkt }: { pkt: TelemetryPacket }) {
  const speedMph = pkt.Speed * 2.23694;
  const throttlePct = ((pkt.Accel / 255) * 100).toFixed(0);
  const brakePct = ((pkt.Brake / 255) * 100).toFixed(0);
  const lock = getSteeringLock();
  const steerDeg = (pkt.Steer / 127) * (lock / 2);

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
      <MetricRow label="Speed" value={`${speedMph.toFixed(0)} mph`} />
      <MetricRow label="RPM" value={`${pkt.CurrentEngineRpm.toFixed(0)}`} />
      <MetricRow label="Gear" value={`${pkt.Gear}`} />
      <MetricRow label="Throttle" value={`${throttlePct}%`} color={Number(throttlePct) > 50 ? "#34d399" : undefined} />
      <MetricRow label="Brake" value={`${brakePct}%`} color={Number(brakePct) > 10 ? "#ef4444" : undefined} />
      <MetricRow label="Steer" value={`${steerDeg > 0 ? "+" : ""}${steerDeg.toFixed(0)}°`} />
      <MetricRow label="Boost" value={`${pkt.Boost.toFixed(1)} psi`} />
      <MetricRow label="Power" value={`${(pkt.Power / 745.7).toFixed(0)} hp`} />
      <MetricRow label="Torque" value={`${pkt.Torque.toFixed(0)} Nm`} />
      <MetricRow label="Fuel" value={`${(pkt.Fuel * 100).toFixed(1)}%`} />


    </div>
  );
}

function MetricRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-500">{label}</span>
      <span className={color ? "" : "text-white"} style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}

function WearValue({ label, value }: { label: string; value: number }) {
  const pct = (value * 100).toFixed(1);
  const color = value > 0.7 ? "#34d399" : value > 0.4 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-slate-400">
      {label}: <span style={{ color }}>{pct}%</span>
    </span>
  );
}

function SlipValue({ label, value }: { label: string; value: number }) {
  const color = Math.abs(value) < 0.5 ? "#34d399" : Math.abs(value) < 1.5 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-slate-400">
      {label}: <span style={{ color }}>{value.toFixed(2)}</span>
    </span>
  );
}

function SlipAngleValue({ label, value }: { label: string; value: number }) {
  const deg = value * (180 / Math.PI);
  const a = Math.abs(deg);
  const color = a < 4 ? "#34d399" : a < 8 ? "#fbbf24" : a < 14 ? "#fb923c" : "#ef4444";
  return (
    <span className="text-slate-400">
      {label}: <span style={{ color }}>{deg.toFixed(1)}°</span>
    </span>
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
    <tr className="border-t border-slate-800/50">
      <td className="text-slate-500 text-[10px] pr-2 py-0.5">{label}</td>
      {cell(fl)}{cell(fr)}{cell(rl)}{cell(rr)}
    </tr>
  );
}

function WheelSpeedValue({ label, value }: { label: string; value: number }) {
  const abs = Math.abs(value);
  const color = abs < 10 ? "#94a3b8" : abs < 50 ? "#34d399" : abs < 100 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-slate-400">
      {label}: <span style={{ color }}>{value.toFixed(1)}</span>
    </span>
  );
}

function SuspValue({ label, value }: { label: string; value: number }) {
  const pct = (value * 100).toFixed(0);
  const color = value < 0.6 ? "#22d3ee" : value < 0.85 ? "#fbbf24" : "#ef4444";
  return (
    <span className="text-slate-400">
      {label}: <span style={{ color }}>{pct}%</span>
    </span>
  );
}

// ── Main Component ───────────────────────────────────────────────────

export function LapAnalyse() {
  const search = useSearch({ from: "/analyse" });
  const navigate = useNavigate({ from: "/analyse" });

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
  const [playing, setPlaying] = useState(false);
  const [rotateWithCar, setRotateWithCar] = useState(false);
  const [mapZoom, setMapZoom] = useState(1);
  const [loading, setLoading] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const playRef = useRef(false);
  const speedRef = useRef(1);
  const cursorRef = useRef(0);

  // Name caches for track/car ordinals
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});
  const [carNames, setCarNames] = useState<Record<number, string>>({});

  // Fetch lap list
  useEffect(() => {
    fetch("/api/laps")
      .then((r) => r.json())
      .then((data: LapMeta[]) => {
        if (Array.isArray(data)) setLaps(data.filter((l) => l.lapTime > 0));
      })
      .catch(() => {});
  }, []);

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
        fetch(`/api/track-name/${ord}`)
          .then((r) => r.ok ? r.text() : "")
          .then((name) => { if (name) setTrackNames((prev) => ({ ...prev, [ord]: name })); })
          .catch(() => {});
      }
    }
    for (const ord of carOrdinals) {
      if (!carNames[ord]) {
        fetch(`/api/car-name/${ord}`)
          .then((r) => r.ok ? r.text() : "")
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

    fetch(`/api/laps/${selectedLapId}`)
      .then((r) => r.json())
      .then((data: { meta: LapMeta; telemetry: TelemetryPacket[] }) => {
        if (data && Array.isArray(data.telemetry)) {
          setTelemetry(data.telemetry);
          setCursorIdx(0);
          cursorRef.current = 0;

          // Fetch track outline + sectors
          const trackOrd = selectedTrack ?? data.meta?.trackOrdinal ?? data.telemetry[0]?.TrackOrdinal;
          if (trackOrd != null) {
            fetch(`/api/track-outline/${trackOrd}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => {
                if (data?.points && Array.isArray(data.points)) setOutline(data.points);
                else if (Array.isArray(data)) setOutline(data);
                else setOutline(null);
              })
              .catch(() => setOutline(null));
            fetch(`/api/track-sector-boundaries/${trackOrd}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((s) => { if (s?.s1End) setSectors(s); else setSectors(null); })
              .catch(() => setSectors(null));
            fetch(`/api/track-sectors/${trackOrd}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((s) => { if (s?.segments) setSegments(s.segments); else setSegments(null); })
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

    function step(now: number) {
      if (!playRef.current) return;
      const idx = cursorRef.current;
      if (idx >= telemetry.length - 1) {
        setPlaying(false);
        playRef.current = false;
        return;
      }

      // Re-anchor timing when speed changes mid-playback
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
      speed.push(p.Speed * 2.23694); // m/s -> mph
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
    },
    []
  );

  const handleChartClick = useCallback((idx: number) => {
    setCursorIdx(idx);
    cursorRef.current = idx;
  }, []);

  const currentPacket = telemetry[cursorIdx] ?? null;

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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header: cascading selectors + export */}
      <div className="flex items-center gap-2 p-3 border-b border-slate-800 flex-wrap">
        {/* Track selector */}
        <select
          value={selectedTrack ?? ""}
          onChange={(e) => handleTrackChange(e.target.value ? Number(e.target.value) : null)}
          className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-cyan-400 min-w-[200px]"
        >
          <option value="">Select track...</option>
          {tracks.map(([ord, count]) => (
            <option key={ord} value={ord}>
              {trackNames[ord] || `Track ${ord}`} ({count})
            </option>
          ))}
        </select>

        {/* Car selector */}
        <select
          value={selectedCar ?? ""}
          onChange={(e) => handleCarChange(e.target.value ? Number(e.target.value) : null)}
          disabled={selectedTrack == null}
          className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-cyan-400 min-w-[200px] disabled:opacity-40"
        >
          <option value="">Select car...</option>
          {carsForTrack.map(([ord, count]) => (
            <option key={ord} value={ord}>
              {carNames[ord] || `Car ${ord}`} ({count})
            </option>
          ))}
        </select>

        {/* Lap selector */}
        <select
          value={selectedLapId ?? ""}
          onChange={(e) => setSelectedLapId(e.target.value ? Number(e.target.value) : null)}
          disabled={selectedCar == null}
          className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-cyan-400 min-w-[200px] disabled:opacity-40"
        >
          <option value="">Select lap...</option>
          {filteredLaps.map((lap) => (
            <option key={lap.id} value={lap.id}>
              Lap {lap.lapNumber} - {formatLapTime(lap.lapTime)}
            </option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-2">
          {telemetry.length > 0 && (
            <button
              onClick={handleExport}
              className="text-xs text-slate-400 hover:text-white border border-slate-700 rounded px-3 py-1.5 transition-colors"
            >
              Export CSV
            </button>
          )}
          {loading && (
            <span className="text-xs text-slate-500 animate-pulse">
              Loading...
            </span>
          )}
        </div>
      </div>

      {telemetry.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
          {selectedLapId ? "No telemetry data for this lap." : "Select a track, car, and lap to analyse."}
        </div>
      ) : (
        <>
          {/* Top section: Track Map + Metrics */}
          <div className="grid grid-cols-1 lg:grid-cols-[180px_1fr_auto_420px] border-b border-slate-800 shrink-0">
            {/* Segment table + legend */}
            <div className="border-r border-slate-800 overflow-y-auto p-2" style={{ height: 420 }}>
              {/* Legend */}
              <div className="flex items-center gap-3 mb-2 pb-2 border-b border-slate-800">
                <div className="flex items-center gap-1">
                  <div className="w-3 h-1.5 rounded-sm bg-amber-500" />
                  <span className="text-[9px] text-slate-500">Corner</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-1.5 rounded-sm bg-blue-500" />
                  <span className="text-[9px] text-slate-500">Straight</span>
                </div>
              </div>
              {/* Segment list */}
              {segmentTimes ? (
                <div className="space-y-0.5">
                  {segmentTimes.map((seg, i) => (
                    <div
                      key={i}
                      className={`flex items-center justify-between px-1.5 py-1 rounded text-[11px] font-mono ${
                        seg.active ? "bg-slate-800 ring-1 ring-inset ring-slate-600" : ""
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <div
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: seg.type === "corner" ? "#f59e0b" : "#3b82f6" }}
                        />
                        <span className={seg.active ? "text-white" : "text-slate-400"}>{seg.name}</span>
                      </div>
                      <span className={seg.active ? "text-white" : "text-slate-500"}>
                        {seg.completed && seg.time > 0 ? seg.time.toFixed(3) + "s" : seg.active ? "..." : "-"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-slate-600">No segment data</div>
              )}
            </div>

            {/* Track map */}
            <div className="border-r border-slate-800 bg-slate-950 p-2 relative" style={{ height: 420 }}>
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
                    className="w-6 h-6 text-xs bg-slate-800/80 border border-slate-700 text-slate-400 hover:text-white rounded flex items-center justify-center"
                  >+</button>
                  <button
                    onClick={() => setMapZoom((z) => Math.max(z - 0.25, 0.5))}
                    className="w-6 h-6 text-xs bg-slate-800/80 border border-slate-700 text-slate-400 hover:text-white rounded flex items-center justify-center"
                  >-</button>
                </div>
                {/* View toggle */}
                <button
                  onClick={() => setRotateWithCar((r) => !r)}
                  className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                    rotateWithCar
                      ? "bg-cyan-900/50 border-cyan-700 text-cyan-300"
                      : "bg-slate-800/80 border-slate-700 text-slate-400 hover:text-slate-300"
                  }`}
                  title="Rotate map to follow car direction"
                >
                  {rotateWithCar ? "Car View" : "Fixed View"}
                </button>
                {/* Compass */}
                {currentPacket && <Compass yaw={currentPacket.Yaw} />}
              </div>
            </div>

            {/* Steering wheel + Tire diagram */}
            <div className="border-r border-slate-800 p-2 flex flex-col items-center justify-center gap-2">
              {currentPacket && <SteeringWheel steer={currentPacket.Steer} />}
              {currentPacket && <TireDiagram packet={currentPacket} />}
            </div>

            {/* Metrics + Wheels panel */}
            <div className="p-3 overflow-y-auto" style={{ height: 420 }}>
              <h3 className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 font-semibold">
                Metrics at Cursor
              </h3>
              {currentPacket && <MetricsPanel pkt={currentPacket} />}

              {currentPacket && (
                <>
                  <h3 className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 mt-3 pt-2 border-t border-slate-800 font-semibold">
                    Wheels
                  </h3>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] font-mono">
                    {/* Left column: Speed, Temp, Wear */}
                    <div className="space-y-2">
                      <div>
                        <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Speed (rad/s)</div>
                        <div className="grid grid-cols-2 gap-x-2">
                          <WheelSpeedValue label="FL" value={currentPacket.WheelRotationSpeedFL} />
                          <WheelSpeedValue label="FR" value={currentPacket.WheelRotationSpeedFR} />
                          <WheelSpeedValue label="RL" value={currentPacket.WheelRotationSpeedRL} />
                          <WheelSpeedValue label="RR" value={currentPacket.WheelRotationSpeedRR} />
                        </div>
                      </div>
                      <div className="border-t border-slate-800 pt-1">
                        <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Temp</div>
                        <div className="grid grid-cols-2 gap-x-2">
                          <span className="text-slate-400">FL: <span className="text-white">{currentPacket.TireTempFL.toFixed(0)}°</span></span>
                          <span className="text-slate-400">FR: <span className="text-white">{currentPacket.TireTempFR.toFixed(0)}°</span></span>
                          <span className="text-slate-400">RL: <span className="text-white">{currentPacket.TireTempRL.toFixed(0)}°</span></span>
                          <span className="text-slate-400">RR: <span className="text-white">{currentPacket.TireTempRR.toFixed(0)}°</span></span>
                        </div>
                      </div>
                      <div className="border-t border-slate-800 pt-1">
                        <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Wear</div>
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
                        <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Slip</div>
                        <div className="grid grid-cols-2 gap-x-2">
                          <SlipValue label="FL" value={currentPacket.TireCombinedSlipFL} />
                          <SlipValue label="FR" value={currentPacket.TireCombinedSlipFR} />
                          <SlipValue label="RL" value={currentPacket.TireCombinedSlipRL} />
                          <SlipValue label="RR" value={currentPacket.TireCombinedSlipRR} />
                        </div>
                      </div>
                      <div className="border-t border-slate-800 pt-1">
                        <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Slip Angle</div>
                        <div className="grid grid-cols-2 gap-x-2">
                          <SlipAngleValue label="FL" value={currentPacket.TireSlipAngleFL} />
                          <SlipAngleValue label="FR" value={currentPacket.TireSlipAngleFR} />
                          <SlipAngleValue label="RL" value={currentPacket.TireSlipAngleRL} />
                          <SlipAngleValue label="RR" value={currentPacket.TireSlipAngleRR} />
                        </div>
                      </div>
                      <div className="border-t border-slate-800 pt-1">
                        <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Suspension</div>
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
            </div>
          </div>

          {/* Lap time + Timeline scrubber */}
          <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/50">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-[10px] text-slate-500">Lap {selectedLap?.lapNumber ?? "?"}</span>
              <span className="text-2xl font-mono font-bold tabular-nums text-cyan-400">{formatLapTime(currentTime)}</span>
              <span className="text-sm font-mono tabular-nums text-slate-400">/ {formatLapTime(totalTime)}</span>
              {sectorTimes && (["S1", "S2", "S3"] as const).map((name, i) => {
                const colors = ["#ef4444", "#3b82f6", "#eab308"];
                const isActive = sectorTimes.cursorSector === i;
                return (
                  <div
                    key={name}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded ${
                      isActive ? "bg-slate-800 ring-1" : "bg-slate-800/30"
                    }`}
                    style={isActive ? { boxShadow: `inset 0 0 0 1px ${colors[i]}40` } : {}}
                  >
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: colors[i] }} />
                    <span className="text-[10px] font-semibold text-slate-500">{name}</span>
                    <span className={`text-xs font-mono font-bold tabular-nums ${isActive ? "text-white" : "text-slate-400"}`}>
                      {formatLapTime(sectorTimes.times[i])}
                    </span>
                  </div>
                );
              })}
              <span className="text-[10px] font-mono text-slate-600 ml-auto">
                Packet {cursorIdx + 1}/{telemetry.length}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setPlaying((p) => !p)}
                className="text-lg w-8 h-8 flex items-center justify-center rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
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
                        : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-300"
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
                className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
            </div>
          </div>

          {/* Stacked charts */}
          {chartData && (
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              <TelemetryChart
                series={[
                  { data: chartData.speed, color: "#22d3ee", label: "Speed (mph)" },
                ]}
                cursorIdx={cursorIdx}
                totalPackets={telemetry.length}
                onClickIndex={handleChartClick}
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
                height={100}
              />
              <TelemetryChart
                series={[
                  { data: chartData.rpm, color: "#a855f7", label: "RPM" },
                ]}
                cursorIdx={cursorIdx}
                totalPackets={telemetry.length}
                onClickIndex={handleChartClick}
                height={100}
              />
              <TelemetryChart
                series={[
                  { data: chartData.steering, color: "#fbbf24", label: "Steering" },
                ]}
                cursorIdx={cursorIdx}
                totalPackets={telemetry.length}
                onClickIndex={handleChartClick}
                height={80}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
