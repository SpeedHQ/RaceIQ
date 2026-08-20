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
import type { Point } from "@/lib/comparison-utils";
import { formatLapTime } from "@/lib/format";
import type { CompareSearch } from "@/lib/game-routes";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useGameId } from "@/stores/game";
import type { CompareAiPanelHandle } from "./CompareAiPanel";
import { CompareAiSidebar } from "./CompareAiSidebar";
import { CompareTrackMap, type SegmentTiming } from "./CompareTrackMap";
import { ComparisonCharts } from "./ComparisonCharts";
import { ComparisonSelectors } from "./ComparisonSelectors";

interface TrackGroup {
  trackOrdinal: number;
  trackName: string;
  laps: LapMeta[];
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
  const { data: trackImagery = null } = useTrackImagery(selectedTrack ?? undefined);
  const prevTrackRef = useRef<number | null | undefined>(undefined);
  const prevCarARef = useRef<number | null | undefined>(undefined);
  const prevCarBRef = useRef<number | null | undefined>(undefined);
  const hoveredDistanceRef = useRef<number | null>(null);
  const mapRedrawRef = useRef<(() => void) | null>(null);
  const aiPanelRef = useRef<CompareAiPanelHandle | null>(null);
  const comparisonLayoutRef = useRef<HTMLDivElement>(null);
  const stackedResizeDragRef = useRef<{ pointerStart: number; shareStart: number; extent: number } | null>(null);
  const sideResizeDragRef = useRef<{ pointerStart: number; shareStart: number; extent: number } | null>(null);
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
      const x = semanticNumber(tel[i], "motion.position-x");
      const z = semanticNumber(tel[i], "motion.position-z");
      if (x != null && z != null) out.push({ x, z });
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
        const startTime = semanticNumber(tel[startIdx], "timing.current-lap") ?? 0;
        const endTime = semanticNumber(tel[endIdx], "timing.current-lap") ?? 0;
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
      ) : comparison?.telemetryA?.some((sample) => Number.isFinite(semanticNumber(sample, "timing.distance-traveled"))) &&
        comparison.telemetryB?.some((sample) => Number.isFinite(semanticNumber(sample, "timing.distance-traveled"))) ? (
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
              telemetryA={comparison.telemetryA}
              telemetryB={comparison.telemetryB}
              distanceGrid={comparison.traces.distance}
              sourceIndicesA={comparison.traces.sourceIndicesA}
              sourceIndicesB={comparison.traces.sourceIndicesB}
              labelA={`${carNames.get(comparison.lapA.carOrdinal!) || m.compare_car_a_fallback()} — ${m.compare_lap_label()} ${comparison.lapA.lapNumber}`}
              labelB={`${carNames.get(comparison.lapB.carOrdinal!) || m.compare_car_b_fallback()} — ${m.compare_lap_label()} ${comparison.lapB.lapNumber}`}
              lapTimeA={formatLapTime(comparison.lapA.lapTime)}
              lapTimeB={formatLapTime(comparison.lapB.lapTime)}
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

          <ComparisonCharts comparison={comparison} units={units} onCursorMove={handleCursorMove} />

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
      ) : comparison ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">{m.compare_telemetry_unavailable()}</div>
      ) : null}
    </div>
  );
}
