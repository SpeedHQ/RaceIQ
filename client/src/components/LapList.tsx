import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { m } from "@/paraglide/messages";
import { useDeleteLap } from "../hooks/queries";
import { storedLapsSectorCount } from "../lib/lap-sectors";
import { useGameRoute } from "../stores/game";
import { useTelemetryStore } from "../stores/telemetry";
import { Button } from "./ui/button";
import { Table, TBody, TD, TH, THead, TRow } from "./ui/AppTable";
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
      <Table fit>
        <THead>
          <TH onClick={() => toggleSort("lap")}>
            {m.label_lap()}
            {arrow("lap")}
          </TH>
          <TH onClick={() => toggleSort("time")}>
            {m.label_time()}
            {arrow("time")}
          </TH>
          {sectorLabels.map((label) => (
            <TH key={label}>{label}</TH>
          ))}
          <TH align="center">{m.laps_col_valid()}</TH>
          <TH align="end">{m.label_actions()}</TH>
        </THead>
        <TBody>
          {sortedLaps.map((lap) => {
            const hasSectors = lap.sectorTimes?.length === sectorCount && lap.sectorTimes.every((time) => time > 0);
            return (
              <TRow key={lap.id}>
                <TD numeric tone="primary">
                  {lap.lapNumber}
                </TD>
                <TD emphasis numeric tone={lap.isValid && lap.lapTime === bestLapTime ? "best" : "primary"}>
                  {formatLapTime(lap.lapTime)}
                </TD>
                {sectorLabels.map((label, index) => {
                  const time = lap.sectorTimes?.[index] ?? 0;
                  return (
                    <TD key={label} emphasis numeric>
                      <span className={hasSectors ? sectorColor(time, bestSectors[index], avgSectors[index]) : undefined}>
                        {hasSectors ? formatLapTime(time) : "-"}
                      </span>
                    </TD>
                  );
                })}
                <TD align="center">
                  {lap.isValid ? (
                    <span className="text-status-success">&#10003;</span>
                  ) : (
                    <span className="text-status-danger cursor-help" title={lap.invalidReason || m.laps_invalid()}>
                      &#10007;
                    </span>
                  )}
                </TD>
                <TD align="end">
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
                </TD>
              </TRow>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
