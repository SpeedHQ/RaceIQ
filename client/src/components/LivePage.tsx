import { useState, useEffect, useRef } from "react";
import { useTelemetry } from "../context/telemetry";
import { LiveTelemetry, formatLapTime } from "./LiveTelemetry";
import { CurrentLapStats } from "./CurrentLapStats";
import { LiveTrackMap } from "./LiveTrackMap";
import { LapList } from "./LapList";
import { LapTimeChart } from "./LapTimeChart";
import { SectorTimes } from "./SectorTimes";

export function LivePage() {
  const { packet } = useTelemetry();
  const [trackName, setTrackName] = useState("");
  const lastTrackFetchRef = useRef<number | null>(null);

  useEffect(() => {
    if (!packet) return;
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

        <SectorTimes packet={packet} />
        <LapTimeChart packet={packet} />

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
  );
}
