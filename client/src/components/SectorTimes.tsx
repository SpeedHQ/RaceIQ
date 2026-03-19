import { useState, useEffect, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";
import { formatLapTime } from "./LiveTelemetry";

/**
 * SectorTimes — Distance-based sector split timing.
 * Forza doesn't expose sector boundaries, so we use pre-computed fractional
 * positions (s1End, s2End) from the track outline's distance analysis.
 */
export function SectorTimes({ packet }: { packet: TelemetryPacket | null }) {
  const [sectors, setSectors] = useState<{ s1End: number; s2End: number } | null>(null);
  const trackOrdRef = useRef<number | null>(null);
  const sectorStateRef = useRef<{
    lapDistStart: number;
    lapDistTotal: number;
    currentSector: number;
    sectorStartTime: number;
    currentTimes: [number, number, number];
    bestTimes: [number, number, number];
    lastTimes: [number, number, number];
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

  useEffect(() => {
    if (!packet || !sectors) return;
    const s = sectorStateRef.current;

    if (packet.LapNumber > s.lastLap && s.lastLap > 0) {
      const s3Time = packet.CurrentLap > 0 ? 0 : s.currentTimes[2];
      if (s.currentTimes[0] > 0 && s.currentTimes[1] > 0) {
        s.lastTimes = [...s.currentTimes] as [number, number, number];
        s.lastTimes[2] = packet.LastLap - s.currentTimes[0] - s.currentTimes[1];
        if (s.lastTimes[2] < 0) s.lastTimes[2] = 0;

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

    if (s.lapDistTotal <= 0 && packet.LastLap > 0 && s.lapDistStart > 0) {
      // placeholder
    }

    const lapTime = packet.CurrentLap;
    const lapDist = packet.DistanceTraveled - s.lapDistStart;

    tick((v) => v + 1);
  }, [packet, sectors]);

  useEffect(() => {
    if (!packet || !sectors) return;
    const s = sectorStateRef.current;

    if (packet.LapNumber > s.lastLap && s.lapDistStart > 0) {
      const completedDist = packet.DistanceTraveled - s.lapDistStart;
      if (completedDist > 100) {
        s.lapDistTotal = completedDist;
      }
    }
  }, [packet?.LapNumber]);

  useEffect(() => {
    if (!packet || !sectors) return;
    const s = sectorStateRef.current;
    if (s.lapDistTotal <= 0) return;

    const lapDist = packet.DistanceTraveled - s.lapDistStart;
    const frac = lapDist / s.lapDistTotal;

    const expectedSector =
      frac < sectors.s1End ? 0 :
      frac < sectors.s2End ? 1 : 2;

    if (expectedSector > s.currentSector) {
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
    <div className="border-b border-app-border">
      <div className="p-2 border-b border-app-border">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Sectors</h2>
      </div>
      <div className="p-3">
        <div className="grid grid-cols-3 gap-2">
          {sectorNames.map((name, i) => {
            const current = i === s.currentSector ? (packet ? packet.CurrentLap - s.sectorStartTime : 0) : s.currentTimes[i];
            const best = s.bestTimes[i] < Infinity ? s.bestTimes[i] : 0;
            const last = s.lastTimes[i];
            const isActive = i === s.currentSector;

            return (
              <div key={name} className={`rounded p-2 ${isActive ? "bg-app-surface-alt/80 ring-1" : "bg-app-surface-alt/30"}`} style={isActive ? { ringColor: sectorColors[i] } : {}}>
                <div className="flex items-center gap-1 mb-1">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: sectorColors[i] }} />
                  <span className="text-[10px] font-semibold text-app-text-secondary">{name}</span>
                </div>
                <div className={`text-sm font-mono font-bold tabular-nums ${isActive ? "text-app-text" : "text-app-text"}`}>
                  {current > 0 ? formatLapTime(current) : "--:--.---"}
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-[8px] text-app-text-muted">Last</span>
                  <span className="text-[8px] font-mono text-app-text-secondary">{last > 0 ? formatLapTime(last) : "-"}</span>
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
