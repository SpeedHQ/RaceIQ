import { useState, useEffect, useRef, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";
import { formatLapTime } from "./LiveTelemetry";
import { useStatus, useTrackSectors } from "../hooks/queries";
import { getSoundEnabled } from "./Settings";

/** Play a short blip tone via Web Audio API. No audio file needed. */
function playBlip(frequency = 880, duration = 0.08) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
    // Clean up after sound finishes
    osc.onended = () => ctx.close();
  } catch {}
}

/**
 * SectorTimes — Distance-based sector split timing.
 * Forza doesn't expose sector boundaries, so we use pre-computed fractional
 * positions (s1End, s2End) from the track outline's distance analysis.
 *
 * Shows: current sector time, last/best per sector, delta to best,
 * and estimated lap time based on best sectors + current pace.
 */
export function SectorTimes({ packet }: { packet: TelemetryPacket | null }) {
  const { data: status } = useStatus();
  const trackOrd = (status as any)?.currentSession?.trackOrdinal;
  const { data: sectorsData } = useTrackSectors(trackOrd);
  const sectors = (sectorsData as any)?.s1End ? sectorsData as { s1End: number; s2End: number } : null;
  const sectorStateRef = useRef<{
    lapDistStart: number;
    lapDistTotal: number;
    currentSector: number;
    sectorStartTime: number;
    currentTimes: [number, number, number];
    bestTimes: [number, number, number];
    lastTimes: [number, number, number];
    lastLap: number;
    bestLapTime: number;
    lastLapTime: number;
  }>({
    lapDistStart: 0,
    lapDistTotal: 0,
    currentSector: 0,
    sectorStartTime: 0,
    currentTimes: [0, 0, 0],
    bestTimes: [Infinity, Infinity, Infinity],
    lastTimes: [0, 0, 0],
    lastLap: 0,
    bestLapTime: Infinity,
    lastLapTime: 0,
  });
  const [, tick] = useState(0);

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

      // Track best/last full lap time
      if (packet.LastLap > 0) {
        s.lastLapTime = packet.LastLap;
        if (packet.LastLap < s.bestLapTime) {
          s.bestLapTime = packet.LastLap;
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
      // Blip on sector change — higher pitch for later sectors
      if (getSoundEnabled()) {
        playBlip(660 + expectedSector * 220, 0.08);
      }
    }
  }, [packet, sectors]);

  if (!sectors) return null;

  const s = sectorStateRef.current;
  const sectorNames = ["S1", "S2", "S3"];
  const sectorColors = ["#ef4444", "#3b82f6", "#eab308"];

  // Compute estimated lap time:
  // Completed sectors use actual times, remaining use best times
  const hasBests = s.bestTimes[0] < Infinity && s.bestTimes[1] < Infinity && s.bestTimes[2] < Infinity;
  let estimatedLap = 0;
  if (hasBests && packet) {
    for (let i = 0; i < 3; i++) {
      if (i < s.currentSector) {
        // Completed sector — use actual time
        estimatedLap += s.currentTimes[i];
      } else if (i === s.currentSector) {
        // Current sector — use running time
        const running = packet.CurrentLap - s.sectorStartTime;
        estimatedLap += running;
        // For remaining sectors after current, use best times
      } else {
        estimatedLap += s.bestTimes[i];
      }
    }
  }

  // Delta to best lap
  const deltaToBest = hasBests && packet && packet.CurrentLap > 0 && s.bestLapTime < Infinity
    ? estimatedLap - s.bestLapTime
    : null;

  return (
    <div className="border-b border-app-border">
      <div className="p-2 border-b border-app-border">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Sectors</h2>
      </div>
      <div className="p-3">
        {/* Estimated lap time */}
        {hasBests && packet && packet.CurrentLap > 0 && (
          <div className="flex items-baseline gap-3 mb-3 pb-2 border-b border-app-border/50">
            <div>
              <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Est. Lap</div>
              <div className="text-lg font-mono font-bold text-app-text tabular-nums">
                {formatLapTime(estimatedLap)}
              </div>
            </div>
            {deltaToBest !== null && (
              <div>
                <div className="text-[10px] text-app-text-muted uppercase tracking-wider">vs Best</div>
                <div className={`text-lg font-mono font-bold tabular-nums ${deltaToBest <= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {deltaToBest <= 0 ? "" : "+"}{deltaToBest.toFixed(3)}
                </div>
              </div>
            )}
            {s.bestLapTime < Infinity && (
              <div className="ml-auto">
                <div className="text-[10px] text-purple-400 uppercase tracking-wider">Best Lap</div>
                <div className="text-sm font-mono text-purple-400 tabular-nums">{formatLapTime(s.bestLapTime)}</div>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          {sectorNames.map((name, i) => {
            const current = i === s.currentSector ? (packet ? packet.CurrentLap - s.sectorStartTime : 0) : s.currentTimes[i];
            const best = s.bestTimes[i] < Infinity ? s.bestTimes[i] : 0;
            const last = s.lastTimes[i];
            const isActive = i === s.currentSector;

            // Split delta: show for completed sectors this lap
            const showDelta = i < s.currentSector && s.currentTimes[i] > 0 && best > 0;
            const delta = showDelta ? s.currentTimes[i] - best : 0;

            return (
              <div key={name} className={`rounded p-2 ${isActive ? "bg-app-surface-alt/80 ring-1" : "bg-app-surface-alt/30"}`} style={isActive ? { ringColor: sectorColors[i] } : {}}>
                <div className="flex items-center gap-1 mb-1">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: sectorColors[i] }} />
                  <span className="text-[10px] font-semibold text-app-text-secondary">{name}</span>
                  {showDelta && (
                    <span className={`text-[9px] font-mono ml-auto font-bold ${delta <= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {delta <= 0 ? "" : "+"}{delta.toFixed(3)}
                    </span>
                  )}
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
