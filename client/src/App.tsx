import { useState, useEffect, useRef, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";
import { useWebSocket } from "./hooks/useWebSocket";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { LiveTelemetry, formatLapTime } from "./components/LiveTelemetry";
import { CurrentLapStats } from "./components/CurrentLapStats";
import { LiveTrackMap } from "./components/LiveTrackMap";
import { LapList } from "./components/LapList";
import { LapComparison } from "./components/LapComparison";
import { RawTelemetry } from "./components/RawTelemetry";
import { TrackViewer } from "./components/TrackViewer";
import { LapAnalyse } from "./components/LapAnalyse";
import { Settings } from "./components/Settings";
import { Button } from "@/components/ui/button";

function LapTimeChart({ packet }: { packet: TelemetryPacket | null }) {
  const [laps, setLaps] = useState<{ lap: number; time: number }[]>([]);
  const lastLapRef = useRef<number>(0);
  const fetchedRef = useRef(false);

  // Fetch recorded laps on mount
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetch("/api/laps")
      .then((r) => r.json())
      .then((data: { id: number; lapNumber: number; lapTime: number }[]) => {
        if (Array.isArray(data) && data.length > 0) {
          const recorded = data
            .filter((l) => l.lapTime > 0)
            .map((l) => ({ lap: l.lapNumber, time: l.lapTime }))
            .slice(-10);
          setLaps(recorded);
        }
      })
      .catch(() => {});
  }, []);

  // Accumulate live laps
  useEffect(() => {
    if (!packet) return;
    if (packet.LapNumber > lastLapRef.current && packet.LastLap > 0 && lastLapRef.current > 0) {
      setLaps((prev) => {
        // Avoid duplicates
        if (prev.some((l) => l.lap === lastLapRef.current)) return prev;
        const next = [...prev, { lap: lastLapRef.current, time: packet.LastLap }];
        return next.slice(-10);
      });
    }
    lastLapRef.current = packet.LapNumber;
  }, [packet?.LapNumber]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const height = 160;

  const handleClearAll = () => {
    fetch("/api/laps", { method: "DELETE" })
      .then(() => setLaps([]))
      .catch(() => {});
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || laps.length < 1) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = container.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const leftPad = 45;
    const rightPad = 10;

    const times = laps.map((l) => l.time);
    const best = Math.min(...times);
    const worst = Math.max(...times);
    const pad = (worst - best) * 0.15 || 1;
    const minY = best - pad;
    const maxY = worst + pad;
    const yRange = maxY - minY;

    // Optimum pace — median of top 5
    const sorted = [...times].sort((a, b) => a - b);
    const top5 = sorted.slice(0, Math.min(5, sorted.length));
    const optimum = top5.length % 2 === 0
      ? (top5[top5.length / 2 - 1] + top5[top5.length / 2]) / 2
      : top5[Math.floor(top5.length / 2)];
    const optimumY = height - ((optimum - minY) / yRange) * height;

    // Avg pace — average of last 4 laps
    const recent4 = times.slice(-4);
    const avgPace = recent4.reduce((a, b) => a + b, 0) / recent4.length;
    const avgY = height - ((avgPace - minY) / yRange) * height;

    const chartW = width - leftPad - rightPad;

    // Y axis labels (3-4 ticks)
    const tickCount = 4;
    ctx.font = "8px monospace";
    ctx.fillStyle = "#475569";
    ctx.textAlign = "right";
    for (let i = 0; i <= tickCount; i++) {
      const val = minY + (yRange * i) / tickCount;
      const y = height - (i / tickCount) * height;
      ctx.fillText(formatLapTime(val), leftPad - 4, y + 3);
      // Grid line
      ctx.strokeStyle = "rgba(100,116,139,0.08)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(width - rightPad, y);
      ctx.stroke();
    }

    // Optimum pace line (purple)
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "rgba(168,85,247,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftPad, optimumY);
    ctx.lineTo(width - rightPad, optimumY);
    ctx.stroke();

    // Avg pace line (amber)
    ctx.strokeStyle = "rgba(251,191,36,0.4)";
    ctx.beginPath();
    ctx.moveTo(leftPad, avgY);
    ctx.lineTo(width - rightPad, avgY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Pace labels
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(168,85,247,0.7)";
    ctx.fillText(`optimum`, width - rightPad - 2, optimumY - 3);
    ctx.fillStyle = "rgba(251,191,36,0.6)";
    ctx.fillText(`avg`, width - rightPad - 2, avgY - 3);

    // Line
    const step = laps.length > 1 ? chartW / (laps.length - 1) : chartW / 2;
    ctx.beginPath();
    for (let i = 0; i < laps.length; i++) {
      const x = leftPad + i * step;
      const y = height - ((laps[i].time - minY) / yRange) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(34,211,238,0.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Dots + lap numbers
    for (let i = 0; i < laps.length; i++) {
      const x = leftPad + i * step;
      const y = height - ((laps[i].time - minY) / yRange) * height;
      const isBest = laps[i].time === best;
      ctx.beginPath();
      ctx.arc(x, y, isBest ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isBest ? "#a855f7" : laps[i].time <= optimum ? "#34d399" : "#fb923c";
      ctx.fill();

      // Lap number below
      ctx.fillStyle = "#475569";
      ctx.font = "7px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${laps[i].lap}`, x, height - 2);
    }
  }, [laps]);

  if (laps.length === 0) return null;

  return (
    <div className="border-b border-slate-800">
      <div className="p-2 border-b border-slate-800 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Lap Times</h2>
        <button
          onClick={handleClearAll}
          className="text-[10px] text-red-400 hover:text-red-300 font-mono"
        >
          Clear All
        </button>
      </div>
      <div className="p-3" ref={containerRef}>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height }}
          className="rounded bg-slate-900/40"
        />
        <div className="flex gap-3 mt-1.5 flex-wrap">
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 bg-cyan-400 rounded" />
            <span className="text-[9px] text-slate-500">Lap time</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 bg-purple-500 rounded border-dashed" style={{ borderTop: "1px dashed #a855f7", height: 0 }} />
            <span className="text-[9px] text-slate-500">Optimum (top 5 median)</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3" style={{ borderTop: "1px dashed #fbbf24", height: 0 }} />
            <span className="text-[9px] text-slate-500">Avg (last 4)</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-purple-500" />
            <span className="text-[9px] text-slate-500">Best</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-[9px] text-slate-500">On pace</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-orange-400" />
            <span className="text-[9px] text-slate-500">Off pace</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectorTimes({ packet }: { packet: TelemetryPacket | null }) {
  const [sectors, setSectors] = useState<{ s1End: number; s2End: number } | null>(null);
  const trackOrdRef = useRef<number | null>(null);
  const sectorStateRef = useRef<{
    lapDistStart: number;
    lapDistTotal: number; // estimated lap distance
    currentSector: number; // 0=S1, 1=S2, 2=S3
    sectorStartTime: number; // CurrentLap time at sector start
    currentTimes: [number, number, number]; // current lap sector times
    bestTimes: [number, number, number]; // session best per sector
    lastTimes: [number, number, number]; // last completed lap sector times
    lastLap: number;
  }>({
    lapDistStart: 0,
    lapDistTotal: 0,
    currentSector: 0,
    sectorStartTime: 0,
    currentTimes: [0, 0, 0],
    bestTimes: [Infinity, Infinity, Infinity],
    lastTimes: [0, 0, 0],
    lastLap: 0,
  });
  const [, tick] = useState(0);

  // Fetch sectors when track changes
  useEffect(() => {
    if (!packet) return;
    const fetchSectors = async () => {
      try {
        const statusRes = await fetch("/api/status");
        if (!statusRes.ok) return;
        const status = await statusRes.json();
        const trackOrd = status.currentSession?.trackOrdinal;
        if (trackOrd == null || trackOrd === trackOrdRef.current) return;
        trackOrdRef.current = trackOrd;

        const res = await fetch(`/api/track-sectors/${trackOrd}`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.s1End) setSectors(data);
        }
      } catch {}
    };
    fetchSectors();
  }, [packet?.LapNumber]);

  // Track sector crossings
  useEffect(() => {
    if (!packet || !sectors) return;
    const s = sectorStateRef.current;

    // Detect new lap
    if (packet.LapNumber > s.lastLap && s.lastLap > 0) {
      // Complete S3
      const s3Time = packet.CurrentLap > 0 ? 0 : s.currentTimes[2]; // lap just reset
      if (s.currentTimes[0] > 0 && s.currentTimes[1] > 0) {
        // Save last completed sector times
        s.lastTimes = [...s.currentTimes] as [number, number, number];
        // The S3 time was everything after S2 started
        s.lastTimes[2] = packet.LastLap - s.currentTimes[0] - s.currentTimes[1];
        if (s.lastTimes[2] < 0) s.lastTimes[2] = 0;

        // Update bests
        for (let i = 0; i < 3; i++) {
          if (s.lastTimes[i] > 0 && s.lastTimes[i] < s.bestTimes[i]) {
            s.bestTimes[i] = s.lastTimes[i];
          }
        }
      }

      s.lapDistStart = packet.DistanceTraveled;
      s.currentSector = 0;
      s.sectorStartTime = 0;
      s.currentTimes = [0, 0, 0];
    }
    s.lastLap = packet.LapNumber;

    // Estimate progress through lap using distance
    if (s.lapDistTotal <= 0 && packet.LastLap > 0 && s.lapDistStart > 0) {
      // Can't easily get lap distance, estimate from outline. Use a large fallback.
      // We'll detect sector crossings based on accumulated distance fraction.
    }

    // Use CurrentLap time for sector timing
    const lapTime = packet.CurrentLap;
    const lapDist = packet.DistanceTraveled - s.lapDistStart;

    // We need total lap distance to compute fraction. Estimate from first completed lap.
    if (s.lapDistTotal <= 0 && lapDist > 100) {
      // Will be set properly on lap completion
    }

    // Simple approach: use the outline fraction. Since we don't have normalized distance,
    // track total distance on first lap completion, then use it for subsequent laps.
    // For now, detect based on distance traveled in this lap vs estimated lap distance.

    // Trigger re-render periodically
    tick((v) => v + 1);
  }, [packet, sectors]);

  // Simpler approach: use distance fraction from first completed lap
  useEffect(() => {
    if (!packet || !sectors) return;
    const s = sectorStateRef.current;

    // On lap boundary, record lap distance
    if (packet.LapNumber > s.lastLap && s.lapDistStart > 0) {
      const completedDist = packet.DistanceTraveled - s.lapDistStart;
      if (completedDist > 100) {
        s.lapDistTotal = completedDist;
      }
    }
  }, [packet?.LapNumber]);

  // Sector crossing detection
  useEffect(() => {
    if (!packet || !sectors) return;
    const s = sectorStateRef.current;
    if (s.lapDistTotal <= 0) return;

    const lapDist = packet.DistanceTraveled - s.lapDistStart;
    const frac = lapDist / s.lapDistTotal;

    const sectorBounds = [0, sectors.s1End, sectors.s2End, 1];
    const expectedSector =
      frac < sectors.s1End ? 0 :
      frac < sectors.s2End ? 1 : 2;

    if (expectedSector > s.currentSector) {
      // Crossed into next sector — record time for completed sector
      s.currentTimes[s.currentSector] = packet.CurrentLap - s.sectorStartTime;
      s.sectorStartTime = packet.CurrentLap;
      s.currentSector = expectedSector;
    }
  }, [packet, sectors]);

  if (!sectors) return null;

  const s = sectorStateRef.current;
  const sectorNames = ["S1", "S2", "S3"];
  const sectorColors = ["#ef4444", "#3b82f6", "#eab308"];

  return (
    <div className="border-b border-slate-800">
      <div className="p-2 border-b border-slate-800">
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Sectors</h2>
      </div>
      <div className="p-3">
        <div className="grid grid-cols-3 gap-2">
          {sectorNames.map((name, i) => {
            const current = i === s.currentSector ? (packet ? packet.CurrentLap - s.sectorStartTime : 0) : s.currentTimes[i];
            const best = s.bestTimes[i] < Infinity ? s.bestTimes[i] : 0;
            const last = s.lastTimes[i];
            const isActive = i === s.currentSector;

            return (
              <div key={name} className={`rounded p-2 ${isActive ? "bg-slate-800/80 ring-1" : "bg-slate-800/30"}`} style={isActive ? { ringColor: sectorColors[i] } : {}}>
                <div className="flex items-center gap-1 mb-1">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: sectorColors[i] }} />
                  <span className="text-[10px] font-semibold text-slate-400">{name}</span>
                </div>
                <div className={`text-sm font-mono font-bold tabular-nums ${isActive ? "text-white" : "text-slate-300"}`}>
                  {current > 0 ? formatLapTime(current) : "--:--.---"}
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-[8px] text-slate-500">Last</span>
                  <span className="text-[8px] font-mono text-slate-400">{last > 0 ? formatLapTime(last) : "-"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[8px] text-purple-400">Best</span>
                  <span className="text-[8px] font-mono text-purple-400">{best > 0 ? formatLapTime(best) : "-"}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type Tab = "live" | "compare" | "analyse" | "tracks" | "raw";

const TABS: { id: Tab; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "compare", label: "Compare" },
  { id: "analyse", label: "Analyse" },
  { id: "tracks", label: "Tracks" },
  { id: "raw", label: "Raw" },
];

export default function App() {
  const { connected, packet, packetsPerSec } = useWebSocket();
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("live");
  const [trackName, setTrackName] = useState("");
  const lastTrackFetchRef = useRef<number | null>(null);

  useEffect(() => {
    if (!packet) return;
    // Fetch track name from session — only refetch when lap changes
    fetch("/api/status")
      .then((r) => r.json())
      .then((status) => {
        const trackOrd = status.currentSession?.trackOrdinal;
        if (trackOrd == null || trackOrd === lastTrackFetchRef.current) return;
        lastTrackFetchRef.current = trackOrd;
        return fetch(`/api/track-name/${trackOrd}`);
      })
      .then((r) => r?.text())
      .then((name) => { if (name) setTrackName(name); })
      .catch(() => {});
  }, [packet?.LapNumber]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <div className="flex items-center justify-between border-b border-slate-800">
        <div className="flex items-center">
          <ConnectionStatus connected={connected} packetsPerSec={packetsPerSec} forzaReceiving={packetsPerSec > 0} />

          <div className="flex items-center gap-0 ml-4">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? "border-cyan-400 text-cyan-400"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowSettings(!showSettings)}
          className="mr-2 text-slate-400 hover:text-white"
        >
          {showSettings ? "Close" : "Settings"}
        </Button>
      </div>

      {showSettings && (
        <div className="p-4 border-b border-slate-800 bg-slate-950">
          <div className="max-w-md">
            <Settings />
          </div>
        </div>
      )}

      {activeTab === "live" && (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0">
          <div className="border-r border-slate-800 overflow-auto">
            <div className="p-2 border-b border-slate-800">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Live Telemetry
              </h2>
            </div>
            <LiveTelemetry packet={packet} />
          </div>
          <div className="overflow-auto flex flex-col">
            {/* Live Track Map + Current Lap Stats */}
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] border-b border-slate-800">
              <div className="border-r border-slate-800 bg-slate-950" style={{ minHeight: 220 }}>
                <div className="p-2 border-b border-slate-800 flex items-center justify-between">
                  <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Track Map
                  </h2>
                  {trackName && (
                    <span className="text-xs text-slate-400 truncate ml-2">{trackName}</span>
                  )}
                </div>
                <LiveTrackMap packet={packet} />
              </div>
              <div>
                <div className="p-2 border-b border-slate-800">
                  <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Current Lap
                  </h2>
                </div>
                <CurrentLapStats packet={packet} />
              </div>
            </div>

            {/* Lap Info */}
            {packet && (
              <div className="border-b border-slate-800">
                <div className="p-2 border-b border-slate-800">
                  <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Race Info</h2>
                </div>
                <div className="p-3">
                  <div className="flex items-baseline gap-4 mb-2">
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-wider">Position</div>
                      <div className="text-2xl font-mono font-bold text-white tabular-nums">P{packet.RacePosition}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-wider">Lap</div>
                      <div className="text-2xl font-mono font-bold text-white tabular-nums">{packet.LapNumber}</div>
                    </div>
                    <div className="flex-1">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wider">Current</div>
                      <div className="text-2xl font-mono font-bold text-white tabular-nums">{formatLapTime(packet.CurrentLap)}</div>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <div>
                      <span className="text-[10px] text-slate-500">Last </span>
                      <span className="text-sm font-mono text-slate-300 tabular-nums">{formatLapTime(packet.LastLap)}</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500">Best </span>
                      <span className="text-sm font-mono text-purple-400 tabular-nums">{formatLapTime(packet.BestLap)}</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500">Dist </span>
                      <span className="text-sm font-mono text-slate-300 tabular-nums">{(packet.DistanceTraveled / 1609.34).toFixed(2)} mi</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Sector Times */}
            <SectorTimes packet={packet} />

            {/* Lap Time Chart */}
            <LapTimeChart packet={packet} />

            {/* Recorded Laps */}
            <div className="flex-1">
              <div className="p-2 border-b border-slate-800">
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Recorded Laps
                </h2>
              </div>
              <LapList />
            </div>
          </div>
        </div>
      )}

      {activeTab === "compare" && (
        <div className="flex-1 overflow-hidden">
          <LapComparison />
        </div>
      )}

      {activeTab === "analyse" && (
        <div className="flex-1 overflow-hidden">
          <LapAnalyse />
        </div>
      )}

      {activeTab === "tracks" && (
        <div className="flex-1 overflow-auto">
          <TrackViewer />
        </div>
      )}

      {activeTab === "raw" && (
        <div className="flex-1 overflow-hidden">
          <RawTelemetry packet={packet} />
        </div>
      )}
    </div>
  );
}
