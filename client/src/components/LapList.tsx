import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { m } from "@/paraglide/messages";
import { useDeleteLap } from "../hooks/queries";
import { storedLapsSectorCount } from "../lib/lap-sectors";
import { useGameRoute } from "../stores/game";
import { useTelemetryStore } from "../stores/telemetry";
import { Button } from "./ui/button";
import { Table } from "./ui/AppTable";
function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

type SortKey = "lap" | "time";
type SortDir = "asc" | "desc";

export function LapList({ hasTelemetry }: { hasTelemetry?: boolean }) {
  const navigate = useNavigate({ from: "/" });
  const gameRoute = useGameRoute();
  const laps = useTelemetryStore((s) => s.sessionLaps);
  const deleteLap = useDeleteLap();
  const [sortKey, setSortKey] = useState<SortKey>("lap");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const trackOrd = useTelemetryStore((s) => s.serverStatus?.currentSession?.trackOrdinal);

  if (!hasTelemetry) {
    return null;
  }

  if (!trackOrd) {
    return <div className="p-4 text-app-text-dim text-sm">{m.laps_no_track()}</div>;
  }

  if (laps.length === 0) {
    return <div className="p-4 text-app-text-dim text-sm">{m.laps_none_recorded()}</div>;
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

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  const bestLapTime = laps.reduce((best, l) => (l.isValid && l.lapTime < best ? l.lapTime : best), Infinity);

  const sectorCount = storedLapsSectorCount(laps);
  const sectorLabels = Array.from({ length: sectorCount }, (_, index) => `S${index + 1}`);
  const completeSectorLaps = laps.filter((lap) => lap.sectorTimes?.length === sectorCount && lap.sectorTimes.every((time) => time > 0));
  const bestSectors = Array.from({ length: sectorCount }, (_, index) => (completeSectorLaps.length > 0 ? Math.min(...completeSectorLaps.map((lap) => lap.sectorTimes![index])) : Infinity));
  const avgSectors = Array.from({ length: sectorCount }, (_, index) =>
    completeSectorLaps.length > 0 ? completeSectorLaps.reduce((sum, lap) => sum + lap.sectorTimes![index], 0) / completeSectorLaps.length : 0,
  );

  // Color: purple = best, green = on/above pace, yellow = off pace
  function sectorColor(time: number, best: number, avg: number): string {
    if (best === Infinity || time <= 0) return "text-app-text-secondary";
    if (time <= best * 1.001) return "text-(--lap-pace-best)"; // best
    if (time <= avg) return "text-(--lap-pace-on-target)"; // on pace
    return "text-(--lap-pace-off-target)"; // off pace
  }

  return (
    <div className="overflow-auto">
      <Table fit tableClassName="w-full">
        <thead>
          <tr className="text-app-label text-app-text-muted uppercase tracking-wider border-b border-app-border">
            <th className="text-left p-2 cursor-pointer hover:text-app-text select-none" onClick={() => toggleSort("lap")}>
              {m.label_lap()}
              {arrow("lap")}
            </th>
            <th className="text-left p-2 cursor-pointer hover:text-app-text select-none" onClick={() => toggleSort("time")}>
              {m.label_time()}
              {arrow("time")}
            </th>
            {sectorLabels.map((label) => (
              <th key={label} className="text-left p-2">
                {label}
              </th>
            ))}
            <th className="text-center p-2">{m.laps_col_valid()}</th>
            <th className="text-right p-2">{m.label_actions()}</th>
          </tr>
        </thead>
        <tbody>
          {sortedLaps.map((lap) => {
            const hasSectors = lap.sectorTimes?.length === sectorCount && lap.sectorTimes.every((time) => time > 0);
            return (
              <tr key={lap.id} className="border-b border-app-border/50 hover:bg-app-surface-hover/30">
                <td className="p-2 font-mono text-app-text">{lap.lapNumber}</td>
                <td className={`p-2 font-mono font-bold ${lap.isValid && lap.lapTime === bestLapTime ? "text-(--lap-pace-best)" : "text-app-text"}`}>{formatLapTime(lap.lapTime)}</td>
                {sectorLabels.map((label, index) => {
                  const time = lap.sectorTimes?.[index] ?? 0;
                  return (
                    <td key={label} className={`p-2 font-mono text-app-detail font-bold ${hasSectors ? sectorColor(time, bestSectors[index], avgSectors[index]) : "text-app-text-secondary"}`}>
                      {hasSectors ? formatLapTime(time) : "-"}
                    </td>
                  );
                })}
                <td className="p-2 text-center">
                  {lap.isValid ? (
                    <span className="text-status-success">&#10003;</span>
                  ) : (
                    <span className="text-status-danger cursor-help" title={lap.invalidReason || m.laps_invalid()}>
                      &#10007;
                    </span>
                  )}
                </td>
                <td className="p-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="selected-toggle"
                      size="app-sm"
                      onClick={() => {
                        const prefix = gameRoute;
                        navigate({
                          to: `${prefix}/analyse`,
                          search: {
                            track: lap.trackOrdinal ?? undefined,
                            car: lap.carOrdinal ?? undefined,
                            lap: lap.id,
                          },
                        });
                      }}
                    >
                      {m.label_analyse()}
                    </Button>
                    <Button variant="destructive-outline" size="app-sm" onClick={() => deleteLap.mutate(lap.id)}>
                      {m.common_delete()}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
