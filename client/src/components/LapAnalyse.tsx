import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { TelemetryPacket, LapMeta } from "@shared/types";
import { CAR_CLASS_NAMES, DRIVETRAIN_NAMES } from "@shared/types";
import { formatLapTime } from "./LiveTelemetry";

interface Point {
  x: number;
  z: number;
}

// ── Track Map (analyse version) ──────────────────────────────────────

function AnalyseTrackMap({
  telemetry,
  cursorIdx,
  outline,
}: {
  telemetry: TelemetryPacket[];
  cursorIdx: number;
  outline: Point[] | null;
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

    // Build points from outline or telemetry
    const displayOutline: Point[] =
      outline && outline.length > 2
        ? outline
        : telemetry
            .filter((p) => p.PositionX !== 0 || p.PositionZ !== 0)
            .map((p) => ({ x: p.PositionX, z: p.PositionZ }));

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
    const padding = 24;
    const scale = Math.min(
      (w - padding * 2) / rangeX,
      (h - padding * 2) / rangeZ
    );
    const offsetX = (w - rangeX * scale) / 2;
    const offsetZ = (h - rangeZ * scale) / 2;

    function toCanvas(x: number, z: number): [number, number] {
      return [offsetX + (x - minX) * scale, offsetZ + (z - minZ) * scale];
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

    // Thinner colored line
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
  }, [telemetry, cursorIdx, outline]);

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
  const steerAngle = pkt.Steer - 127;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
      <MetricRow label="Speed" value={`${speedMph.toFixed(0)} mph`} />
      <MetricRow label="RPM" value={`${pkt.CurrentEngineRpm.toFixed(0)}`} />
      <MetricRow label="Gear" value={`${pkt.Gear}`} />
      <MetricRow label="Throttle" value={`${throttlePct}%`} color={Number(throttlePct) > 50 ? "#34d399" : undefined} />
      <MetricRow label="Brake" value={`${brakePct}%`} color={Number(brakePct) > 10 ? "#ef4444" : undefined} />
      <MetricRow label="Steer" value={`${steerAngle > 0 ? "+" : ""}${steerAngle}`} />
      <MetricRow label="Boost" value={`${pkt.Boost.toFixed(1)} psi`} />
      <MetricRow label="Power" value={`${(pkt.Power / 745.7).toFixed(0)} hp`} />
      <MetricRow label="Torque" value={`${pkt.Torque.toFixed(0)} Nm`} />
      <MetricRow label="Fuel" value={`${(pkt.Fuel * 100).toFixed(1)}%`} />

      <div className="col-span-2 mt-1 border-t border-slate-800 pt-1">
        <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Tire Temps (°F)</div>
        <div className="grid grid-cols-2 gap-1 text-[11px]">
          <span className="text-slate-400">FL: <span className="text-white">{pkt.TireTempFL.toFixed(0)}</span></span>
          <span className="text-slate-400">FR: <span className="text-white">{pkt.TireTempFR.toFixed(0)}</span></span>
          <span className="text-slate-400">RL: <span className="text-white">{pkt.TireTempRL.toFixed(0)}</span></span>
          <span className="text-slate-400">RR: <span className="text-white">{pkt.TireTempRR.toFixed(0)}</span></span>
        </div>
      </div>

      <div className="col-span-2 mt-1 border-t border-slate-800 pt-1">
        <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Tire Wear</div>
        <div className="grid grid-cols-2 gap-1 text-[11px]">
          <WearValue label="FL" value={pkt.TireWearFL} />
          <WearValue label="FR" value={pkt.TireWearFR} />
          <WearValue label="RL" value={pkt.TireWearRL} />
          <WearValue label="RR" value={pkt.TireWearRR} />
        </div>
      </div>

      <div className="col-span-2 mt-1 border-t border-slate-800 pt-1">
        <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Tire Slip (combined)</div>
        <div className="grid grid-cols-2 gap-1 text-[11px]">
          <SlipValue label="FL" value={pkt.TireCombinedSlipFL} />
          <SlipValue label="FR" value={pkt.TireCombinedSlipFR} />
          <SlipValue label="RL" value={pkt.TireCombinedSlipRL} />
          <SlipValue label="RR" value={pkt.TireCombinedSlipRR} />
        </div>
      </div>
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

// ── Main Component ───────────────────────────────────────────────────

export function LapAnalyse() {
  const [laps, setLaps] = useState<LapMeta[]>([]);
  const [selectedLapId, setSelectedLapId] = useState<number | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryPacket[]>([]);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [sectors, setSectors] = useState<{ s1End: number; s2End: number } | null>(null);
  const [cursorIdx, setCursorIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const playRef = useRef(false);
  const cursorRef = useRef(0);

  // Fetch lap list
  useEffect(() => {
    fetch("/api/laps")
      .then((r) => r.json())
      .then((data: LapMeta[]) => {
        if (Array.isArray(data)) setLaps(data.filter((l) => l.lapTime > 0));
      })
      .catch(() => {});
  }, []);

  // Fetch telemetry when lap selected
  useEffect(() => {
    if (selectedLapId == null) return;
    setLoading(true);
    setPlaying(false);
    playRef.current = false;

    fetch(`/api/laps/${selectedLapId}`)
      .then((r) => r.json())
      .then((data: { meta: LapMeta; telemetry: TelemetryPacket[] }) => {
        if (data && Array.isArray(data.telemetry)) {
          setTelemetry(data.telemetry);
          setCursorIdx(0);
          cursorRef.current = 0;

          // Fetch track outline + sectors
          const trackOrd = data.meta?.trackOrdinal ?? data.telemetry[0]?.TrackOrdinal;
          if (trackOrd != null) {
            fetch(`/api/track-outline/${trackOrd}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((pts) => setOutline(pts))
              .catch(() => setOutline(null));
            fetch(`/api/track-sectors/${trackOrd}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((s) => setSectors(s))
              .catch(() => setSectors(null));
          } else {
            setOutline(null);
            setSectors(null);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedLapId]);

  // Play/pause animation
  useEffect(() => {
    playRef.current = playing;
    if (!playing || telemetry.length < 2) return;

    let rafId: number;
    let lastTime = performance.now();

    function step(now: number) {
      if (!playRef.current) return;
      const elapsed = now - lastTime;
      const idx = cursorRef.current;
      if (idx >= telemetry.length - 1) {
        setPlaying(false);
        playRef.current = false;
        return;
      }

      // Advance based on real-time delta between packets
      const dtPacket = telemetry[idx + 1].TimestampMS - telemetry[idx].TimestampMS;
      const dtTarget = Math.max(dtPacket, 1); // ms between packets
      if (elapsed >= dtTarget) {
        const nextIdx = Math.min(idx + 1, telemetry.length - 1);
        cursorRef.current = nextIdx;
        setCursorIdx(nextIdx);
        lastTime = now;
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
      steering.push(p.Steer - 127);
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
    const csv = [
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
  }, [telemetry, selectedLapId]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header: lap selector + export */}
      <div className="flex items-center gap-3 p-3 border-b border-slate-800">
        <select
          value={selectedLapId ?? ""}
          onChange={(e) =>
            setSelectedLapId(e.target.value ? Number(e.target.value) : null)
          }
          className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-cyan-400 min-w-[280px]"
        >
          <option value="">Select a lap...</option>
          {laps.map((lap) => {
            const cls = lap.carOrdinal != null ? ` [${CAR_CLASS_NAMES[0] ?? ""}]` : "";
            return (
              <option key={lap.id} value={lap.id}>
                Lap {lap.lapNumber} - {formatLapTime(lap.lapTime)}
                {lap.carOrdinal != null ? ` - Car ${lap.carOrdinal}` : ""}
              </option>
            );
          })}
        </select>
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

      {telemetry.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
          {selectedLapId ? "No telemetry data for this lap." : "Select a recorded lap to analyse."}
        </div>
      ) : (
        <>
          {/* Top section: Track Map + Metrics */}
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] border-b border-slate-800" style={{ minHeight: 280 }}>
            {/* Track map */}
            <div className="border-r border-slate-800 bg-slate-950 p-2">
              <AnalyseTrackMap
                telemetry={telemetry}
                cursorIdx={cursorIdx}
                outline={outline}
              />
            </div>

            {/* Metrics panel */}
            <div className="p-3 overflow-y-auto" style={{ maxHeight: 340 }}>
              <h3 className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 font-semibold">
                Metrics at Cursor
              </h3>
              {currentPacket && <MetricsPanel pkt={currentPacket} />}
            </div>
          </div>

          {/* Timeline scrubber */}
          <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/50">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setPlaying((p) => !p)}
                className="text-lg w-8 h-8 flex items-center justify-center rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                title={playing ? "Pause (Space)" : "Play (Space)"}
              >
                {playing ? "\u275A\u275A" : "\u25B6"}
              </button>
              <input
                type="range"
                min={0}
                max={telemetry.length - 1}
                value={cursorIdx}
                onChange={handleSliderChange}
                className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
            </div>
            <div className="flex justify-between mt-1 text-[10px] text-slate-500 font-mono">
              <span>{formatLapTime(currentTime)} / {formatLapTime(totalTime)}</span>
              <span>
                Packet {cursorIdx + 1} / {telemetry.length}
                {selectedLap ? ` — Lap ${selectedLap.lapNumber}` : ""}
              </span>
            </div>
          </div>

          {/* Sector times */}
          {sectorTimes && (
            <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-3">
              {(["S1", "S2", "S3"] as const).map((name, i) => {
                const colors = ["#ef4444", "#3b82f6", "#eab308"];
                const isActive = sectorTimes.cursorSector === i;
                return (
                  <div
                    key={name}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded ${
                      isActive ? "bg-slate-800 ring-1" : "bg-slate-800/30"
                    }`}
                    style={isActive ? { boxShadow: `inset 0 0 0 1px ${colors[i]}40` } : {}}
                  >
                    <div
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: colors[i] }}
                    />
                    <span className="text-xs font-semibold text-slate-400">{name}</span>
                    <span className={`text-sm font-mono font-bold tabular-nums ${isActive ? "text-white" : "text-slate-300"}`}>
                      {formatLapTime(sectorTimes.times[i])}
                    </span>
                  </div>
                );
              })}
              <span className="text-[10px] text-slate-500 ml-auto font-mono">
                Total: {formatLapTime(sectorTimes.times[0] + sectorTimes.times[1] + sectorTimes.times[2])}
              </span>
            </div>
          )}

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
