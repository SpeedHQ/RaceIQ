import { useState, useEffect, useRef } from "react";
import type { LapMeta } from "@shared/types";
import { useNavigate } from "@tanstack/react-router";
import { useLaps, useDeleteLap } from "../hooks/queries";
import { api } from "../lib/api";

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

type SortKey = "lap" | "time";
type SortDir = "asc" | "desc";

export function LapList() {
  const navigate = useNavigate({ from: "/" });
  const { data: laps = [], isLoading } = useLaps();
  const deleteLap = useDeleteLap();
  const [carNames, setCarNames] = useState<Record<number, string>>({});
  const fetchedOrdinals = useRef(new Set<number>());
  const [sortKey, setSortKey] = useState<SortKey>("lap");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Fetch car names for any new ordinals
  useEffect(() => {
    const ordinals = [...new Set(laps.map((l) => l.carOrdinal).filter((o): o is number => o != null))];
    const newOrdinals = ordinals.filter((o) => !fetchedOrdinals.current.has(o));
    if (newOrdinals.length === 0) return;

    for (const ord of newOrdinals) {
      fetchedOrdinals.current.add(ord);
      api.getCarName(ord)
        .then((name) => setCarNames((prev) => ({ ...prev, [ord]: name })))
        .catch(() => setCarNames((prev) => ({ ...prev, [ord]: `Car #${ord}` })));
    }
  }, [laps]);

  if (isLoading) {
    return <div className="p-4 text-app-text-dim">Loading laps...</div>;
  }

  if (laps.length === 0) {
    return (
      <div className="p-4 text-app-text-dim text-sm">
        No laps recorded yet. Start driving in Forza to record telemetry.
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
            <th className="text-left p-2">Car</th>
            <th className="text-center p-2">Valid</th>
            <th className="text-right p-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sortedLaps.map((lap) => (
            <tr key={lap.id} className="border-b border-app-border/50 hover:bg-app-surface-alt/30">
              <td className="p-2 font-mono text-app-text">{lap.lapNumber}</td>
              <td className="p-2 font-mono text-app-text">{formatLapTime(lap.lapTime)}</td>
              <td className="p-2 text-app-text-secondary truncate max-w-[160px]" title={lap.carOrdinal != null ? carNames[lap.carOrdinal] ?? `#${lap.carOrdinal}` : "?"}>
                {lap.carOrdinal != null ? carNames[lap.carOrdinal] ?? `#${lap.carOrdinal}` : "?"}
              </td>
              <td className="p-2 text-center">
                {lap.isValid ? (
                  <span className="text-emerald-400">&#10003;</span>
                ) : (
                  <span className="text-red-400">&#10007;</span>
                )}
              </td>
              <td className="p-2 text-right">
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => navigate({
                      to: "/analyse",
                      search: {
                        track: lap.trackOrdinal ?? undefined,
                        car: lap.carOrdinal ?? undefined,
                        lap: lap.id,
                      }
                    })}
                    className="px-2 py-1 text-xs rounded bg-purple-600 hover:bg-purple-500 text-white transition-colors"
                  >
                    Analyze
                  </button>
                  <button
                    onClick={() => deleteLap.mutate(lap.id)}
                    className="px-2 py-1 text-xs rounded bg-slate-700 hover:bg-red-600 text-app-text hover:text-app-text transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
