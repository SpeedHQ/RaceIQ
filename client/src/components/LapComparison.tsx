import { useState, useEffect, useCallback } from "react";
import type { LapMeta, ComparisonData } from "@shared/types";
import { TrackMap } from "./TrackMap";
import { TelemetryChart } from "./TelemetryChart";
import { TimeDelta } from "./TimeDelta";
import { CornerTable } from "./CornerTable";

const SYNC_KEY = "lap-compare";
const COLOR_A = "#f97316"; // orange
const COLOR_B = "#3b82f6"; // blue

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

export function LapComparison() {
  const [laps, setLaps] = useState<LapMeta[]>([]);
  const [lapAId, setLapAId] = useState<number | null>(null);
  const [lapBId, setLapBId] = useState<number | null>(null);
  const [comparison, setComparison] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch lap list
  useEffect(() => {
    async function fetchLaps() {
      try {
        const res = await fetch("/api/laps");
        if (res.ok) {
          const data = await res.json();
          setLaps(data);
        }
      } catch {
        // ignore
      }
    }
    fetchLaps();
  }, []);

  // Fetch comparison when both laps selected
  const fetchComparison = useCallback(async () => {
    if (!lapAId || !lapBId || lapAId === lapBId) {
      setComparison(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/laps/${lapAId}/compare/${lapBId}`);
      if (!res.ok) {
        setError(`Failed to load comparison: ${res.statusText}`);
        setComparison(null);
        return;
      }
      const data: ComparisonData = await res.json();
      setComparison(data);
    } catch (e) {
      setError("Failed to load comparison data");
      setComparison(null);
    } finally {
      setLoading(false);
    }
  }, [lapAId, lapBId]);

  useEffect(() => {
    fetchComparison();
  }, [fetchComparison]);

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      {/* Lap Selector */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-orange-500" />
          <label className="text-xs text-slate-500 uppercase tracking-wider">Lap A</label>
          <select
            value={lapAId ?? ""}
            onChange={(e) => setLapAId(e.target.value ? Number(e.target.value) : null)}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-white font-mono focus:outline-none focus:border-orange-500"
          >
            <option value="">Select lap...</option>
            {laps.map((lap) => (
              <option key={lap.id} value={lap.id}>
                Lap {lap.lapNumber} — {formatLapTime(lap.lapTime)}
                {!lap.isValid ? " (invalid)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-blue-500" />
          <label className="text-xs text-slate-500 uppercase tracking-wider">Lap B</label>
          <select
            value={lapBId ?? ""}
            onChange={(e) => setLapBId(e.target.value ? Number(e.target.value) : null)}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-white font-mono focus:outline-none focus:border-blue-500"
          >
            <option value="">Select lap...</option>
            {laps.map((lap) => (
              <option key={lap.id} value={lap.id}>
                Lap {lap.lapNumber} — {formatLapTime(lap.lapTime)}
                {!lap.isValid ? " (invalid)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="text-slate-500 text-sm">Loading comparison data...</div>
      )}
      {error && (
        <div className="text-red-400 text-sm">{error}</div>
      )}

      {/* No selection prompt */}
      {!lapAId || !lapBId ? (
        <div className="flex-1 flex items-center justify-center text-slate-600 text-sm">
          Select two laps above to compare
        </div>
      ) : lapAId === lapBId ? (
        <div className="flex-1 flex items-center justify-center text-slate-600 text-sm">
          Select two different laps to compare
        </div>
      ) : comparison ? (
        <div className="flex flex-col gap-4">
          {/* Track Maps */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-slate-900 rounded-lg border border-slate-800 overflow-hidden">
              <div className="px-3 py-2 border-b border-slate-800">
                <span className="text-xs text-slate-500 uppercase tracking-wider">
                  Lap A — {formatLapTime(comparison.lapA.lapTime)}
                </span>
              </div>
              <div className="h-[250px]">
                <TrackMap
                  telemetry={comparison.telemetryA}
                  colorBy="speed"
                />
              </div>
            </div>
            <div className="bg-slate-900 rounded-lg border border-slate-800 overflow-hidden">
              <div className="px-3 py-2 border-b border-slate-800">
                <span className="text-xs text-slate-500 uppercase tracking-wider">
                  Lap B — {formatLapTime(comparison.lapB.lapTime)}
                </span>
              </div>
              <div className="h-[250px]">
                <TrackMap
                  telemetry={comparison.telemetryB}
                  colorBy="speed"
                />
              </div>
            </div>
          </div>

          {/* Time Delta */}
          <div className="bg-slate-900 rounded-lg border border-slate-800 p-3">
            <TimeDelta
              distances={comparison.traces.distance}
              timeDelta={comparison.timeDelta}
              syncKey={SYNC_KEY}
              height={140}
            />
          </div>

          {/* Speed Chart */}
          <div className="bg-slate-900 rounded-lg border border-slate-800 p-3">
            <TelemetryChart
              data={{
                distance: comparison.traces.distance,
                values: [comparison.traces.speedA, comparison.traces.speedB],
                labels: ["Speed A (mph)", "Speed B (mph)"],
                colors: [COLOR_A, COLOR_B],
              }}
              syncKey={SYNC_KEY}
              height={200}
              title="Speed"
            />
          </div>

          {/* Throttle + Brake Chart */}
          <div className="bg-slate-900 rounded-lg border border-slate-800 p-3">
            <TelemetryChart
              data={{
                distance: comparison.traces.distance,
                values: [
                  comparison.traces.throttleA,
                  comparison.traces.throttleB,
                  comparison.traces.brakeA,
                  comparison.traces.brakeB,
                ],
                labels: ["Throttle A", "Throttle B", "Brake A", "Brake B"],
                colors: [COLOR_A, COLOR_B, "#f97316aa", "#3b82f6aa"],
              }}
              syncKey={SYNC_KEY}
              height={180}
              title="Throttle & Brake"
            />
          </div>

          {/* RPM Chart */}
          <div className="bg-slate-900 rounded-lg border border-slate-800 p-3">
            <TelemetryChart
              data={{
                distance: comparison.traces.distance,
                values: [comparison.traces.rpmA, comparison.traces.rpmB],
                labels: ["RPM A", "RPM B"],
                colors: [COLOR_A, COLOR_B],
              }}
              syncKey={SYNC_KEY}
              height={180}
              title="RPM"
            />
          </div>

          {/* Corner Table */}
          {comparison.corners.length > 0 && (
            <div className="bg-slate-900 rounded-lg border border-slate-800 overflow-hidden">
              <div className="px-3 py-2 border-b border-slate-800">
                <span className="text-xs text-slate-500 uppercase tracking-wider">
                  Corner-by-Corner Delta
                </span>
              </div>
              <CornerTable corners={comparison.corners} />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
