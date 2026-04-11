import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import type { LapMeta, ComparisonData } from "@shared/types";
import { TelemetryChart } from "./TelemetryChart";
import { TimeDelta } from "./TimeDelta";
import { useUnits } from "../hooks/useUnits";
import { useLaps, useTrackOutline, useTrackSectors } from "../hooks/queries";
import { client } from "../lib/rpc";
import { useGameId } from "../stores/game";
import { SearchSelect } from "./ui/SearchSelect";
import { CompareTrackMap, type SegmentTiming } from "./comparison/CompareTrackMap";
import { CompareAiSidebar } from "./comparison/CompareAiSidebar";
import type { CompareAiPanelHandle } from "./comparison/CompareAiPanel";
import { COLOR_A, COLOR_B, formatLapTime, type Point } from "../lib/comparison-utils";
import { Sparkles } from "lucide-react";
import { Button } from "./ui/button";

const SYNC_KEY = "lap-compare";

interface TrackGroup {
  trackOrdinal: number;
  trackName: string;
  laps: LapMeta[];
}

export function LapComparison() {
  const search = useSearch({ strict: false }) as { track?: number; carA?: number; carB?: number; lapA?: number; lapB?: number; cursor?: number };
  const navigate = useNavigate();
  const units = useUnits();
  const gameId = useGameId();
  const { data: allLaps = [] } = useLaps();
  const laps = useMemo(() => allLaps.filter((l) => l.lapTime > 0 && l.trackOrdinal), [allLaps]);
  const [trackGroups, setTrackGroups] = useState<TrackGroup[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(search.track ?? null);
  const [carAOrd, setCarAOrd] = useState<number | null>(search.carA ?? null);
  const [carBOrd, setCarBOrd] = useState<number | null>(search.carB ?? null);
  const [lapAId, setLapAId] = useState<number | null>(search.lapA ?? null);
  const [lapBId, setLapBId] = useState<number | null>(search.lapB ?? null);
  const [comparison, setComparison] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [carNames, setCarNames] = useState<Map<number, string>>(new Map());
  const { data: outlineData } = useTrackOutline(selectedTrack ?? undefined);
  const trackOutline = useMemo(() => {
    if (!outlineData) return null;
    const d = outlineData as { points?: Point[] } | Point[];
    if (!Array.isArray(d) && d?.points && Array.isArray(d.points)) return d.points;
    if (Array.isArray(d)) return d;
    return null;
  }, [outlineData]);
  const { data: sectorsData } = useTrackSectors(selectedTrack ?? undefined);
  const trackSegments = useMemo((): { type: string; name: string; startFrac: number; endFrac: number }[] | null => {
    const s = sectorsData as { segments?: { type: string; name: string; startFrac: number; endFrac: number }[] } | undefined;
    return s?.segments ?? null;
  }, [sectorsData]);
  const prevTrackRef = useRef<number | null | undefined>(undefined);
  const prevCarARef = useRef<number | null | undefined>(undefined);
  const prevCarBRef = useRef<number | null | undefined>(undefined);
  const hoveredDistanceRef = useRef<number | null>(null);
  const mapRedrawRef = useRef<(() => void) | null>(null);
  const aiPanelRef = useRef<CompareAiPanelHandle | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("compare-ai-panel-open") === "1"; } catch { return false; }
  });
  const toggleAiPanel = useCallback(() => {
    setAiPanelOpen((v) => {
      const next = !v;
      try { localStorage.setItem("compare-ai-panel-open", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const handleCursorMove = useCallback((d: number | null) => {
    hoveredDistanceRef.current = d;
    // Directly redraw the map canvas without React re-render
    mapRedrawRef.current?.();
  }, []);

  // Set cursor from URL param once comparison data loads
  const appliedInitialCursor = useRef(false);
  useEffect(() => {
    if (appliedInitialCursor.current) return;
    if (search.cursor != null && comparison?.traces?.distance) {
      const distances = comparison.traces.distance;
      const idx = Math.min(search.cursor, distances.length - 1);
      hoveredDistanceRef.current = distances[idx];
      mapRedrawRef.current?.();
      appliedInitialCursor.current = true;
    }
  }, [search.cursor, comparison]);

  // Sync selections to URL
  useEffect(() => {
    navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        track: selectedTrack ?? undefined,
        carA: carAOrd ?? undefined,
        carB: carBOrd ?? undefined,
        lapA: lapAId ?? undefined,
        lapB: lapBId ?? undefined,
      }) as never,
      replace: true,
      resetScroll: false,
    });
  }, [selectedTrack, carAOrd, carBOrd, lapAId, lapBId, navigate]);

  // Build track groups and fetch names when laps data changes
  useEffect(() => {
    if (laps.length === 0) return;
    let cancelled = false;

    async function buildGroups() {
      const byTrack = new Map<number, LapMeta[]>();
      for (const lap of laps) {
        const t = lap.trackOrdinal!;
        if (!byTrack.has(t)) byTrack.set(t, []);
        byTrack.get(t)!.push(lap);
      }

      const groups: TrackGroup[] = [];
      for (const [ordinal, trackLaps] of byTrack) {
        let name = `Track ${ordinal}`;
        try { name = await client.api["track-name"][":ordinal"].$get({ param: { ordinal: String(ordinal) }, query: { gameId: gameId! } }).then((r) => r.ok ? r.text() : name); } catch {}
        groups.push({ trackOrdinal: ordinal, trackName: name, laps: trackLaps });
      }
      groups.sort((a, b) => a.trackName.localeCompare(b.trackName));

      const carOrds = new Set<number>(laps.map((l) => l.carOrdinal).filter((c): c is number => c != null));
      const names = new Map<number, string>();
      await Promise.all(
        Array.from(carOrds).map(async (ord) => {
          try { names.set(ord, await client.api["car-name"][":ordinal"].$get({ param: { ordinal: String(ord) }, query: { gameId: gameId! } }).then((r) => r.ok ? r.text() : "")); } catch {}
        })
      );

      if (!cancelled) {
        setTrackGroups(groups);
        setCarNames(names);
      }
    }
    buildGroups();
    return () => { cancelled = true; };
  }, [laps, gameId]);

  // Reset car/lap selections when track changes (skip initial mount to preserve URL params)
  useEffect(() => {
    if (prevTrackRef.current === undefined) {
      prevTrackRef.current = selectedTrack;
    } else if (prevTrackRef.current !== selectedTrack) {
      prevTrackRef.current = selectedTrack;
      setCarAOrd(null);
      setCarBOrd(null);
      setLapAId(null);
      setLapBId(null);
      setComparison(null);
    }
  }, [selectedTrack]);

  // Reset lap A when car A changes, default car B to same
  useEffect(() => {
    if (prevCarARef.current === undefined) {
      prevCarARef.current = carAOrd;
    } else if (prevCarARef.current !== carAOrd) {
      prevCarARef.current = carAOrd;
      setLapAId(null);
      setComparison(null);
      if (carAOrd != null && carBOrd == null) {
        setCarBOrd(carAOrd);
      }
    }
  }, [carAOrd]);

  // Reset lap B when car B changes
  useEffect(() => {
    if (prevCarBRef.current === undefined) {
      prevCarBRef.current = carBOrd;
    } else if (prevCarBRef.current !== carBOrd) {
      prevCarBRef.current = carBOrd;
      setLapBId(null);
      setComparison(null);
    }
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
      const data = await client.api.laps[":id1"].compare[":id2"].$get({ param: { id1: String(lapAId), id2: String(lapBId) } }).then((r) => r.json() as unknown as ComparisonData);
      setComparison(data);
    } catch {
      setError("Failed to load comparison data");
      setComparison(null);
    } finally {
      setLoading(false);
    }
  }, [lapAId, lapBId]);

  useEffect(() => {
    fetchComparison();
  }, [fetchComparison]);

  // Synthetic outline fallback: use telemetryA world positions when no track
  // outline exists. Keeps CompareTrackMap's Overview/Zoomed layout rendering
  // at the same dimensions for games without track edge data (e.g. ACC).
  const syntheticOutline = useMemo<Point[]>(() => {
    if (!comparison) return [];
    const tel = comparison.telemetryA;
    if (!tel || tel.length < 2) return [];
    const step = Math.max(1, Math.floor(tel.length / 400));
    const out: Point[] = [];
    for (let i = 0; i < tel.length; i += step) {
      out.push({ x: tel[i].PositionX, z: tel[i].PositionZ });
    }
    return out;
  }, [comparison]);

  // Compute per-segment times for both laps
  const segmentTimings = useMemo((): SegmentTiming[] => {
    if (!trackSegments || trackSegments.length === 0 || !comparison) return [];
    const telA = comparison.telemetryA;
    const telB = comparison.telemetryB;
    if (telA.length < 10 || telB.length < 10) return [];

    let sNum = 1;
    return trackSegments.map((seg) => {
      const displayName = (seg.type === "straight" && (!seg.name || /^S[\d?]*$/.test(seg.name)))
        ? `S${sNum++}`
        : (seg.type === "straight" ? (sNum++, seg.name) : seg.name);

      const computeTime = (tel: typeof telA) => {
        const n = tel.length;
        const startIdx = Math.round(seg.startFrac * (n - 1));
        const endIdx = Math.min(Math.round(seg.endFrac * (n - 1)), n - 1);
        const startTime = tel[startIdx]?.CurrentLap ?? 0;
        const endTime = tel[endIdx]?.CurrentLap ?? 0;
        return Math.round((endTime - startTime) * 1000) / 1000;
      };

      return {
        name: displayName,
        type: seg.type as "corner" | "straight",
        timeA: computeTime(telA),
        timeB: computeTime(telB),
        startFrac: seg.startFrac,
        endFrac: seg.endFrac,
      };
    });
  }, [trackSegments, comparison]);

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-hidden">
      {/* Selectors: Track → Car A → Lap A → Car B → Lap B */}
      <div className="flex items-start gap-3 shrink-0">
        {/* Track selector */}
        <div className="flex flex-col gap-1 flex-1 min-w-[140px] max-w-[260px]">
          <label className="text-[10px] text-app-text-muted uppercase tracking-wider">Track</label>
          <SearchSelect
            value={selectedTrack != null ? String(selectedTrack) : ""}
            onChange={(v) => setSelectedTrack(v ? Number(v) : null)}
            options={trackGroups.map((g) => ({ value: String(g.trackOrdinal), label: `${g.trackName} (${g.laps.length} laps)` }))}
            placeholder="Search tracks..."
          />
        </div>

        {/* Car A */}
        <div className="flex flex-col gap-1 flex-1 min-w-[120px] max-w-[220px]">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-orange-500" />
            <label className="text-[10px] text-app-text-muted uppercase tracking-wider">Car A</label>
          </div>
          <SearchSelect
            value={carAOrd != null ? String(carAOrd) : ""}
            onChange={(v) => setCarAOrd(v ? Number(v) : null)}
            options={trackCars.map((ord) => ({ value: String(ord), label: carNames.get(ord) || `Car ${ord}` }))}
            placeholder="Search cars..."
            disabled={!selectedTrack}
            focusColor="orange-500"
          />
        </div>

        {/* Lap A */}
        <div className="flex flex-col gap-1 flex-1 min-w-[120px] max-w-[200px]">
          <label className="text-[10px] text-app-text-muted uppercase tracking-wider">Lap A</label>
          <SearchSelect
            value={lapAId != null ? String(lapAId) : ""}
            onChange={(v) => setLapAId(v ? Number(v) : null)}
            options={carALaps.map((lap) => ({ value: String(lap.id), label: `Lap ${lap.lapNumber} — ${formatLapTime(lap.lapTime)}${!lap.isValid ? " (inv)" : ""}` }))}
            placeholder="Search laps..."
            disabled={!carAOrd}
            focusColor="orange-500"
          />
        </div>

        {/* Car B */}
        <div className="flex flex-col gap-1 flex-1 min-w-[120px] max-w-[220px]">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
            <label className="text-[10px] text-app-text-muted uppercase tracking-wider">Car B</label>
          </div>
          <SearchSelect
            value={carBOrd != null ? String(carBOrd) : ""}
            onChange={(v) => setCarBOrd(v ? Number(v) : null)}
            options={trackCars.map((ord) => ({ value: String(ord), label: carNames.get(ord) || `Car ${ord}` }))}
            placeholder="Search cars..."
            disabled={!selectedTrack}
            focusColor="blue-500"
          />
        </div>

        {/* Lap B */}
        <div className="flex flex-col gap-1 flex-1 min-w-[120px] max-w-[200px]">
          <label className="text-[10px] text-app-text-muted uppercase tracking-wider">Lap B</label>
          <SearchSelect
            value={lapBId != null ? String(lapBId) : ""}
            onChange={(v) => setLapBId(v ? Number(v) : null)}
            options={carBLaps.map((lap) => ({ value: String(lap.id), label: `Lap ${lap.lapNumber} — ${formatLapTime(lap.lapTime)}${!lap.isValid ? " (inv)" : ""}` }))}
            placeholder="Search laps..."
            disabled={!carBOrd}
            focusColor="blue-500"
          />
        </div>

        {/* AI panel toggle */}
        <div className="flex flex-col gap-1 self-end">
          <Button
            variant="app-outline"
            size="app-lg"
            onClick={toggleAiPanel}
            disabled={!comparison}
            title="Toggle AI compare panel"
            className={aiPanelOpen
              ? "text-app-accent border-app-accent/40 bg-app-accent/10"
              : "hover:text-app-accent"
            }
          >
            <Sparkles className="size-3.5" />
            AI Analysis
          </Button>
        </div>
      </div>

      {/* Loading / Error */}
      {(loading || error) && (
        <div className="shrink-0">
          {loading && (
            <div className="text-app-text-muted text-sm">Loading comparison data...</div>
          )}
          {error && (
            <div className="text-red-400 text-sm">{error}</div>
          )}
        </div>
      )}

      {/* No selection prompt */}
      {!lapAId || !lapBId ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">
          Select two laps above to compare
        </div>
      ) : lapAId === lapBId ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">
          Select two different laps to compare
        </div>
      ) : comparison?.traces?.distance ? (
        <div className="flex gap-4 flex-1 min-h-0 overflow-hidden">
          {/* Left: track map */}
          <div className="w-[440px] shrink-0 min-h-0">
          <CompareTrackMap
            outline={trackOutline ?? syntheticOutline}
            telemetryA={comparison.telemetryA}
            telemetryB={comparison.telemetryB}
            labelA={`${carNames.get(comparison.lapA.carOrdinal!) || "Car A"} — Lap ${comparison.lapA.lapNumber}`}
            labelB={`${carNames.get(comparison.lapB.carOrdinal!) || "Car B"} — Lap ${comparison.lapB.lapNumber}`}
            lapTimeA={formatLapTime(comparison.lapA.lapTime)}
            lapTimeB={formatLapTime(comparison.lapB.lapTime)}
            segments={segmentTimings}
            hoveredDistanceRef={hoveredDistanceRef}
            redrawRef={mapRedrawRef}
            trackOrdinal={selectedTrack}
            gameId={gameId}
          />
        </div>

        {/* Right column: time delta pinned + scrollable charts */}
        <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-hidden">
          {/* Time Delta — always visible */}
          <div className="bg-app-surface rounded-lg border border-app-border p-1 shrink-0">
            <TimeDelta
              distances={comparison.traces.distance}
              timeDelta={comparison.timeDelta}
              syncKey={SYNC_KEY}
              height={140}
              onCursorMove={handleCursorMove}
            />
          </div>

          {/* Scrollable charts */}
          <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-4">
          {/* Speed Chart */}
          <div className="bg-app-surface rounded-lg border border-app-border p-1">
            <TelemetryChart
              data={{
                distance: comparison.traces.distance,
                values: [comparison.traces.speedA.map(units.fromMph), comparison.traces.speedB.map(units.fromMph)],
                labels: [`Speed A (${units.speedLabel})`, `Speed B (${units.speedLabel})`],
                colors: [COLOR_A, COLOR_B],
              }}
              syncKey={SYNC_KEY}
              height={200}
              title="Speed"
              onCursorMove={handleCursorMove}
            />
          </div>

          {/* Throttle + Brake Chart */}
          <div className="bg-app-surface rounded-lg border border-app-border p-1">
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
              onCursorMove={handleCursorMove}
            />
          </div>

          {/* RPM Chart */}
          <div className="bg-app-surface rounded-lg border border-app-border p-1">
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
              onCursorMove={handleCursorMove}
            />
          </div>

          {/* Tire Wear Chart */}
          {comparison.traces.tireWearA && (
            <div className="bg-app-surface rounded-lg border border-app-border p-1">
              <TelemetryChart
                data={{
                  distance: comparison.traces.distance,
                  values: [comparison.traces.tireWearA!, comparison.traces.tireWearB!],
                  labels: ["Tire Wear A (%)", "Tire Wear B (%)"],
                  colors: [COLOR_A, COLOR_B],
                }}
                syncKey={SYNC_KEY}
                height={160}
                title="Tire Wear (avg all 4)"
                onCursorMove={handleCursorMove}
              />
            </div>
          )}

          </div>
          </div>
        </div>

        {/* AI compare sidebar */}
        {aiPanelOpen && (
          <CompareAiSidebar
            lapA={{
              id: lapAId!,
              label: `${carNames.get(comparison.lapA.carOrdinal!) || "Car A"} — Lap ${comparison.lapA.lapNumber} (${formatLapTime(comparison.lapA.lapTime)})`,
              lapTime: comparison.lapA.lapTime,
            }}
            lapB={{
              id: lapBId!,
              label: `${carNames.get(comparison.lapB.carOrdinal!) || "Car B"} — Lap ${comparison.lapB.lapNumber} (${formatLapTime(comparison.lapB.lapTime)})`,
              lapTime: comparison.lapB.lapTime,
            }}
            panelRef={aiPanelRef}
            onClose={toggleAiPanel}
          />
        )}
        </div>
      ) : null}
    </div>
  );
}
