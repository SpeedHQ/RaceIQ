import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useLaps, useDeleteLap } from "../hooks/queries";
import { useGameRoute, useGameId } from "../stores/game";
import { client } from "../lib/rpc";
import { Button } from "./ui/button";

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

type SortKey = "lap" | "time";
type SortDir = "asc" | "desc";

export function LapList({ trackOrd, hasTelemetry }: { trackOrd?: number; hasTelemetry?: boolean }) {
  const navigate = useNavigate({ from: "/" });
  const gameRoute = useGameRoute();
  const gameId = useGameId();
  const { data: allLaps = [], isLoading } = useLaps({ refetchInterval: 5_000 });
  const deleteLap = useDeleteLap();
  const [sortKey, setSortKey] = useState<SortKey>("lap");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Fetch sector times for all laps on this track
  const { data: sectorTimes } = useQuery({
    queryKey: ["track-lap-sectors", trackOrd, gameId],
    queryFn: () => client.api.tracks[":ordinal"]["lap-sectors"].$get({ param: { ordinal: String(trackOrd!) }, query: { gameId: gameId ?? undefined } }).then((r) => r.json() as unknown as Record<number, { s1: number; s2: number; s3: number }>),
    enabled: trackOrd != null && trackOrd > 0,
  });

  // Filter laps to current track only
  const laps = trackOrd != null
    ? allLaps.filter((l) => l.trackOrdinal === trackOrd)
    : allLaps;

  if (isLoading) {
    return <div className="p-4 text-app-text-dim">Loading laps...</div>;
  }

  if (!hasTelemetry) {
    return null;
  }

  if (!trackOrd) {
    return (
      <div className="p-4 text-app-text-dim text-sm">
        No track detected. Start driving to identify the track and view recorded laps.
      </div>
    );
  }

  if (laps.length === 0) {
    return (
      <div className="p-4 text-app-text-dim text-sm">
        No laps recorded yet. Start driving to record telemetry.
      </div>
    );
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "time" ? "asc" : "desc");
    }
  };

  const sortedLaps = [...laps].sort((a, b) => {
    const valA = sortKey === "lap" ? a.lapNumber : a.lapTime;
    const valB = sortKey === "lap" ? b.lapNumber : b.lapTime;
    return sortDir === "asc" ? valA - valB : valB - valA;
  });

  const arrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const bestLapTime = laps.reduce((best, l) => (l.isValid && l.lapTime < best ? l.lapTime : best), Infinity);

  // Compute best sector times across all laps
  const bestSectors = { s1: Infinity, s2: Infinity, s3: Infinity };
  const avgSectors = { s1: 0, s2: 0, s3: 0, count: 0 };
  if (sectorTimes) {
    for (const st of Object.values(sectorTimes as Record<string, { s1: number; s2: number; s3: number }>)) {
      if (st.s1 > 0 && st.s1 < bestSectors.s1) bestSectors.s1 = st.s1;
      if (st.s2 > 0 && st.s2 < bestSectors.s2) bestSectors.s2 = st.s2;
      if (st.s3 > 0 && st.s3 < bestSectors.s3) bestSectors.s3 = st.s3;
      if (st.s1 > 0 && st.s2 > 0 && st.s3 > 0) {
        avgSectors.s1 += st.s1;
        avgSectors.s2 += st.s2;
        avgSectors.s3 += st.s3;
        avgSectors.count++;
      }
    }
    if (avgSectors.count > 0) {
      avgSectors.s1 /= avgSectors.count;
      avgSectors.s2 /= avgSectors.count;
      avgSectors.s3 /= avgSectors.count;
    }
  }

  // Color: purple = best, green = on/above pace, yellow = off pace
  function sectorColor(time: number, best: number, avg: number): string {
    if (best === Infinity || time <= 0) return "text-app-text-secondary";
    if (time <= best * 1.001) return "text-purple-400"; // best
    if (time <= avg) return "text-emerald-400"; // on pace
    return "text-orange-400"; // off pace
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-app-text-muted uppercase tracking-wider border-b border-app-border">
            <th className="text-left p-2 cursor-pointer hover:text-app-text select-none" onClick={() => toggleSort("lap")}>
              Lap{arrow("lap")}
            </th>
            <th className="text-left p-2 cursor-pointer hover:text-app-text select-none" onClick={() => toggleSort("time")}>
              Time{arrow("time")}
            </th>
            <th className="text-left p-2"><span className="text-red-400">S1</span></th>
            <th className="text-left p-2"><span className="text-blue-400">S2</span></th>
            <th className="text-left p-2"><span className="text-yellow-400">S3</span></th>
            <th className="text-center p-2">Valid</th>
            <th className="text-right p-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sortedLaps.map((lap) => {
            const st = sectorTimes?.[lap.id];
            return (
            <tr key={lap.id} className="border-b border-app-border/50 hover:bg-app-surface-alt/30">
              <td className="p-2 font-mono text-app-text">{lap.lapNumber}</td>
              <td className={`p-2 font-mono font-bold ${lap.isValid && lap.lapTime === bestLapTime ? "text-purple-400" : "text-app-text"}`}>{formatLapTime(lap.lapTime)}</td>
              <td className={`p-2 font-mono text-xs font-bold ${st ? sectorColor(st.s1, bestSectors.s1, avgSectors.s1) : "text-app-text-secondary"}`}>{st ? formatLapTime(st.s1) : "-"}</td>
              <td className={`p-2 font-mono text-xs font-bold ${st ? sectorColor(st.s2, bestSectors.s2, avgSectors.s2) : "text-app-text-secondary"}`}>{st ? formatLapTime(st.s2) : "-"}</td>
              <td className={`p-2 font-mono text-xs font-bold ${st ? sectorColor(st.s3, bestSectors.s3, avgSectors.s3) : "text-app-text-secondary"}`}>{st ? formatLapTime(st.s3) : "-"}</td>
              <td className="p-2 text-center">
                {lap.isValid ? (
                  <span className="text-emerald-400">&#10003;</span>
                ) : (
                  <span className="text-red-400">&#10007;</span>
                )}
              </td>
              <td className="p-2 text-right">
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="app-outline"
                    size="app-sm"
                    className="bg-cyan-900/50 !border-cyan-700 text-app-accent hover:bg-cyan-900/70"
                    onClick={() => {
                      const prefix = gameRoute;
                      navigate({
                        to: `${prefix}/analyse`,
                        search: {
                          track: lap.trackOrdinal ?? undefined,
                          car: lap.carOrdinal ?? undefined,
                          lap: lap.id,
                        }
                      });
                    }}
                  >
                    Analyse
                  </Button>
                  <Button
                    variant="app-ghost"
                    size="app-sm"
                    className="hover:text-red-400"
                    onClick={() => deleteLap.mutate(lap.id)}
                  >
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
