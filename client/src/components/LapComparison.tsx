import { useState, useEffect, useCallback } from "react";
import type { LapMeta, ComparisonData } from "@shared/types";
import { TrackMap } from "./TrackMap";
import { TelemetryChart } from "./TelemetryChart";
import { TimeDelta } from "./TimeDelta";
import { CornerTable } from "./CornerTable";
import { speedLabel } from "../lib/speed";
import { useTelemetry } from "../context/telemetry";

const SYNC_KEY = "lap-compare";
const COLOR_A = "#f97316"; // orange
const COLOR_B = "#3b82f6"; // blue

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

interface TrackGroup {
  trackOrdinal: number;
  trackName: string;
  laps: LapMeta[];
}

export function LapComparison() {
  const { displaySettings } = useTelemetry();
  const [laps, setLaps] = useState<LapMeta[]>([]);
  const [trackGroups, setTrackGroups] = useState<TrackGroup[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  const [carAOrd, setCarAOrd] = useState<number | null>(null);
  const [carBOrd, setCarBOrd] = useState<number | null>(null);
  const [lapAId, setLapAId] = useState<number | null>(null);
  const [lapBId, setLapBId] = useState<number | null>(null);
  const [comparison, setComparison] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [carNames, setCarNames] = useState<Map<number, string>>(new Map());

  // Fetch lap list and group by track
  useEffect(() => {
    async function fetchLaps() {
      try {
        const res = await fetch("/api/laps");
        if (!res.ok) return;
        const data: LapMeta[] = await res.json();
        const validLaps = data.filter((l) => l.lapTime > 0 && l.trackOrdinal);
        setLaps(validLaps);

        // Group by track
        const byTrack = new Map<number, LapMeta[]>();
        for (const lap of validLaps) {
          const t = lap.trackOrdinal!;
          if (!byTrack.has(t)) byTrack.set(t, []);
          byTrack.get(t)!.push(lap);
        }

        // Fetch track names
        const groups: TrackGroup[] = [];
        for (const [ordinal, trackLaps] of byTrack) {
          let name = `Track ${ordinal}`;
          try {
            const r = await fetch(`/api/track-name/${ordinal}`);
            if (r.ok) name = await r.text();
          } catch {}
          groups.push({ trackOrdinal: ordinal, trackName: name, laps: trackLaps });
        }
        groups.sort((a, b) => a.trackName.localeCompare(b.trackName));
        setTrackGroups(groups);

        // Fetch car names for unique car ordinals
        const carOrds = new Set(validLaps.map((l) => l.carOrdinal).filter((c): c is number => c != null));
        const names = new Map<number, string>();
        await Promise.all(
          Array.from(carOrds).map(async (ord) => {
            try {
              const r = await fetch(`/api/car-name/${ord}`);
              if (r.ok) names.set(ord, await r.text());
            } catch {}
          })
        );
        setCarNames(names);
      } catch {}
    }
    fetchLaps();
  }, []);

  // Reset car/lap selections when track changes
  useEffect(() => {
    setCarAOrd(null);
    setCarBOrd(null);
    setLapAId(null);
    setLapBId(null);
    setComparison(null);
  }, [selectedTrack]);

  // Reset lap A when car A changes
  useEffect(() => {
    setLapAId(null);
    setComparison(null);
  }, [carAOrd]);

  // Reset lap B when car B changes
  useEffect(() => {
    setLapBId(null);
    setComparison(null);
  }, [carBOrd]);

  // Laps filtered to selected track
  const trackLaps = selectedTrack != null
    ? (trackGroups.find((g) => g.trackOrdinal === selectedTrack)?.laps ?? [])
    : [];

  // Unique cars on this track
  const trackCars = Array.from(new Set(trackLaps.map((l) => l.carOrdinal).filter((c): c is number => c != null)));

  // Laps filtered by car
  const carALaps = trackLaps.filter((l) => l.carOrdinal === carAOrd);
  const carBLaps = trackLaps.filter((l) => l.carOrdinal === carBOrd);

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
      {/* Selectors: Track → Car A → Lap A → Car B → Lap B */}
      <div className="flex items-start gap-4 flex-wrap">
        {/* Track selector */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-500 uppercase tracking-wider">Track</label>
          <select
            value={selectedTrack ?? ""}
            onChange={(e) => setSelectedTrack(e.target.value ? Number(e.target.value) : null)}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-cyan-400 min-w-[200px]"
          >
            <option value="">Select track...</option>
            {trackGroups.map((g) => (
              <option key={g.trackOrdinal} value={g.trackOrdinal}>
                {g.trackName} ({g.laps.length} laps)
              </option>
            ))}
          </select>
        </div>

        {/* Car A */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-orange-500" />
            <label className="text-[10px] text-slate-500 uppercase tracking-wider">Car A</label>
          </div>
          <select
            value={carAOrd ?? ""}
            onChange={(e) => setCarAOrd(e.target.value ? Number(e.target.value) : null)}
            disabled={!selectedTrack}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 disabled:opacity-50 min-w-[200px]"
          >
            <option value="">Select car...</option>
            {trackCars.map((ord) => (
              <option key={ord} value={ord}>
                {carNames.get(ord) || `Car ${ord}`}
              </option>
            ))}
          </select>
        </div>

        {/* Lap A */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-500 uppercase tracking-wider">Lap A</label>
          <select
            value={lapAId ?? ""}
            onChange={(e) => setLapAId(e.target.value ? Number(e.target.value) : null)}
            disabled={!carAOrd}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-orange-500 disabled:opacity-50 min-w-[180px]"
          >
            <option value="">Select lap...</option>
            {carALaps.map((lap) => (
              <option key={lap.id} value={lap.id}>
                Lap {lap.lapNumber} — {formatLapTime(lap.lapTime)}
                {!lap.isValid ? " (inv)" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Car B */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
            <label className="text-[10px] text-slate-500 uppercase tracking-wider">Car B</label>
          </div>
          <select
            value={carBOrd ?? ""}
            onChange={(e) => setCarBOrd(e.target.value ? Number(e.target.value) : null)}
            disabled={!selectedTrack}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50 min-w-[200px]"
          >
            <option value="">Select car...</option>
            {trackCars.map((ord) => (
              <option key={ord} value={ord}>
                {carNames.get(ord) || `Car ${ord}`}
              </option>
            ))}
          </select>
        </div>

        {/* Lap B */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-500 uppercase tracking-wider">Lap B</label>
          <select
            value={lapBId ?? ""}
            onChange={(e) => setLapBId(e.target.value ? Number(e.target.value) : null)}
            disabled={!carBOrd}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50 min-w-[180px]"
          >
            <option value="">Select lap...</option>
            {carBLaps.map((lap) => (
              <option key={lap.id} value={lap.id}>
                Lap {lap.lapNumber} — {formatLapTime(lap.lapTime)}
                {!lap.isValid ? " (inv)" : ""}
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
      ) : comparison?.traces?.distance ? (
        <div className="flex flex-col gap-4">
          {/* Track Maps — racing line colored by speed */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-slate-900 rounded-lg border border-slate-800 overflow-hidden">
              <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider" style={{ color: COLOR_A }}>
                  {carNames.get(comparison.lapA.carOrdinal!) || "Car A"} — Lap {comparison.lapA.lapNumber}
                </span>
                <span className="text-xs font-mono text-slate-400">{formatLapTime(comparison.lapA.lapTime)}</span>
              </div>
              <div className="h-[250px]">
                <TrackMap
                  telemetry={comparison.telemetryA}
                  colorBy="speed"
                />
              </div>
            </div>
            <div className="bg-slate-900 rounded-lg border border-slate-800 overflow-hidden">
              <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider" style={{ color: COLOR_B }}>
                  {carNames.get(comparison.lapB.carOrdinal!) || "Car B"} — Lap {comparison.lapB.lapNumber}
                </span>
                <span className="text-xs font-mono text-slate-400">{formatLapTime(comparison.lapB.lapTime)}</span>
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
                labels: [`Speed A (${speedLabel(displaySettings.speedUnit)})`, `Speed B (${speedLabel(displaySettings.speedUnit)})`],
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

          {/* Tire Wear Chart */}
          {comparison.traces.tireWearA && (
            <div className="bg-slate-900 rounded-lg border border-slate-800 p-3">
              <TelemetryChart
                data={{
                  distance: comparison.traces.distance,
                  values: [comparison.traces.tireWearA, comparison.traces.tireWearB],
                  labels: ["Tire Wear A (%)", "Tire Wear B (%)"],
                  colors: [COLOR_A, COLOR_B],
                }}
                syncKey={SYNC_KEY}
                height={160}
                title="Tire Wear (avg all 4)"
              />
            </div>
          )}

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
