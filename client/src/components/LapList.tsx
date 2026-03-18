import { useEffect, useState, useCallback } from "react";
import type { LapMeta } from "@shared/types";
import { ExportButton } from "./ExportButton";

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

export function LapList() {
  const [laps, setLaps] = useState<LapMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLaps = useCallback(async () => {
    try {
      const res = await fetch("/api/laps");
      if (res.ok) {
        const data = await res.json();
        setLaps(data);
      }
    } catch {
      // server not ready yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLaps();
    const interval = setInterval(fetchLaps, 5000);
    return () => clearInterval(interval);
  }, [fetchLaps]);

  async function handleDelete(id: number) {
    try {
      const res = await fetch(`/api/laps/${id}`, { method: "DELETE" });
      if (res.ok) {
        setLaps((prev) => prev.filter((l) => l.id !== id));
      }
    } catch {
      // ignore
    }
  }

  if (loading) {
    return <div className="p-4 text-slate-600">Loading laps...</div>;
  }

  if (laps.length === 0) {
    return (
      <div className="p-4 text-slate-600 text-sm">
        No laps recorded yet. Start driving in Forza to record telemetry.
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-slate-800">
            <th className="text-left p-2">Lap</th>
            <th className="text-left p-2">Time</th>
            <th className="text-left p-2">Car</th>
            <th className="text-center p-2">Valid</th>
            <th className="text-right p-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {laps.map((lap) => (
            <tr key={lap.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
              <td className="p-2 font-mono text-slate-300">{lap.lapNumber}</td>
              <td className="p-2 font-mono text-white">{formatLapTime(lap.lapTime)}</td>
              <td className="p-2 font-mono text-slate-400">#{lap.carOrdinal ?? "?"}</td>
              <td className="p-2 text-center">
                {lap.isValid ? (
                  <span className="text-emerald-400">&#10003;</span>
                ) : (
                  <span className="text-red-400">&#10007;</span>
                )}
              </td>
              <td className="p-2 text-right">
                <div className="flex items-center justify-end gap-2">
                  <ExportButton lapId={lap.id} />
                  <button
                    onClick={() => handleDelete(lap.id)}
                    className="px-2 py-1 text-xs rounded bg-slate-700 hover:bg-red-600 text-slate-300 hover:text-white transition-colors"
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
