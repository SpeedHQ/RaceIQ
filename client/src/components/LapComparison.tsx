import type { ComparisonData, LapMeta } from "@shared/types";
import { useNavigate } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLaps, useTrackOutline, useTrackSectors } from "../hooks/queries";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useUnits } from "../hooks/useUnits";
import { COMPARE_MAP_DEFAULT_WIDTH, COMPARE_MAP_MIN_WIDTH, clampCompareMapWidth } from "../lib/comparison-layout";
import { COLOR_A, COLOR_B, formatLapTime, type Point } from "../lib/comparison-utils";
import { client } from "../lib/rpc";
import { m } from "../paraglide/messages";
import { useGameId } from "../stores/game";
import type { CompareAiPanelHandle } from "./comparison/CompareAiPanel";
import { CompareAiSidebar } from "./comparison/CompareAiSidebar";
import { CompareTrackMap, type SegmentTiming } from "./comparison/CompareTrackMap";
import { TelemetryChart } from "./TelemetryChart";
import { TimeDelta } from "./TimeDelta";
import { Button } from "./ui/button";
import { SearchSelect } from "./ui/SearchSelect";

const SYNC_KEY = "lap-compare";

interface TrackGroup {
  trackOrdinal: number;
  trackName: string;
  laps: LapMeta[];
}

export interface LapComparisonSearch {
  track?: number;
  carA?: number;
  carB?: number;
  lapA?: number;
  lapB?: number;
  cursor?: number;
}

export function LapComparison({ initialSearch }: { initialSearch?: LapComparisonSearch } = {}) {
  return <LapComparisonInner initialSearch={initialSearch} />;
}

function LapComparisonInner({ initialSearch }: { initialSearch?: LapComparisonSearch }) {
  const search = initialSearch ?? {};
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
  const comparisonLayoutRef = useRef<HTMLDivElement>(null);
  const [comparisonLayoutWidth, setComparisonLayoutWidth] = useState(0);
  const [savedMapWidth, setSavedMapWidth] = useLocalStorage("compare-left-column-width", COMPARE_MAP_DEFAULT_WIDTH);
  const [aiPanelOpen, setAiPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("compare-ai-panel-open") === "1";
    } catch {
      return false;
    }
  });
  const toggleAiPanel = useCallback(() => {
    setAiPanelOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem("compare-ai-panel-open", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  useEffect(() => {
    const layout = comparisonLayoutRef.current;
    if (!layout) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setComparisonLayoutWidth(entry.contentRect.width);
    });
    observer.observe(layout);
    return () => observer.disconnect();
  }, [comparison]);
  const mapWidth = comparisonLayoutWidth > 0 ? clampCompareMapWidth(savedMapWidth, comparisonLayoutWidth, aiPanelOpen) : savedMapWidth;
  const handleCursorMove = useCallback((d: number | null) => {
    hoveredDistanceRef.current = d;
    // Directly redraw the map canvas without React re-render
    mapRedrawRef.current?.();
  }, []);
  const handleJumpToFrac = useCallback(
    (frac: number) => {
      const distances = comparison?.traces?.distance;
      if (!distances || distances.length === 0) return;
      const idx = Math.max(0, Math.min(distances.length - 1, Math.floor(frac * distances.length)));
      hoveredDistanceRef.current = distances[idx];
      mapRedrawRef.current?.();
    },
    [comparison],
  );

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
      search: (prev: Record<string, unknown>) =>
        ({
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
        let name = `${m.compare_track_fallback()} ${ordinal}`;
        try {
          name = await client.api["track-name"][":ordinal"].$get({ param: { ordinal: String(ordinal) }, query: { gameId: gameId! } }).then((r) => (r.ok ? r.text() : name));
        } catch {}
        groups.push({ trackOrdinal: ordinal, trackName: name, laps: trackLaps });
      }
      groups.sort((a, b) => a.trackName.localeCompare(b.trackName));

      const carOrds = new Set<number>(laps.map((l) => l.carOrdinal).filter((c): c is number => c != null));
      const names = new Map<number, string>();
      await Promise.all(
        Array.from(carOrds).map(async (ord) => {
          try {
            names.set(ord, await client.api["car-name"][":ordinal"].$get({ param: { ordinal: String(ord) }, query: { gameId: gameId! } }).then((r) => (r.ok ? r.text() : "")));
          } catch {}
        }),
      );

      if (!cancelled) {
        setTrackGroups(groups);
        setCarNames(names);
      }
    }
    buildGroups();
    return () => {
      cancelled = true;
    };
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
  const trackLaps = selectedTrack != null ? (trackGroups.find((g) => g.trackOrdinal === selectedTrack)?.laps ?? []) : [];

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
      const res = await client.api.laps[":id1"].compare[":id2"].$get({ param: { id1: String(lapAId), id2: String(lapBId) } });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = body.error ?? m.compare_load_failed();
        setError(msg.includes("no telemetry") ? m.compare_telemetry_unavailable() : msg);
        setComparison(null);
        return;
      }
      setComparison((await res.json()) as unknown as ComparisonData);
    } catch {
      setError(m.compare_load_failed());
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
      let displayName = seg.name;
      if (seg.type === "straight") {
        displayName = !seg.name || /^S[\d?]*$/.test(seg.name) ? `S${sNum}` : seg.name;
        sNum++;
      }

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
    <div data-testid="lap-compare-workspace" className="flex min-h-full min-w-0 flex-col gap-4 p-3 @3xl/workspace:p-4 @5xl/workspace:h-full @5xl/workspace:min-h-0 @5xl/workspace:overflow-hidden">
      {/* Selectors: Track → Car A → Lap A → Car B → Lap B */}
      <div className="flex shrink-0 flex-wrap items-end gap-3">
        {/* Track selector */}
        <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[140px] @sm/workspace:flex-1 @3xl/workspace:max-w-[260px]">
          <label htmlFor="compare-track" className="text-app-caption text-app-text-muted uppercase tracking-wider">
            {m.label_track()}
          </label>
          <SearchSelect
            id="compare-track"
            value={selectedTrack != null ? String(selectedTrack) : ""}
            onChange={(v) => setSelectedTrack(v ? Number(v) : null)}
            options={trackGroups.map((g) => ({ value: String(g.trackOrdinal), label: `${g.trackName} (${g.laps.length} ${m.pitwindow_laps()})` }))}
            placeholder={m.compare_search_tracks()}
          />
        </div>

        {/* Car A */}
        <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[220px]">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "var(--comparison-lap-a)" }} />
            <label htmlFor="compare-car-a" className="text-app-caption text-app-text-muted uppercase tracking-wider">
              {m.compare_car_a()}
            </label>
          </div>
          <SearchSelect
            id="compare-car-a"
            value={carAOrd != null ? String(carAOrd) : ""}
            onChange={(v) => setCarAOrd(v ? Number(v) : null)}
            options={trackCars.map((ord) => ({ value: String(ord), label: carNames.get(ord) || `${m.compare_car_fallback()} ${ord}` }))}
            placeholder={m.compare_search_cars()}
            disabled={!selectedTrack}
            focusColor="orange-500"
          />
        </div>

        {/* Lap A */}
        <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[200px]">
          <label htmlFor="compare-lap-a" className="text-app-caption text-app-text-muted uppercase tracking-wider">
            {m.compare_lap_a()}
          </label>
          <SearchSelect
            id="compare-lap-a"
            value={lapAId != null ? String(lapAId) : ""}
            onChange={(v) => setLapAId(v ? Number(v) : null)}
            options={carALaps.map((lap) => ({ value: String(lap.id), label: `${m.compare_lap_label()} ${lap.lapNumber} — ${formatLapTime(lap.lapTime)}${!lap.isValid ? " (inv)" : ""}` }))}
            placeholder={m.compare_search_laps()}
            disabled={!carAOrd}
            focusColor="orange-500"
          />
        </div>

        {/* Car B */}
        <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[220px]">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "var(--comparison-lap-b)" }} />
            <label htmlFor="compare-car-b" className="text-app-caption text-app-text-muted uppercase tracking-wider">
              {m.compare_car_b()}
            </label>
          </div>
          <SearchSelect
            id="compare-car-b"
            value={carBOrd != null ? String(carBOrd) : ""}
            onChange={(v) => setCarBOrd(v ? Number(v) : null)}
            options={trackCars.map((ord) => ({ value: String(ord), label: carNames.get(ord) || `${m.compare_car_fallback()} ${ord}` }))}
            placeholder={m.compare_search_cars()}
            disabled={!selectedTrack}
            focusColor="blue-500"
          />
        </div>

        {/* Lap B */}
        <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[200px]">
          <label htmlFor="compare-lap-b" className="text-app-caption text-app-text-muted uppercase tracking-wider">
            {m.compare_lap_b()}
          </label>
          <SearchSelect
            id="compare-lap-b"
            value={lapBId != null ? String(lapBId) : ""}
            onChange={(v) => setLapBId(v ? Number(v) : null)}
            options={carBLaps.map((lap) => ({ value: String(lap.id), label: `${m.compare_lap_label()} ${lap.lapNumber} — ${formatLapTime(lap.lapTime)}${!lap.isValid ? " (inv)" : ""}` }))}
            placeholder={m.compare_search_laps()}
            disabled={!carBOrd}
            focusColor="blue-500"
          />
        </div>

        {/* AI panel toggle */}
        <div className="ml-auto flex w-full flex-col gap-1 self-end @3xl/workspace:w-auto">
          <Button
            variant="app-outline"
            size="app-lg"
            onClick={toggleAiPanel}
            disabled={!comparison}
            title={m.compare_toggle_ai()}
            className={`w-full @3xl/workspace:w-auto ${aiPanelOpen ? "text-app-accent border-app-accent/40 bg-app-accent/10" : "hover:text-app-accent"}`}
          >
            <Sparkles className="size-3.5" />
            {m.label_ai_analysis()}
          </Button>
        </div>
      </div>

      {/* Loading / Error */}
      {(loading || error) && (
        <div className="shrink-0">
          {loading && <div className="text-app-text-muted text-sm">{m.compare_loading()}</div>}
          {error && <div className="text-status-danger text-sm">{error}</div>}
        </div>
      )}

      {/* No selection prompt */}
      {!lapAId || !lapBId ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">{m.compare_select_two_laps()}</div>
      ) : lapAId === lapBId ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">{m.compare_select_different_laps()}</div>
      ) : comparison?.traces?.distance ? (
        <div
          ref={comparisonLayoutRef}
          className="relative flex flex-none flex-col gap-4 overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:flex-row @5xl/workspace:overflow-hidden"
        >
          {/* Left: track map */}
          <div
            className="h-[42rem] w-full shrink-0 @5xl/workspace:h-auto @5xl/workspace:min-h-0 @5xl/workspace:w-(--compare-map-width)"
            style={{ "--compare-map-width": `${mapWidth}px` } as CSSProperties}
          >
            <CompareTrackMap
              outline={trackOutline ?? syntheticOutline}
              telemetryA={comparison.telemetryA}
              telemetryB={comparison.telemetryB}
              labelA={`${carNames.get(comparison.lapA.carOrdinal!) || m.compare_car_a_fallback()} — ${m.compare_lap_label()} ${comparison.lapA.lapNumber}`}
              labelB={`${carNames.get(comparison.lapB.carOrdinal!) || m.compare_car_b_fallback()} — ${m.compare_lap_label()} ${comparison.lapB.lapNumber}`}
              lapTimeA={formatLapTime(comparison.lapA.lapTime)}
              lapTimeB={formatLapTime(comparison.lapB.lapTime)}
              segments={segmentTimings}
              hoveredDistanceRef={hoveredDistanceRef}
              redrawRef={mapRedrawRef}
              trackOrdinal={selectedTrack}
              gameId={gameId}
            />
          </div>

          <hr
            aria-label="Resize track map"
            aria-orientation="vertical"
            aria-valuemin={COMPARE_MAP_MIN_WIDTH}
            aria-valuemax={comparisonLayoutWidth > 0 ? clampCompareMapWidth(Number.MAX_SAFE_INTEGER, comparisonLayoutWidth, aiPanelOpen) : COMPARE_MAP_DEFAULT_WIDTH}
            aria-valuenow={Math.round(mapWidth)}
            tabIndex={0}
            className="-mx-2 hidden w-2 shrink-0 cursor-col-resize border-x border-app-border bg-app-surface-alt/80 transition-colors hover:bg-app-accent/30 focus-visible:bg-app-accent/30 @5xl/workspace:block"
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? -16 : 16;
              setSavedMapWidth(clampCompareMapWidth(mapWidth + delta, comparisonLayoutWidth, aiPanelOpen));
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              const startX = event.clientX;
              const startWidth = mapWidth;
              const onMove = (moveEvent: MouseEvent) => {
                setSavedMapWidth(clampCompareMapWidth(startWidth + moveEvent.clientX - startX, comparisonLayoutWidth, aiPanelOpen));
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          />

          {/* Right column: time delta pinned + scrollable charts */}
          <div className="flex min-w-0 flex-none flex-col gap-4 overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-hidden">
            {/* Time Delta — always visible */}
            <div className="bg-app-surface rounded-lg border border-app-border p-1 shrink-0">
              <TimeDelta distances={comparison.traces.distance} timeDelta={comparison.timeDelta} syncKey={SYNC_KEY} height={140} onCursorMove={handleCursorMove} />
            </div>

            {/* Scrollable charts */}
            <div className="overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-y-auto">
              <div className="flex flex-col gap-4">
                {/* Speed Chart */}
                <div className="bg-app-surface rounded-lg border border-app-border p-1">
                  <TelemetryChart
                    data={{
                      distance: comparison.traces.distance,
                      values: [comparison.traces.speedA.map(units.fromMph), comparison.traces.speedB.map(units.fromMph)],
                      labels: [`${m.compare_speed_a()} (${units.speedLabel})`, `${m.compare_speed_b()} (${units.speedLabel})`],
                      colors: [COLOR_A, COLOR_B],
                    }}
                    syncKey={SYNC_KEY}
                    height={200}
                    title={m.label_speed()}
                    onCursorMove={handleCursorMove}
                  />
                </div>

                {/* Throttle + Brake Chart */}
                <div className="bg-app-surface rounded-lg border border-app-border p-1">
                  <TelemetryChart
                    data={{
                      distance: comparison.traces.distance,
                      values: [comparison.traces.throttleA, comparison.traces.throttleB, comparison.traces.brakeA, comparison.traces.brakeB],
                      labels: [m.compare_chart_throttle_a(), m.compare_chart_throttle_b(), m.compare_chart_brake_a(), m.compare_chart_brake_b()],
                      colors: [COLOR_A, COLOR_B, "color-mix(in srgb, var(--comparison-lap-a) 67%, transparent)", "color-mix(in srgb, var(--comparison-lap-b) 67%, transparent)"],
                    }}
                    syncKey={SYNC_KEY}
                    height={180}
                    title={m.compare_throttle_brake()}
                    onCursorMove={handleCursorMove}
                  />
                </div>

                {/* RPM Chart */}
                <div className="bg-app-surface rounded-lg border border-app-border p-1">
                  <TelemetryChart
                    data={{
                      distance: comparison.traces.distance,
                      values: [comparison.traces.rpmA, comparison.traces.rpmB],
                      labels: [m.compare_chart_rpm_a(), m.compare_chart_rpm_b()],
                      colors: [COLOR_A, COLOR_B],
                    }}
                    syncKey={SYNC_KEY}
                    height={180}
                    title={m.compare_rpm()}
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
                        labels: [`${m.compare_chart_tire_wear_a()} (%)`, `${m.compare_chart_tire_wear_b()} (%)`],
                        colors: [COLOR_A, COLOR_B],
                      }}
                      syncKey={SYNC_KEY}
                      height={160}
                      title={m.compare_tire_wear()}
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
                label: `${carNames.get(comparison.lapA.carOrdinal!) || m.compare_car_a_fallback()} — ${m.compare_lap_label()} ${comparison.lapA.lapNumber} (${formatLapTime(comparison.lapA.lapTime)})`,
                lapTime: comparison.lapA.lapTime,
              }}
              lapB={{
                id: lapBId!,
                label: `${carNames.get(comparison.lapB.carOrdinal!) || m.compare_car_b_fallback()} — ${m.compare_lap_label()} ${comparison.lapB.lapNumber} (${formatLapTime(comparison.lapB.lapTime)})`,
                lapTime: comparison.lapB.lapTime,
              }}
              panelRef={aiPanelRef}
              onClose={toggleAiPanel}
              segments={segmentTimings}
              onJumpToFrac={handleJumpToFrac}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
