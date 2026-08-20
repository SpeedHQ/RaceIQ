import type { ComparisonData } from "@shared/racing/comparison/types";
const semanticNumber = (sample: ComparisonData["telemetryA"][number], id: keyof ComparisonData["telemetryA"][number]["values"]): number | undefined => {
  const value = sample.values[id];
  return typeof value === "number" ? value : undefined;
};
import type { LapMeta } from "@shared/racing/sessions/types";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLaps } from "@/hooks/laps";
import { useTrackImagery, useTrackOutline, useTrackSectors } from "@/hooks/track-queries";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useUnits } from "@/hooks/useUnits";
import { comparisonLapIdentity, normalizeComparisonLapIds, planComparisonRequests, type Point, toggleComparisonLapSelection } from "@/lib/comparison-utils";
import { COMPARISON_COLOR_VARS } from "@/lib/colors";
import { formatLapTime } from "@/lib/format";
import type { CompareSearch } from "@/lib/game-routes";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useGameId } from "@/stores/game";
import type { CompareAiPanelHandle } from "./CompareAiPanel";
import { CompareAiSidebar } from "./CompareAiSidebar";
import { CompareTrackMap, type CompareMapSeries } from "./CompareTrackMap";
import { ComparisonCharts, type ComparisonChartPair } from "./ComparisonCharts";
import { ComparisonSelectors } from "./ComparisonSelectors";
import type { SegmentTiming } from "./CompareSegmentTable";

interface TrackGroup {
  trackOrdinal: number;
  trackName: string;
  laps: LapMeta[];
}

interface LoadedComparison {
  lapId: number;
  data: ComparisonData;
}

interface ComparisonRequestState {
  referenceLapId: number | null;
  data: Map<number, ComparisonData>;
  errors: Map<number, string>;
  requests: Map<number, AbortController>;
}
const DEFAULT_MAP_WIDTH_SHARE = 0.36;
const MIN_MAP_WIDTH_SHARE = 0.25;
const MAX_MAP_WIDTH_SHARE = 0.5;
const DEFAULT_STACKED_MAP_HEIGHT_SHARE = 0.7;
const MIN_STACKED_MAP_HEIGHT_SHARE = 0.5;
const MAX_STACKED_MAP_HEIGHT_SHARE = 0.9;
const MAP_RESIZE_KEYBOARD_STEP = 0.02;

function clampShare(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

export function comparisonSearchPatch({
  selectedTrack,
  carAOrd,
  lapAId,
  comparisonLapIds,
  aiPanelOpen,
}: {
  selectedTrack: number | null;
  carAOrd: number | null;
  lapAId: number | null;
  comparisonLapIds: readonly number[];
  aiPanelOpen: boolean;
}): Record<string, number | string | undefined> {
  return {
    track: selectedTrack ?? undefined,
    carA: carAOrd ?? undefined,
    lapA: lapAId ?? undefined,
    laps: comparisonLapIds.length > 0 ? comparisonLapIds.join(",") : undefined,
    ai: aiPanelOpen ? 1 : undefined,
  };
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

export function LapComparison({ initialSearch }: { initialSearch?: CompareSearch } = {}) {
  return <LapComparisonInner initialSearch={initialSearch} />;
}

function LapComparisonInner({ initialSearch }: { initialSearch?: CompareSearch }) {
  const search = initialSearch ?? {};
  const navigate = useNavigate();
  const units = useUnits();
  const gameId = useGameId();
  const { data: allLaps = [] } = useLaps();
  const laps = useMemo(() => allLaps.filter((lap) => lap.lapTime > 0 && lap.trackOrdinal), [allLaps]);
  const [trackGroups, setTrackGroups] = useState<TrackGroup[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(search.track ?? null);
  const [carAOrd, setCarAOrd] = useState<number | null>(search.carA ?? null);
  const [lapAId, setLapAId] = useState<number | null>(search.lapA ?? null);
  const [comparisonLapIds, setComparisonLapIds] = useState<number[]>(() => normalizeComparisonLapIds(search.laps ?? [], search.lapA ?? null));
  const [comparisons, setComparisons] = useState<LoadedComparison[]>([]);
  const comparison = comparisons[0]?.data ?? null;
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
  const { data: trackImagery = null } = useTrackImagery(selectedTrack ?? undefined);
  const prevTrackRef = useRef<number | null | undefined>(undefined);
  const prevCarARef = useRef<number | null | undefined>(undefined);
  const comparisonLapIdsRef = useRef(comparisonLapIds);
  const lapAIdRef = useRef(lapAId);
  const comparisonRequestStateRef = useRef<ComparisonRequestState>({
    referenceLapId: lapAId,
    data: new Map(),
    errors: new Map(),
    requests: new Map(),
  });
  const mountedRef = useRef(true);
  const hoveredDistanceRef = useRef<number | null>(null);
  const mapRedrawRef = useRef<(() => void) | null>(null);
  const aiPanelRef = useRef<CompareAiPanelHandle | null>(null);
  const comparisonLayoutRef = useRef<HTMLDivElement>(null);
  const stackedResizeDragRef = useRef<{ pointerStart: number; shareStart: number; extent: number } | null>(null);
  const sideResizeDragRef = useRef<{ pointerStart: number; shareStart: number; extent: number } | null>(null);
  comparisonLapIdsRef.current = comparisonLapIds;
  lapAIdRef.current = lapAId;
  const [savedMapWidthShare, setSavedMapWidthShare] = useLocalStorage("compare-map-width-share", DEFAULT_MAP_WIDTH_SHARE);
  const [savedStackedMapHeightShare, setSavedStackedMapHeightShare] = useLocalStorage("compare-stacked-map-height-share", DEFAULT_STACKED_MAP_HEIGHT_SHARE);
  const mapWidthShare = clampShare(savedMapWidthShare, MIN_MAP_WIDTH_SHARE, MAX_MAP_WIDTH_SHARE, DEFAULT_MAP_WIDTH_SHARE);
  const stackedMapHeightShare = clampShare(savedStackedMapHeightShare, MIN_STACKED_MAP_HEIGHT_SHARE, MAX_STACKED_MAP_HEIGHT_SHARE, DEFAULT_STACKED_MAP_HEIGHT_SHARE);
  const mapSizeStyle = useMemo(
    () =>
      ({
        "--compare-map-height": `${stackedMapHeightShare * 100}svh`,
        "--compare-map-width": `${mapWidthShare * 100}%`,
      }) as CSSProperties,
    [mapWidthShare, stackedMapHeightShare],
  );
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
  const handleCursorMove = useCallback((d: number | null) => {
    hoveredDistanceRef.current = d;
    // Directly redraw the map canvas without React re-render
    mapRedrawRef.current?.();
  }, []);
  const handleJumpToFrac = useCallback(
    (frac: number) => {
      const distances = comparison?.telemetryA.map((sample) => semanticNumber(sample, "timing.distance-traveled")).filter((value): value is number => value != null);
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
    if (search.cursor != null && comparison?.telemetryA) {
      const distances = comparison.telemetryA.map((sample) => semanticNumber(sample, "timing.distance-traveled")).filter((value): value is number => value != null);
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
          ...comparisonSearchPatch({ selectedTrack, carAOrd, lapAId, comparisonLapIds, aiPanelOpen }),
        }) as never,
      replace: true,
      resetScroll: false,
    });
  }, [selectedTrack, carAOrd, lapAId, comparisonLapIds, aiPanelOpen, navigate]);

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

  // Reset lap selections when track changes (skip initial mount to preserve URL params)
  useEffect(() => {
    if (prevTrackRef.current === undefined) {
      prevTrackRef.current = selectedTrack;
    } else if (prevTrackRef.current !== selectedTrack) {
      prevTrackRef.current = selectedTrack;
      setCarAOrd(null);
      setLapAId(null);
      setComparisonLapIds([]);
      setComparisons([]);
    }
  }, [selectedTrack]);

  useEffect(() => {
    if (prevCarARef.current === undefined) {
      prevCarARef.current = carAOrd;
    } else if (prevCarARef.current !== carAOrd) {
      prevCarARef.current = carAOrd;
      setLapAId(null);
      setComparisons([]);
    }
  }, [carAOrd]);

  const handleReferenceLapChange = useCallback((value: number | null) => {
    setLapAId(value);
    if (value != null) setComparisonLapIds((current) => current.filter((lapId) => lapId !== value));
    setComparisons([]);
  }, []);
  const toggleComparisonLap = useCallback((lapId: number) => {
    setComparisonLapIds((current) => toggleComparisonLapSelection(current, lapId));
  }, []);
  const clearComparisonLaps = useCallback(() => setComparisonLapIds([]), []);

  // Laps filtered to selected track
  const trackLaps = selectedTrack != null ? (trackGroups.find((g) => g.trackOrdinal === selectedTrack)?.laps ?? []) : [];

  // Unique cars on this track
  const trackCars = Array.from(new Set(trackLaps.map((l) => l.carOrdinal).filter((c): c is number => c != null)));

  // Laps filtered by reference car; comparison laps may use any car on track.
  const referenceLaps = trackLaps.filter((lap) => lap.carOrdinal === carAOrd);
  const comparisonLaps = trackLaps.filter((lap) => lap.id !== lapAId);

  const syncComparisonState = useCallback(() => {
    if (!mountedRef.current) return;
    const referenceLapId = lapAIdRef.current;
    const selectedIds = comparisonLapIdsRef.current.filter((lapId) => lapId !== referenceLapId);
    const requestState = comparisonRequestStateRef.current;
    if (referenceLapId == null || requestState.referenceLapId !== referenceLapId || selectedIds.length === 0) {
      setComparisons([]);
      setError(null);
      setLoading(false);
      return;
    }

    setComparisons(
      selectedIds.flatMap((lapId) => {
        const data = requestState.data.get(lapId);
        return data ? [{ lapId, data }] : [];
      }),
    );
    const failures = selectedIds.flatMap((lapId) => {
      const failure = requestState.errors.get(lapId);
      return failure ? [failure] : [];
    });
    setError(failures.length === 0 ? null : selectedIds.length === 1 ? failures[0]! : m.compare_some_laps_failed({ count: failures.length }));
    setLoading(selectedIds.some((lapId) => requestState.requests.has(lapId)));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of comparisonRequestStateRef.current.requests.values()) controller.abort();
      comparisonRequestStateRef.current.requests.clear();
    };
  }, []);

  // Cache completed pairs for the current reference and request only newly selected laps.
  useEffect(() => {
    const selectedIds = comparisonLapIds.filter((lapId) => lapId !== lapAId);
    let requestState = comparisonRequestStateRef.current;
    if (requestState.referenceLapId !== lapAId) {
      for (const controller of requestState.requests.values()) controller.abort();
      requestState = {
        referenceLapId: lapAId,
        data: new Map(),
        errors: new Map(),
        requests: new Map(),
      };
      comparisonRequestStateRef.current = requestState;
    }

    const selectedIdSet = new Set(selectedIds);
    const requestPlan = planComparisonRequests(selectedIds, new Set(requestState.data.keys()), new Set(requestState.errors.keys()), new Set(requestState.requests.keys()));
    for (const lapId of requestPlan.abortLapIds) {
      requestState.requests.get(lapId)?.abort();
      requestState.requests.delete(lapId);
    }
    for (const lapId of requestState.errors.keys()) {
      if (!selectedIdSet.has(lapId)) requestState.errors.delete(lapId);
    }

    if (lapAId != null) {
      for (const lapId of requestPlan.requestLapIds) {
        const controller = new AbortController();
        requestState.requests.set(lapId, controller);
        void (async () => {
          try {
            const response = await client.api.laps[":id1"].compare[":id2"].$get({ param: { id1: String(lapAId), id2: String(lapId) } }, { init: { signal: controller.signal } });
            const currentState = comparisonRequestStateRef.current;
            if (controller.signal.aborted || currentState.referenceLapId !== lapAId || currentState.requests.get(lapId) !== controller) return;
            if (!response.ok) {
              const body = (await response.json().catch(() => ({}))) as { error?: string };
              const message = body.error ?? m.compare_load_failed();
              currentState.errors.set(lapId, message.includes("no telemetry") ? m.compare_telemetry_unavailable() : message);
              return;
            }
            currentState.data.set(lapId, (await response.json()) as unknown as ComparisonData);
          } catch {
            const currentState = comparisonRequestStateRef.current;
            if (!controller.signal.aborted && currentState.referenceLapId === lapAId && currentState.requests.get(lapId) === controller) {
              currentState.errors.set(lapId, m.compare_load_failed());
            }
          } finally {
            const currentState = comparisonRequestStateRef.current;
            if (currentState.referenceLapId === lapAId && currentState.requests.get(lapId) === controller) {
              currentState.requests.delete(lapId);
              syncComparisonState();
            }
          }
        })();
      }
    }
    syncComparisonState();
  }, [lapAId, comparisonLapIds, syncComparisonState]);

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
      const x = semanticNumber(tel[i], "motion.position-x");
      const z = semanticNumber(tel[i], "motion.position-z");
      if (x != null && z != null) out.push({ x, z });
    }
    return out;
  }, [comparison]);

  // Compute per-segment times for every selected lap.
  const segmentTimings = useMemo((): SegmentTiming[] => {
    if (!trackSegments || trackSegments.length === 0 || !comparison) return [];
    const telemetrySeries = [comparison.telemetryA, ...comparisons.map((entry) => entry.data.telemetryB)];
    if (telemetrySeries.some((telemetry) => telemetry.length < 10)) return [];

    let straightNumber = 1;
    return trackSegments.map((segment) => {
      let displayName = segment.name;
      if (segment.type === "straight") {
        displayName = !segment.name || /^S[\d?]*$/.test(segment.name) ? `S${straightNumber}` : segment.name;
        straightNumber++;
      }
      const times = telemetrySeries.map((telemetry) => {
        const lastIndex = telemetry.length - 1;
        const startIndex = Math.round(segment.startFrac * lastIndex);
        const endIndex = Math.min(Math.round(segment.endFrac * lastIndex), lastIndex);
        const startTime = semanticNumber(telemetry[startIndex], "timing.current-lap") ?? 0;
        const endTime = semanticNumber(telemetry[endIndex], "timing.current-lap") ?? 0;
        return Math.round((endTime - startTime) * 1000) / 1000;
      });
      return {
        name: displayName,
        type: segment.type as "corner" | "straight",
        times,
        startFrac: segment.startFrac,
        endFrac: segment.endFrac,
      };
    });
  }, [trackSegments, comparison, comparisons]);

  const referenceLabel = comparison ? `A — ${carNames.get(comparison.lapA.carOrdinal!) || m.compare_car_a_fallback()} — ${m.compare_lap_label()} ${comparison.lapA.lapNumber}` : "";
  const chartComparisons: ComparisonChartPair[] = comparisons.map((entry) => {
    const identity = comparisonLapIdentity(comparisonLapIds, entry.lapId)!;
    return {
      comparison: entry.data,
      label: `${identity.label} — ${carNames.get(entry.data.lapB.carOrdinal!) || m.compare_car_fallback()} — ${m.compare_lap_label()} ${entry.data.lapB.lapNumber}`,
      color: identity.color,
    };
  });
  const mapSeries: CompareMapSeries[] = comparison
    ? [
        {
          telemetry: comparison.telemetryA,
          distanceGrid: comparison.traces.distance,
          sourceIndices: comparison.traces.sourceIndicesA,
          color: COMPARISON_COLOR_VARS[0],
          label: referenceLabel,
        },
        ...comparisons.map((entry, index) => ({
          telemetry: entry.data.telemetryB,
          distanceGrid: entry.data.traces.distance,
          sourceIndices: entry.data.traces.sourceIndicesB,
          color: chartComparisons[index]!.color,
          label: chartComparisons[index]!.label,
        })),
      ]
    : [];

  return (
    <div data-testid="lap-compare-workspace" className="flex min-h-full min-w-0 flex-col gap-4 p-3 @3xl/workspace:p-4 @5xl/workspace:h-full @5xl/workspace:min-h-0 @5xl/workspace:overflow-hidden">
      <ComparisonSelectors
        trackGroups={trackGroups}
        selectedTrack={selectedTrack}
        setSelectedTrack={setSelectedTrack}
        carAOrd={carAOrd}
        setCarAOrd={setCarAOrd}
        lapAId={lapAId}
        setLapAId={handleReferenceLapChange}
        comparisonLapIds={comparisonLapIds}
        toggleComparisonLap={toggleComparisonLap}
        clearComparisonLaps={clearComparisonLaps}
        trackCars={trackCars}
        carNames={carNames}
        referenceLaps={referenceLaps}
        comparisonLaps={comparisonLaps}
        comparisonReady={comparisons.length > 0}
        aiPanelOpen={aiPanelOpen}
        toggleAiPanel={toggleAiPanel}
      />

      <ComparisonLoadStatus loading={loading} error={error} hasComparison={comparisons.length > 0} />

      {!lapAId || comparisonLapIds.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">{m.compare_select_reference_and_laps()}</div>
      ) : comparison && mapSeries.every((entry) => entry.telemetry.some((sample) => Number.isFinite(semanticNumber(sample, "timing.distance-traveled")))) ? (
        <div
          ref={comparisonLayoutRef}
          className="relative flex flex-none flex-col gap-4 overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:flex-row @5xl/workspace:overflow-hidden"
        >
          {/* Left: track map */}
          <div
            className="h-(--compare-map-height) min-h-[50svh] max-h-[90svh] w-full shrink-0 @5xl/workspace:h-full @5xl/workspace:min-h-0 @5xl/workspace:max-h-none @5xl/workspace:w-(--compare-map-width)"
            style={mapSizeStyle}
          >
            <CompareTrackMap
              outline={trackOutline ?? syntheticOutline}
              series={mapSeries}
              segments={segmentTimings}
              hoveredDistanceRef={hoveredDistanceRef}
              redrawRef={mapRedrawRef}
              trackOrdinal={selectedTrack}
              gameId={gameId}
              imagery={trackImagery}
              geographicPositions={comparison.geographicPositions}
            />
          </div>
          <div
            role="separator"
            aria-label="Resize track map"
            aria-orientation="horizontal"
            aria-valuemin={MIN_STACKED_MAP_HEIGHT_SHARE * 100}
            aria-valuemax={MAX_STACKED_MAP_HEIGHT_SHARE * 100}
            aria-valuenow={Math.round(stackedMapHeightShare * 100)}
            aria-valuetext={`${Math.round(stackedMapHeightShare * 100)}% of viewport height`}
            tabIndex={0}
            className="group -my-2 flex h-2 w-full shrink-0 touch-none cursor-row-resize items-center justify-center border-y border-app-border bg-app-border-input/70 transition-colors hover:border-app-accent/60 focus-visible:border-app-accent focus-visible:outline-none @5xl/workspace:hidden"
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              const delta = event.key === "ArrowUp" ? -MAP_RESIZE_KEYBOARD_STEP : MAP_RESIZE_KEYBOARD_STEP;
              setSavedStackedMapHeightShare(clampShare(stackedMapHeightShare + delta, MIN_STACKED_MAP_HEIGHT_SHARE, MAX_STACKED_MAP_HEIGHT_SHARE, DEFAULT_STACKED_MAP_HEIGHT_SHARE));
            }}
            onPointerDown={(event) => {
              const workspace = comparisonLayoutRef.current?.closest<HTMLElement>("[data-responsive-workspace]");
              const extent = workspace?.getBoundingClientRect().height ?? 0;
              if (extent <= 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              stackedResizeDragRef.current = { pointerStart: event.clientY, shareStart: stackedMapHeightShare, extent };
            }}
            onPointerMove={(event) => {
              const drag = stackedResizeDragRef.current;
              if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
              setSavedStackedMapHeightShare(
                clampShare(drag.shareStart + (event.clientY - drag.pointerStart) / drag.extent, MIN_STACKED_MAP_HEIGHT_SHARE, MAX_STACKED_MAP_HEIGHT_SHARE, DEFAULT_STACKED_MAP_HEIGHT_SHARE),
              );
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              stackedResizeDragRef.current = null;
            }}
            onPointerCancel={() => {
              stackedResizeDragRef.current = null;
            }}
          >
            <span aria-hidden="true" className="h-1 w-12 rounded-full bg-app-border-hover transition-colors group-hover:bg-app-accent group-focus-visible:bg-app-accent" />
          </div>

          <div
            role="separator"
            aria-label="Resize track map"
            aria-orientation="vertical"
            aria-valuemin={MIN_MAP_WIDTH_SHARE * 100}
            aria-valuemax={MAX_MAP_WIDTH_SHARE * 100}
            aria-valuenow={Math.round(mapWidthShare * 100)}
            aria-valuetext={`${Math.round(mapWidthShare * 100)}% of comparison width`}
            tabIndex={0}
            className="group -mx-2 hidden h-full w-2 shrink-0 touch-none cursor-col-resize items-center justify-center border-x border-app-border bg-app-border-input/70 transition-colors hover:border-app-accent/60 focus-visible:border-app-accent focus-visible:outline-none @5xl/workspace:flex"
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? -MAP_RESIZE_KEYBOARD_STEP : MAP_RESIZE_KEYBOARD_STEP;
              setSavedMapWidthShare(clampShare(mapWidthShare + delta, MIN_MAP_WIDTH_SHARE, MAX_MAP_WIDTH_SHARE, DEFAULT_MAP_WIDTH_SHARE));
            }}
            onPointerDown={(event) => {
              const extent = comparisonLayoutRef.current?.getBoundingClientRect().width ?? 0;
              if (extent <= 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              sideResizeDragRef.current = { pointerStart: event.clientX, shareStart: mapWidthShare, extent };
            }}
            onPointerMove={(event) => {
              const drag = sideResizeDragRef.current;
              if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
              setSavedMapWidthShare(clampShare(drag.shareStart + (event.clientX - drag.pointerStart) / drag.extent, MIN_MAP_WIDTH_SHARE, MAX_MAP_WIDTH_SHARE, DEFAULT_MAP_WIDTH_SHARE));
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              sideResizeDragRef.current = null;
            }}
            onPointerCancel={() => {
              sideResizeDragRef.current = null;
            }}
          >
            <span aria-hidden="true" className="h-12 w-1 rounded-full bg-app-border-hover transition-colors group-hover:bg-app-accent group-focus-visible:bg-app-accent" />
          </div>

          <ComparisonCharts reference={{ label: referenceLabel, color: COMPARISON_COLOR_VARS[0] }} comparisons={chartComparisons} units={units} onCursorMove={handleCursorMove} />

          {/* AI compare sidebar */}
          {aiPanelOpen && comparisons.length > 0 && (
            <CompareAiSidebar
              laps={[
                {
                  id: lapAId!,
                  label: `${referenceLabel} (${formatLapTime(comparison.lapA.lapTime)})`,
                  lapTime: comparison.lapA.lapTime,
                },
                ...comparisons.map((entry, index) => ({
                  id: entry.lapId,
                  label: `${chartComparisons[index]!.label} (${formatLapTime(entry.data.lapB.lapTime)})`,
                  lapTime: entry.data.lapB.lapTime,
                })),
              ]}
              panelRef={aiPanelRef}
              onClose={toggleAiPanel}
              segments={segmentTimings}
              onJumpToFrac={handleJumpToFrac}
            />
          )}
        </div>
      ) : comparison ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">{m.compare_telemetry_unavailable()}</div>
      ) : null}
    </div>
  );
}
