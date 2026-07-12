import { useEffect, useRef, useState } from "react";
import type { TelemetryPacket } from "@shared/types";
import { client } from "../lib/rpc";
import { useGameId } from "../stores/game";

interface Props {
  packet: TelemetryPacket | null;
}

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

const SECTOR_COLORS = ["#ef4444", "#3b82f6", "#eab308"];

export function CurrentLapStats({ packet }: Props) {
  const gameId = useGameId();
  const [sectors, setSectors] = useState<{ s1End: number; s2End: number } | null>(null);
  const trackOrdRef = useRef<number | null>(null);
  const stateRef = useRef({
    lapDistStart: 0,
    lapDistTotal: 0,
    currentSector: 0,
    sectorStartTime: 0,
    currentTimes: [0, 0, 0] as [number, number, number],
    bestTimes: [Infinity, Infinity, Infinity] as [number, number, number],
    lastTimes: [0, 0, 0] as [number, number, number],
    lastLap: 0,
  });
  const [, tick] = useState(0);

  // Fetch sectors when track changes
  useEffect(() => {
    if (!packet?.TrackOrdinal) return;
    if (packet.TrackOrdinal === trackOrdRef.current) return;
    trackOrdRef.current = packet.TrackOrdinal;

    // Reset state for new track
    stateRef.current = {
      lapDistStart: 0,
      lapDistTotal: 0,
      currentSector: 0,
      sectorStartTime: 0,
      currentTimes: [0, 0, 0],
      bestTimes: [Infinity, Infinity, Infinity],
      lastTimes: [0, 0, 0],
      lastLap: 0,
    };

    if (!gameId) return;
    client.api["track-sectors"][":ordinal"]
      .$get({ param: { ordinal: String(packet.TrackOrdinal) }, query: { gameId: gameId! } })
      .then((r) => r.json() as any)
      .then((data: any) => {
        if (data?.s1End) setSectors(data);
        else setSectors(null);
      })
      .catch(() => setSectors(null));
  }, [packet?.TrackOrdinal, gameId]);

  // Track sector crossings
  useEffect(() => {
    if (!packet || !sectors) return;
    const s = stateRef.current;

    // Detect new lap
    if (packet.LapNumber > s.lastLap && s.lastLap > 0) {
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

      // Record lap distance for next lap
      if (s.lapDistStart > 0) {
        const completedDist = packet.DistanceTraveled - s.lapDistStart;
        if (completedDist > 100) s.lapDistTotal = completedDist;
      }

      s.lapDistStart = packet.DistanceTraveled;
      s.currentSector = 0;
      s.sectorStartTime = 0;
      s.currentTimes = [0, 0, 0];
    }
    s.lastLap = packet.LapNumber;

    // Sector crossing detection
    if (s.lapDistTotal > 0) {
      const lapDist = packet.DistanceTraveled - s.lapDistStart;
      const frac = lapDist / s.lapDistTotal;
      const expectedSector = frac < sectors.s1End ? 0 : frac < sectors.s2End ? 1 : 2;

      if (expectedSector > s.currentSector) {
        s.currentTimes[s.currentSector] = packet.CurrentLap - s.sectorStartTime;
        s.sectorStartTime = packet.CurrentLap;
        s.currentSector = expectedSector;
      }
    }

    tick((v) => v + 1);
  }, [packet, sectors]);

  if (!packet) return null;

  const s = stateRef.current;
  const sectorNames = ["S1", "S2", "S3"];

  return (
    <div className="p-3 space-y-2">
      <div className="flex justify-between items-end mb-1">
        <div>
          <div className="text-xs text-app-text-muted uppercase tracking-wider">Current Lap</div>
          <div className="text-xl font-mono font-semibold text-app-text tabular-nums">{formatLapTime(packet.CurrentLap)}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-app-text-muted">Lap {packet.LapNumber}</div>
        </div>
      </div>

      {sectors ? (
        <div className="space-y-1.5 border-t border-app-border pt-2">
          {sectorNames.map((name, i) => {
            const current = i === s.currentSector ? packet.CurrentLap - s.sectorStartTime : s.currentTimes[i];
            const best = s.bestTimes[i] < Infinity ? s.bestTimes[i] : 0;
            const last = s.lastTimes[i];
            const isActive = i === s.currentSector;
            const isDone = i < s.currentSector && s.currentTimes[i] > 0;

            // Delta vs best
            let delta = "";
            let deltaColor = "";
            if (isDone && best > 0) {
              const diff = s.currentTimes[i] - best;
              delta = diff >= 0 ? `+${diff.toFixed(3)}` : diff.toFixed(3);
              deltaColor = diff <= 0 ? "#34d399" : "#ef4444";
            }

            return (
              <div
                key={name}
                className={`rounded px-2 py-1.5 ${isActive ? "bg-app-surface-alt/80 ring-1 ring-inset" : "bg-app-surface-alt/30"}`}
                style={isActive ? { boxShadow: `inset 0 0 0 1px ${SECTOR_COLORS[i]}40` } : {}}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: SECTOR_COLORS[i] }} />
                    <span className="text-[10px] font-semibold text-app-text-secondary">{name}</span>
                  </div>
                  <span className={`text-sm font-mono font-bold tabular-nums ${isActive ? "text-app-text" : "text-app-text"}`}>{current > 0 ? formatLapTime(current) : "--:--.---"}</span>
                </div>
                <div className="flex items-center justify-between mt-0.5">
                  <div className="flex gap-3">
                    <span className="text-[9px] text-app-text-muted">
                      Last <span className="font-mono text-app-text-secondary">{last > 0 ? formatLapTime(last) : "-"}</span>
                    </span>
                    <span className="text-[9px] text-purple-400">
                      Best <span className="font-mono">{best > 0 ? formatLapTime(best) : "-"}</span>
                    </span>
                  </div>
                  {delta && (
                    <span className="text-[9px] font-mono font-bold" style={{ color: deltaColor }}>
                      {delta}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {/* Last/Best total */}
          <div className="flex justify-between pt-1 border-t border-app-border/50">
            <span className="text-[9px] text-app-text-muted">
              Last <span className="font-mono text-app-text-secondary">{s.lastTimes[0] > 0 ? formatLapTime(s.lastTimes[0] + s.lastTimes[1] + s.lastTimes[2]) : "-"}</span>
            </span>
            <span className="text-[9px] text-purple-400">
              Best <span className="font-mono">{s.bestTimes[0] < Infinity ? formatLapTime(s.bestTimes[0] + s.bestTimes[1] + s.bestTimes[2]) : "-"}</span>
            </span>
          </div>
        </div>
      ) : (
        <div className="border-t border-app-border pt-2 text-xs text-app-text-muted">Complete a lap to see sector times</div>
      )}
    </div>
  );
}
