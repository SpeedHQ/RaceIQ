import type { ComparisonRangeData } from "@shared/racing/comparison/types";
import type { LapMeta } from "@shared/racing/sessions/types";
import { useLapComparison, useLapComparisonRange, useLaps } from "@/hooks/laps";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTrackOutline, useTrackSectors } from "@/hooks/track-queries";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useUnits } from "@/hooks/useUnits";
import { COMPARE_MAP_DEFAULT_WIDTH, COMPARE_MAP_MIN_WIDTH, clampCompareMapWidth } from "@/lib/comparison-layout";
import { formatLapTime } from "@/lib/format";
import type { Point } from "@/lib/comparison-utils";
import { cropComparisonData, cropComparisonRange, mergeComparisonRange, normalizeFidelityRange, rangeComparison, selectFidelity } from "@/lib/comparison-fidelity";
import type { CompareSearch } from "@/lib/game-routes";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useGameId } from "@/stores/game";
import type { CompareAiPanelHandle } from "./CompareAiPanel";
import { PointerLoadingIndicator } from "@/components/PointerLoadingIndicator";
import { CompareAiSidebar } from "./CompareAiSidebar";
import { CompareTrackMap, type SegmentTiming } from "./CompareTrackMap";
import { ComparisonCharts } from "./ComparisonCharts";
import { ComparisonSelectors } from "./ComparisonSelectors";
const compareDebug = (event: string, details: Record<string, unknown> = {}): void => {
  try {
    if (localStorage.getItem("raceiq:compare-debug") === "1") console.log("[compare-debug]", event, details);
  } catch {
    // Ignore unavailable browser storage.
  }
};

interface TrackGroup {
  trackOrdinal: number;
  trackName: string;
  laps: LapMeta[];
}

export function ComparisonLoadStatus({ loading, error, hasComparison }: { loading: boolean; error: string | null; hasComparison: boolean }) {
  if (!error && (!loading || hasComparison)) return null;
  return (
    <div className="shrink-0">
      {loading && !hasComparison && <div className="text-app-text-muted text-sm">{m.compare_loading()}</div>}
      {error && <div className="text-status-danger text-sm">{error}</div>}
    </div>
  );
}

export function ComparisonCursorLoadingIndicator({
  loading,
  position,
}: {
  loading: boolean;
  position: { x: number; y: number } | null;
}) {
  return <PointerLoadingIndicator loading={loading} position={position} label="Fetching higher-fidelity datapoints" />;
}

export function LapComparison({ initialSearch }: { initialSearch?: CompareSearch } = {}) {
  return <LapComparisonInner initialSearch={initialSearch} />;
}

function LapComparisonInner({ initialSearch }: { initialSearch?: CompareSearch }) {
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
  const { data: comparison, isLoading: loading, error: comparisonError } = useLapComparison(lapAId, lapBId);
  const error = comparisonError
    ? comparisonError.message.includes("no telemetry")
      ? m.compare_telemetry_unavailable()
      : comparisonError.message || m.compare_load_failed()
    : null;
  const [carNames, setCarNames] = useState<Map<number, string>>(new Map());
  const [detailRange, setDetailRange] = useState<{ start: number; end: number; stepMeters: 0.1 } | null>(null);
  const [optimisticRange, setOptimisticRange] = useState<ComparisonRangeData | null>(null);
  const fullDistance = comparison?.traces.distance.at(-1) ?? 0;
  const {
    data: comparisonRange,
    isPlaceholderData: comparisonRangeIsPlaceholder,
    isFetching: comparisonRangeIsFetching,
  } = useLapComparisonRange(
    lapAId,
    lapBId,
    detailRange?.stepMeters ?? null,
    detailRange?.start ?? null,
    detailRange?.end ?? null,
  );
  const detailLoading = detailRange != null && comparisonRangeIsFetching;
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const [pointerPosition, setPointerPosition] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      if (detailLoading) setPointerPosition(pointerPositionRef.current);
    };
    window.addEventListener("pointermove", onPointerMove);
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [detailLoading]);
  useEffect(() => {
    setPointerPosition(detailLoading ? pointerPositionRef.current : null);
  }, [detailLoading]);
  const activeRange = optimisticRange ?? comparisonRange;
  const mergedComparison = useMemo(
    () => (comparison && activeRange ? mergeComparisonRange(comparison, activeRange) : comparison),
    [comparison, activeRange],
  );
  const chartComparison = useMemo(
    () => (comparison && activeRange ? rangeComparison(comparison, activeRange) : comparison),
    [comparison, activeRange],
  );
  useEffect(() => {
    if (comparisonRange && !comparisonRangeIsPlaceholder) setOptimisticRange(null);
  }, [comparisonRange, comparisonRangeIsPlaceholder]);
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
  const mapResizeCleanupRef = useRef<(() => void) | null>(null);
  const [comparisonLayoutWidth, setComparisonLayoutWidth] = useState(0);
  const [savedMapWidth, setSavedMapWidth] = useLocalStorage("compare-left-column-width", COMPARE_MAP_DEFAULT_WIDTH);
  const [aiPanelOpen, setAiPanelOpen] = useState<boolean>(() => {
    if (search.ai === 1) return true;
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
  const mapWidth = comparisonLayoutWidth > 0 ? clampCompareMapWidth(savedMapWidth, comparisonLayoutWidth, aiPanelOpen) : savedMapWidth;
  const handleCursorMove = useCallback((d: number | null) => {
    hoveredDistanceRef.current = d;
    // Directly redraw the map canvas without React re-render
    mapRedrawRef.current?.();
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
  useEffect(
    () => () => {
      mapResizeCleanupRef.current?.();
      mapResizeCleanupRef.current = null;
    },
    [],
  );
  const handleRangeSelect = useCallback(
    (start: number, end: number) => {
      compareDebug("range-handler", {
        start,
        end,
        hasComparison: Boolean(comparison),
        fullDistance,
        activeRange,
      });
      if (!comparison || fullDistance <= 0) return;
      const currentStart = activeRange?.distanceStart ?? comparison.traces.distance[0] ?? 0;
      const currentEnd = activeRange?.distanceEnd ?? fullDistance;
      const fidelity = selectFidelity(end - start, Math.max(1, currentEnd - currentStart + 1));
      compareDebug("range-fidelity", { start, end, currentStart, currentEnd, fidelity });
      if (!fidelity) {
        setOptimisticRange(null);
        setDetailRange(null);
        return;
      }
      const nextRange = normalizeFidelityRange(start, end, fullDistance);
      if (comparison) {
        setOptimisticRange(activeRange ? cropComparisonRange(activeRange, start, end) : cropComparisonData(comparison, start, end));
      }
      setDetailRange(nextRange);
    },
    [activeRange, comparison, fullDistance],
  );
  const handleResetZoom = useCallback(() => {
    compareDebug("reset-handler", { activeRange, optimisticRange, detailRange });
    setOptimisticRange(null);
    setDetailRange(null);
  }, [activeRange, detailRange, optimisticRange]);
  const handleJumpToFrac = useCallback(
    (frac: number) => {
      const distances = comparison?.traces.distance;
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
    const distances = comparison?.traces.distance;
    if (search.cursor != null && distances) {
      if (distances.length === 0) return;
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

      const groups = await Promise.all(
        Array.from(byTrack, async ([ordinal, trackLaps]) => {
          let name = `${m.compare_track_fallback()} ${ordinal}`;
          try {
            name = await client.api["track-name"][":ordinal"].$get({ param: { ordinal: String(ordinal) }, query: { gameId: gameId! } }).then((r) => (r.ok ? r.text() : name));
          } catch {}
          return { trackOrdinal: ordinal, trackName: name, laps: trackLaps };
        }),
      );
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
      setCarAOrd(null);
      setCarBOrd(null);
      setLapAId(null);
      setLapBId(null);
    }
  }, [selectedTrack]);

  // Reset lap A when car A changes, default car B to same
  useEffect(() => {
    if (prevCarARef.current === undefined) {
      prevCarARef.current = carAOrd;
    } else if (prevCarARef.current !== carAOrd) {
      prevCarARef.current = carAOrd;
      setLapAId(null);
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
    }
  }, [carBOrd]);

  useEffect(() => {
    setDetailRange(null);
  }, [lapAId, lapBId]);

  // Laps filtered to selected track
  const trackLaps = selectedTrack != null ? (trackGroups.find((g) => g.trackOrdinal === selectedTrack)?.laps ?? []) : [];

  // Unique cars on this track
  const trackCars = Array.from(new Set(trackLaps.map((l) => l.carOrdinal).filter((c): c is number => c != null)));

  // Laps filtered by car
  const carALaps = trackLaps.filter((l) => l.carOrdinal === carAOrd);
  const carBLaps = trackLaps.filter((l) => l.carOrdinal === carBOrd);

  // Synthetic outline fallback: use aligned world positions when no track outline exists.
  const syntheticOutline = useMemo<Point[]>(() => {
    if (!comparison) return [];
    const { distance, positionXA, positionZA } = comparison.traces;
    if (distance.length < 2) return [];
    const step = Math.max(1, Math.floor(distance.length / 400));
    const out: Point[] = [];
    for (let i = 0; i < distance.length; i += step) {
      const x = positionXA[i];
      const z = positionZA[i];
      if (Number.isFinite(x) && Number.isFinite(z) && (x !== 0 || z !== 0)) out.push({ x, z });
    }
    return out;
  }, [comparison]);

  // Compute per-segment times for both laps
  const segmentTimings = useMemo((): SegmentTiming[] => {
    if (!trackSegments || trackSegments.length === 0 || !comparison) return [];
    const { distance, elapsedTimeA, elapsedTimeB } = comparison.traces;
    if (distance.length < 10) return [];

    let sNum = 1;
    return trackSegments.map((seg) => {
      let displayName = seg.name;
      if (seg.type === "straight") {
        displayName = !seg.name || /^S[\d?]*$/.test(seg.name) ? `S${sNum}` : seg.name;
        sNum++;
      }

      const computeTime = (times: number[]) => {
        const n = times.length;
        const startIdx = Math.round(seg.startFrac * (n - 1));
        const endIdx = Math.min(Math.round(seg.endFrac * (n - 1)), n - 1);
        return Math.round((times[endIdx] - times[startIdx]) * 1000) / 1000;
      };

      return {
        name: displayName,
        type: seg.type as "corner" | "straight",
        timeA: computeTime(elapsedTimeA),
        timeB: computeTime(elapsedTimeB),
        startFrac: seg.startFrac,
        endFrac: seg.endFrac,
      };
    });
  }, [trackSegments, comparison]);

  return (
    <div data-testid="lap-compare-workspace" className="flex min-h-full min-w-0 flex-col gap-4 p-3 @3xl/workspace:p-4 @5xl/workspace:h-full @5xl/workspace:min-h-0 @5xl/workspace:overflow-hidden">
      <ComparisonCursorLoadingIndicator loading={detailLoading} position={pointerPosition} />
      <ComparisonSelectors
        trackGroups={trackGroups}
        selectedTrack={selectedTrack}
        setSelectedTrack={setSelectedTrack}
        carAOrd={carAOrd}
        setCarAOrd={setCarAOrd}
        carBOrd={carBOrd}
        setCarBOrd={setCarBOrd}
        lapAId={lapAId}
        setLapAId={setLapAId}
        lapBId={lapBId}
        setLapBId={setLapBId}
        trackCars={trackCars}
        carNames={carNames}
        carALaps={carALaps}
        carBLaps={carBLaps}
        comparisonReady={comparison != null}
        aiPanelOpen={aiPanelOpen}
        toggleAiPanel={toggleAiPanel}
      />

      <ComparisonLoadStatus loading={loading} error={error} hasComparison={comparison != null} />

      {/* No selection prompt */}
      {!lapAId || !lapBId ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">{m.compare_select_two_laps()}</div>
      ) : lapAId === lapBId ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">{m.compare_select_different_laps()}</div>
      ) : comparison?.traces.distance.length ? (
        <div
          ref={comparisonLayoutRef}
          className="relative flex flex-none flex-col gap-4 overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:flex-row @5xl/workspace:overflow-hidden"
        >
          {/* Left: track map */}
          <div
            className="h-[42rem] w-full shrink-0 @5xl/workspace:h-full @5xl/workspace:min-h-0 @5xl/workspace:w-(--compare-map-width)"
            style={{ "--compare-map-width": `${mapWidth}px` } as CSSProperties}
          >
            <CompareTrackMap
              outline={trackOutline ?? syntheticOutline}
              traces={mergedComparison?.traces ?? comparison.traces}
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
            className="-mx-2 hidden h-full w-2 shrink-0 cursor-col-resize border-x border-app-border bg-app-surface-alt/80 transition-colors hover:bg-app-accent/30 focus-visible:bg-app-accent/30 @5xl/workspace:block"
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? -16 : 16;
              setSavedMapWidth(clampCompareMapWidth(mapWidth + delta, comparisonLayoutWidth, aiPanelOpen));
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              mapResizeCleanupRef.current?.();
              const startX = event.clientX;
              const startWidth = mapWidth;
              const onMove = (moveEvent: MouseEvent) => {
                setSavedMapWidth(clampCompareMapWidth(startWidth + moveEvent.clientX - startX, comparisonLayoutWidth, aiPanelOpen));
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                mapResizeCleanupRef.current = null;
              };
              const cleanup = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              mapResizeCleanupRef.current = cleanup;
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          />
          <ComparisonCharts comparison={chartComparison ?? comparison} units={units} onCursorMove={handleCursorMove} onRangeSelect={handleRangeSelect} onResetZoom={handleResetZoom} />

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
      ) : comparison ? <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">{m.compare_telemetry_unavailable()}</div> : null}
    </div>
  );
}
