import type { ComparisonRangeData } from "@raceiq/shared/racing/comparison/types";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { OpponentLapCatalog, OpponentLapComparison, OpponentLapSummary } from "@raceiq/lap-replay/contracts";
import { useLapComparison, useLapComparisonRange, useLaps } from "@/hooks/laps";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTrackOutline, useTrackSectors } from "@/hooks/track-queries";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useUnits } from "@/hooks/useUnits";
import { COMPARE_MAP_DEFAULT_WIDTH, COMPARE_MAP_MIN_WIDTH, clampCompareMapWidth } from "@/lib/comparison-layout";
import { formatLapTime } from "@/lib/format";
import type { Point } from "@/lib/comparison-utils";
import type { ChartRange } from "@/lib/chart-range";
import { cropComparisonData, cropComparisonRange, mergeComparisonRange, normalizeFidelityRange, rangeComparison, selectFidelity } from "@/lib/comparison-fidelity";
import { compareTrackFromSearch, compareTrackSearch, type CompareSearch } from "@/lib/game-routes";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useGameId } from "@/stores/game";
import type { CompareAiPanelHandle } from "./CompareAiPanel";
import { PointerLoadingIndicator } from "@/components/PointerLoadingIndicator";
import { LoadingIndicator } from "@/components/LoadingIndicator";
import { CompareAiSidebar } from "./CompareAiSidebar";
import { CompareTrackMap, type SegmentTiming } from "./CompareTrackMap";
import { ComparisonCharts } from "./ComparisonCharts";
import { ComparisonSelectors } from "./ComparisonSelectors";
import { SpectateSession } from "@raceiq/lap-replay/ui"
import { CompareOverview } from "./CompareOverview";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CompareOverviewPicker } from "./CompareOverviewPicker";

import { OpponentQueryError, useOpponentLapCatalog, useOpponentLapComparison } from "@/hooks/opponents";
import { exportLapsZip } from "@/lib/lap-export";
import { Button } from "@/components/ui/button";
interface TrackGroup {
  trackId: string;
  trackName: string;
  laps: LapMeta[];
}

export function ComparisonLoadStatus({ loading, error, hasComparison }: { loading: boolean; error: string | null; hasComparison: boolean }) {
  if (!error && (!loading || hasComparison)) return null;
  return (
    <div className="shrink-0">
      {loading && !hasComparison && <LoadingIndicator label={m.compare_loading()} />}
      {error && <div className="text-status-danger text-sm">{error}</div>}
    </div>
  );
}
function lapProcessingMessage(lap: LapMeta) {
  return lap.processing.state === "queued" ? m.recording_processing_queued()
    : lap.processing.state === "processing" ? m.recording_processing_running()
      : lap.processing.state === "failed" ? m.recording_processing_failed({ error: lap.processing.error })
        : null;
}

function LapProcessingNotice({ lap, onRefresh }: { lap: LapMeta; onRefresh: () => void }) {
  const processing = lap.processing;
  if (processing.state === "ready") return null;
  const pending = processing.state === "queued" || processing.state === "processing";
  return <div className="flex flex-wrap items-center gap-2 text-sm text-app-text-secondary" data-processing-state={processing.state}>
    {pending && <span aria-hidden="true" className="size-3 shrink-0 rounded-full border border-app-border-input border-t-app-accent motion-safe:animate-spin" />}
    <span role={pending ? "status" : "alert"} aria-live={pending ? "polite" : "assertive"}>{lapProcessingMessage(lap)}</span>
    {!pending && <Button type="button" variant="app-outline" size="app-sm" onClick={onRefresh}>{m.recording_processing_refresh()}</Button>}
  </div>;
}


export function ComparisonCursorLoadingIndicator({ loading, position }: { loading: boolean; position: { x: number; y: number } | null }) {
  return <PointerLoadingIndicator loading={loading} position={position} label={m.compare_fetching_higher_fidelity_datapoints()} />;
}

function usePanelOpen(key: string) {
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === "true" || stored === "false") return stored === "true";
    } catch {
      /* Storage may be unavailable. */
    }
    return typeof window === "undefined" || window.innerWidth > 800;
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(open));
    } catch {
      /* Keep panels usable when storage is unavailable. */
    }
  }, [key, open]);
  return [open, setOpen] as const;
}

export function LapComparison({ initialSearch }: { initialSearch?: CompareSearch } = {}) {
  return <LapComparisonInner initialSearch={initialSearch} />;
}

function LapComparisonInner({ initialSearch }: { initialSearch?: CompareSearch }) {
  const search = { ...initialSearch, track: compareTrackFromSearch(initialSearch?.track, initialSearch?.layout) };
  const navigate = useNavigate();
  const units = useUnits();
  const gameId = useGameId();
  const lapsQuery = useLaps();
  const { data: allLaps = [] } = lapsQuery;
  const laps = useMemo(() => allLaps.filter((l) => l.lapTime > 0 && l.trackId != null && l.carId != null), [allLaps]);
  const [trackGroups, setTrackGroups] = useState<TrackGroup[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<string | null>(search.track ?? null);
  const [carAId, setCarAId] = useState<string | null>(search.carA ?? null);
  const [carBId, setCarBId] = useState<string | null>(search.carB ?? null);
  const [lapAId, setLapAId] = useState<number | null>(search.lapA ?? null);
  const [lapBId, setLapBId] = useState<number | null>(search.lapB ?? null);
  const [requestedReferenceMode, setReferenceMode] = useState<"player" | "opponent">(search.reference ?? "player");
  const referenceMode = gameId === "lmu" ? requestedReferenceMode : "player";
  const [opponentLapId, setOpponentLapId] = useState<string | null>(search.opponentLap ?? null);
  const [opponentRevision, setOpponentRevision] = useState<string | null>(search.opponentRevision ?? null);
  const [opponentReferenceInvalidated, setOpponentReferenceInvalidated] = useState(false);
  // URL selections can outlive a track/car switch; never query a hidden lap.
  const visibleLapAId = lapAId != null && laps.some((lap) => lap.id === lapAId && lap.trackId === selectedTrack && lap.carId === carAId) ? lapAId : null;
  const visibleLapBId = lapBId != null && laps.some((lap) => lap.id === lapBId && lap.trackId === selectedTrack && lap.carId === carBId) ? lapBId : null;
  const selectedPlayerLap = visibleLapAId == null ? null : laps.find((lap) => lap.id === visibleLapAId) ?? null;
  const selectedPlayerLapB = visibleLapBId == null ? null : laps.find((lap) => lap.id === visibleLapBId) ?? null;
  const playerComparisonReady = selectedPlayerLap?.processing.state === "ready" && selectedPlayerLapB?.processing.state === "ready";
  const comparisonLapAId = referenceMode === "player" && selectedPlayerLap?.processing.state === "ready" ? visibleLapAId : null;
  const comparisonLapBId = referenceMode === "player" && selectedPlayerLapB?.processing.state === "ready" ? visibleLapBId : null;
  const comparisonQuery = useLapComparison(comparisonLapAId, comparisonLapBId);
  const comparisonError = referenceMode === "player" && playerComparisonReady ? comparisonQuery.error : null;
  const comparison = referenceMode === "player" && playerComparisonReady && !comparisonError ? comparisonQuery.data : undefined;
  const error = comparisonError ? m.compare_load_failed() : null;
  const loading = referenceMode === "player" && comparisonQuery.isFetching;
  const opponentStatusReadable = selectedPlayerLap?.processing.state === "ready";
  const opponentCatalogQuery = useOpponentLapCatalog(referenceMode === "opponent" && opponentStatusReadable ? visibleLapAId : null);
  const { data: opponentCatalog, error: opponentCatalogError } = opponentCatalogQuery;
  const opponentCatalogPending = opponentCatalog?.indexState === "queued" || opponentCatalog?.indexState === "building";
  const catalogForDisplay = opponentCatalogQuery.isFetching && !opponentCatalogPending && !opponentCatalog ? undefined : opponentCatalog;
  const catalogReady = opponentCatalog?.indexState === "ready" && !opponentCatalogError && selectedPlayerLap?.processing.state === "ready";
  const selectedOpponent = catalogReady ? opponentCatalog?.laps.find((lap) => lap.opponentLapId === opponentLapId) : undefined;
  const selectedOpponentRevision = catalogReady ? opponentCatalog?.sourceRevision : undefined;
  const opponentSelectionValid = selectedOpponent != null && opponentRevision === selectedOpponentRevision;
  useEffect(() => {
    if (referenceMode !== "opponent" || opponentCatalogQuery.isFetching || opponentCatalogError || !opponentCatalog) return;
    const revisionChanged = opponentLapId != null && opponentCatalog.sourceRevision !== opponentRevision;
    const selectionMissing = opponentLapId != null && opponentCatalog.indexState === "ready" &&
      !opponentCatalog.laps.some((lap) => lap.opponentLapId === opponentLapId);
    if (revisionChanged || selectionMissing) {
      setOpponentReferenceInvalidated(true);
      setOpponentLapId(null);
      setOpponentRevision(null);
    } else if (opponentCatalog.indexState === "not-required") {
      setOpponentReferenceInvalidated(false);
      setOpponentLapId(null);
      setOpponentRevision(null);
    }
  }, [referenceMode, opponentCatalogQuery.isFetching, opponentCatalogError, opponentCatalog, opponentRevision, opponentLapId]);
  const opponentRequest = referenceMode === "opponent" && catalogReady && selectedPlayerLap?.processing.state === "ready"
    && visibleLapAId != null && opponentSelectionValid && opponentLapId && selectedOpponentRevision
    ? { opponentLapId, sourceRevision: selectedOpponentRevision, step: 1 as const }
    : null;
  const opponentComparisonQuery = useOpponentLapComparison(visibleLapAId, opponentRequest);
  const opponentComparison = catalogReady && !opponentComparisonQuery.error ? opponentComparisonQuery.data : undefined;
  const opponentComparisonLoading = opponentCatalogQuery.isLoading
    || (opponentCatalogQuery.isFetching && !opponentCatalogPending)
    || opponentComparisonQuery.isFetching;
  const opponentComparisonError = opponentCatalogError ?? opponentComparisonQuery.error;
  const processingLap = referenceMode === "opponent"
    ? selectedPlayerLap?.processing.state !== "ready" ? selectedPlayerLap : null
    : !selectedPlayerLap || selectedPlayerLap.processing.state === "ready"
      ? selectedPlayerLapB?.processing.state !== "ready" ? selectedPlayerLapB : null
      : selectedPlayerLap;
  const opponentReplayComparison = useMemo(() => {
    if (!catalogReady || !selectedPlayerLap || selectedPlayerLap.processing.state !== "ready" || !selectedOpponent || !opponentRevision || !opponentSelectionValid || selectedOpponent.mode !== "telemetry") return null;
    if (!selectedOpponent.comparableSemanticIds.includes("race.competitor.scoring-time") ||
        !selectedOpponent.comparableSemanticIds.includes("race.competitor.lap-start-time")) return null;
    return {
      kind: "opponent" as const, playerLap: selectedPlayerLap, opponent: selectedOpponent,
      reference: { kind: "opponent" as const, playerLapId: selectedPlayerLap.id, opponentLapId: selectedOpponent.opponentLapId, sourceRevision: opponentRevision },
    };
  }, [catalogReady, selectedPlayerLap, selectedOpponent, opponentRevision, opponentSelectionValid]);
  const [carNames, setCarNames] = useState<Map<string, string>>(new Map());
  const [zoomLevels, setZoomLevels] = useState<Array<ChartRange | null>>([null]);
  const [detailRange, setDetailRange] = useState<{ start: number; end: number; stepMeters: 0.1 } | null>(null);
  const [optimisticRange, setOptimisticRange] = useState<ComparisonRangeData | null>(null);
  const fullDistance = comparison?.traces.distance.at(-1) ?? 0;
  const {
    data: comparisonRange,
    isPlaceholderData: comparisonRangeIsPlaceholder,
    isFetching: comparisonRangeIsFetching,
  } = useLapComparisonRange(comparisonLapAId, comparisonLapBId, detailRange?.stepMeters ?? null, detailRange?.start ?? null, detailRange?.end ?? null);
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
  const visibleRange = zoomLevels.at(-1) ?? null;
  const activeRange = visibleRange == null ? null : (optimisticRange ?? comparisonRange);
  const mergedComparison = useMemo(() => (comparison && activeRange ? mergeComparisonRange(comparison, activeRange) : comparison), [comparison, activeRange]);
  const chartComparison = useMemo(() => (comparison && activeRange ? rangeComparison(comparison, activeRange) : comparison), [comparison, activeRange]);
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
  const prevTrackRef = useRef<string | null | undefined>(undefined);
  const prevCarARef = useRef<string | null | undefined>(undefined);
  const prevCarBRef = useRef<string | null | undefined>(undefined);
  const routeSelection = JSON.stringify([search.track ?? null, search.carA ?? null, search.carB ?? null, search.lapA ?? null, search.lapB ?? null, search.reference ?? "player", search.opponentLap ?? null, search.opponentRevision ?? null]);
  const writtenSelectionRef = useRef(routeSelection);
  const seenSelectionRef = useRef(routeSelection);
  const applyingSelectionRef = useRef<string | null>(null);
  const writtenLapPairRef = useRef(JSON.stringify([lapAId, lapBId, referenceMode, opponentLapId, opponentRevision]));
  useEffect(() => {
    if (seenSelectionRef.current === routeSelection) return;
    seenSelectionRef.current = routeSelection;
    if (writtenSelectionRef.current === routeSelection) return;
    applyingSelectionRef.current = routeSelection;
    prevTrackRef.current = search.track ?? null;
    prevCarARef.current = search.carA ?? null;
    prevCarBRef.current = search.carB ?? null;
    setSelectedTrack(search.track ?? null);
    setCarAId(search.carA ?? null);
    setCarBId(search.carB ?? null);
    setLapAId(search.lapA ?? null);
    setLapBId(search.lapB ?? null);
    setReferenceMode(search.reference ?? "player");
    setOpponentReferenceInvalidated(false);
    setOpponentLapId(search.opponentLap ?? null);
    setOpponentRevision(search.opponentRevision ?? null);
  }, [routeSelection, search.track, search.carA, search.carB, search.lapA, search.lapB, search.reference, search.opponentLap, search.opponentRevision]);
  const hoveredDistanceRef = useRef<number | null>(null);
  const mapRedrawRef = useRef<(() => void) | null>(null);
  const aiPanelRef = useRef<CompareAiPanelHandle | null>(null);
  const comparisonLayoutRef = useRef<HTMLDivElement>(null);
  const mapResizeCleanupRef = useRef<(() => void) | null>(null);
  const spectateDistanceRef = useMemo(() => ({ current: null as number | null }), [gameId, visibleLapAId, visibleLapBId]);
  const [spectateTelemetryOpen, setSpectateTelemetryOpen] = usePanelOpen("spectate-telemetry-open");
  const [spectateCarPanelOpen, setSpectateCarPanelOpen] = usePanelOpen("spectate-car-panel-open");
  const [spectatePanelHeader, setSpectatePanelHeader] = useState<HTMLDivElement | null>(null);
  const [compareAiHeaderControls, setCompareAiHeaderControls] = useState<HTMLDivElement | null>(null);
  const spectateActive = search.view !== "compare";
  const changeBodyView = useCallback((view: "compare" | "spectate") => {
    if (view === "spectate") spectateDistanceRef.current = hoveredDistanceRef.current;
    void navigate({
      search: (previous: Record<string, unknown>) => ({ ...previous, view: view === "spectate" ? undefined : view }) as never,
      resetScroll: false,
    });
  }, [navigate, spectateDistanceRef]);
  const receiveSpectateDistance = useCallback((distance: number | null) => {
    if (distance == null) return;
    spectateDistanceRef.current = distance;
    hoveredDistanceRef.current = distance;
    mapRedrawRef.current?.();
  }, [spectateDistanceRef]);
  const [comparisonLayoutWidth, setComparisonLayoutWidth] = useState(0);
  const [savedMapWidth, setSavedMapWidth] = useLocalStorage("compare-left-column-width", COMPARE_MAP_DEFAULT_WIDTH);
  const [overviewOpen, setOverviewOpen] = useState(false);
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
  const aiPanelWidth = Math.round(Math.min(310, (comparisonLayoutWidth || (typeof window === "undefined" ? 1024 : window.innerWidth)) * 0.88));
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
      if (!comparison || fullDistance <= 0) return;
      const currentStart = activeRange?.distanceStart ?? comparison.traces.distance[0] ?? 0;
      const currentEnd = activeRange?.distanceEnd ?? fullDistance;
      const fidelity = selectFidelity(end - start, Math.max(1, currentEnd - currentStart + 1));
      if (!fidelity) {
        setZoomLevels([null]);
        setOptimisticRange(null);
        setDetailRange(null);
        return;
      }
      const nextRange = normalizeFidelityRange(start, end, fullDistance);
      setZoomLevels((previous) => [...previous, { min: start, max: end }]);
      setOptimisticRange(activeRange ? cropComparisonRange(activeRange, start, end) : cropComparisonData(comparison, start, end));
      setDetailRange(nextRange);
    },
    [activeRange, comparison, fullDistance],
  );
  const handleZoomOut = useCallback(() => {
    if (zoomLevels.length <= 1) return;
    const previous = zoomLevels[zoomLevels.length - 2];
    setZoomLevels((current) => current.slice(0, -1));
    if (previous == null) {
      setOptimisticRange(null);
      setDetailRange(null);
      return;
    }
    if (!comparison) return;
    setOptimisticRange(cropComparisonData(comparison, previous.min, previous.max));
    setDetailRange(normalizeFidelityRange(previous.min, previous.max, fullDistance));
  }, [comparison, fullDistance, zoomLevels]);
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
  const appliedInitialCursor = useRef<string | null>(null);
  useEffect(() => {
    const cursorIdentity = `${gameId}:${visibleLapAId}:${visibleLapBId}:${search.cursor}`;
    if (appliedInitialCursor.current === cursorIdentity) return;
    const distances = comparison?.traces.distance;
    if (search.cursor != null && distances) {
      if (distances.length === 0) return;
      const idx = Math.max(0, Math.min(Math.floor(search.cursor), distances.length - 1));
      hoveredDistanceRef.current = distances[idx];
      spectateDistanceRef.current = distances[idx];
      mapRedrawRef.current?.();
      appliedInitialCursor.current = cursorIdentity;
    }
  }, [search.cursor, comparison, gameId, visibleLapAId, visibleLapBId, spectateDistanceRef]);

  // Sync selections to URL
  useEffect(() => {
    const selection = JSON.stringify([selectedTrack, carAId, carBId, lapAId, lapBId, referenceMode, opponentLapId, opponentRevision]);
    if (applyingSelectionRef.current != null && applyingSelectionRef.current !== selection) return;
    const lapPair = JSON.stringify([lapAId, lapBId, referenceMode, opponentLapId, opponentRevision]);
    const localPairChange = applyingSelectionRef.current == null && writtenLapPairRef.current !== lapPair;
    writtenLapPairRef.current = lapPair;
    if (localPairChange) {
      hoveredDistanceRef.current = null;
      spectateDistanceRef.current = null;
    }
    applyingSelectionRef.current = null;
    writtenSelectionRef.current = selection;
    const trackSearch = compareTrackSearch(selectedTrack);
    navigate({
      search: (prev: Record<string, unknown>) => {
        const rest = { ...prev };
        delete rest.track;
        delete rest.layout;
        delete rest.trackLayout;
        return {
          ...trackSearch,
          ...rest,
          carA: carAId ?? undefined,
          carB: carBId ?? undefined,
          lapA: lapAId ?? undefined,
          lapB: lapBId ?? undefined,
          reference: referenceMode === "opponent" ? "opponent" : undefined,
          opponentLap: referenceMode === "opponent" ? opponentLapId ?? undefined : undefined,
          opponentRevision: referenceMode === "opponent" && opponentLapId ? opponentRevision ?? undefined : undefined,
          cursor: localPairChange ? undefined : prev.cursor,
        } as never;
      },
      replace: true,
      resetScroll: false,
    });
  }, [selectedTrack, carAId, carBId, lapAId, lapBId, referenceMode, opponentLapId, opponentRevision, navigate, spectateDistanceRef]);

  // Build track groups and fetch names when laps data changes
  useEffect(() => {
    if (laps.length === 0) return;
    let cancelled = false;

    async function buildGroups() {
      const byTrack = new Map<string, LapMeta[]>();
      for (const lap of laps) {
        const trackId = lap.trackId!;
        const trackLaps = byTrack.get(trackId);
        if (trackLaps) trackLaps.push(lap);
        else byTrack.set(trackId, [lap]);
      }

      const groups = await Promise.all(
        Array.from(byTrack, async ([trackId, trackLaps]) => {
          let trackName = trackId;
          try {
            trackName = await client.api["track-name"][":trackId"].$get({ param: { trackId: encodeURIComponent(trackId) }, query: { gameId: gameId! } }).then((r) => (r.ok ? r.text() : trackName));
          } catch {}
          return { trackId, trackName, laps: trackLaps };
        }),
      );
      groups.sort((a, b) => a.trackName.localeCompare(b.trackName));

      const carIds = new Set(laps.map((lap) => lap.carId!));
      const names = new Map<string, string>();
      await Promise.all(
        Array.from(carIds, async (carId) => {
          try {
            names.set(carId, await client.api["car-name"][":carId"].$get({ param: { carId: encodeURIComponent(carId) }, query: { gameId: gameId! } }).then((r) => (r.ok ? r.text() : "")));
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
  // Saved chat links carry lap IDs only; restore their track/car context once laps load.
  useEffect(() => {
    if (laps.length === 0) return;
    const lapA = lapAId == null ? undefined : laps.find((lap) => lap.id === lapAId);
    const lapB = lapBId == null ? undefined : laps.find((lap) => lap.id === lapBId);
    const contextLap = lapA ?? lapB;
    if (!contextLap) return;
    if (selectedTrack == null && contextLap.trackId != null) {
      prevTrackRef.current = contextLap.trackId;
      setSelectedTrack(contextLap.trackId);
    }
    if (carAId == null && lapA?.carId != null) {
      prevCarARef.current = lapA.carId;
      setCarAId(lapA.carId);
    }
    if (carBId == null && lapB?.carId != null) {
      prevCarBRef.current = lapB.carId;
      setCarBId(lapB.carId);
    }
  }, [laps, lapAId, lapBId, selectedTrack, carAId, carBId]);


  // Reset car/lap selections when track changes (skip initial mount to preserve URL params)
  useEffect(() => {
    if (prevTrackRef.current === undefined) {
      prevTrackRef.current = selectedTrack;
    } else if (prevTrackRef.current !== selectedTrack) {
      setCarAId(null);
      setCarBId(null);
      setLapAId(null);
      setLapBId(null);
    }
  }, [selectedTrack]);

  // Reset lap A when car A changes, default car B to same
  useEffect(() => {
    if (prevCarARef.current === undefined) {
      prevCarARef.current = carAId;
    } else if (prevCarARef.current !== carAId) {
      prevCarARef.current = carAId;
      setLapAId(null);
      if (carAId != null && carBId == null) {
        setCarBId(carAId);
      }
    }
  }, [carAId]);

  // Reset lap B when car B changes
  useEffect(() => {
    if (prevCarBRef.current === undefined) {
      prevCarBRef.current = carBId;
    } else if (prevCarBRef.current !== carBId) {
      prevCarBRef.current = carBId;
      setLapBId(null);
    }
  }, [carBId]);

  useEffect(() => {
    setZoomLevels([null]);
    setDetailRange(null);
    setOptimisticRange(null);
    hoveredDistanceRef.current = null;
    spectateDistanceRef.current = null;
  }, [lapAId, lapBId, referenceMode, opponentLapId, opponentRevision, spectateDistanceRef]);

  // Laps filtered to selected track
  const trackLaps = selectedTrack != null ? (trackGroups.find((group) => group.trackId === selectedTrack)?.laps ?? []) : [];

  // Unique cars on this track
  const trackCars = Array.from(new Set(trackLaps.map((lap) => lap.carId).filter((carId): carId is string => carId != null)));

  // Laps filtered by car
  const carALaps = trackLaps.filter((lap) => lap.carId === carAId);
  const carBLaps = trackLaps.filter((lap) => lap.carId === carBId);

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
      <div data-compare-page-header="" className="flex shrink-0 flex-wrap items-end gap-3">
        <div className="min-w-0 max-w-full">
      <ComparisonSelectors
        trackGroups={trackGroups}
        selectedTrack={selectedTrack}
        setSelectedTrack={setSelectedTrack}
        carAId={carAId}
        setCarAId={setCarAId}
        carBId={carBId}
        setCarBId={setCarBId}
        lapAId={visibleLapAId}
        setLapAId={setLapAId}
        lapBId={visibleLapBId}
        setLapBId={setLapBId}
        trackCars={trackCars}
        carNames={carNames}
        carALaps={carALaps}
        carBLaps={carBLaps}
        referenceMode={referenceMode}
        onReferenceModeChange={gameId === "lmu" ? (mode) => {
          setReferenceMode(mode);
          setOpponentReferenceInvalidated(false);
          if (mode === "player") {
            setOpponentLapId(null);
            setOpponentRevision(null);
          }
        } : undefined}
        opponentLaps={catalogReady ? opponentCatalog?.laps ?? [] : []}
        opponentLapId={opponentLapId}
        onOpponentLapChange={(id) => {
          setOpponentReferenceInvalidated(false);
          setOpponentLapId(id);
          setOpponentRevision(id && catalogReady ? opponentCatalog?.sourceRevision ?? null : null);
        }}
      />
        </div>
          <Dialog open={overviewOpen} onOpenChange={setOverviewOpen}>
            <DialogTrigger disabled={!selectedTrack || referenceMode === "opponent" || !playerComparisonReady}
              className="shrink-0 rounded-sm border border-app-border px-3 py-2 text-app-label text-app-text-secondary hover:text-app-text focus-visible:outline-2 focus-visible:outline-app-accent disabled:cursor-not-allowed disabled:opacity-50">
              {m.compare_overview_title()}
            </DialogTrigger>
            {overviewOpen && (
              <DialogContent size="wide" className="flex max-h-[90vh] flex-col gap-0 overflow-hidden bg-app-bg p-0">
                <DialogHeader className="shrink-0 border-b border-app-border px-4 py-3 pr-12 sm:px-6">
                  <DialogTitle className="text-app-subtext font-semibold">{m.compare_overview_title()}</DialogTitle>
                  <DialogDescription className="text-app-caption text-app-text-muted">{m.compare_overview_scope()}</DialogDescription>
                </DialogHeader>
                <div data-overview-scroll="" className="min-h-0 overflow-y-auto">
                  <CompareOverview
                    comparison={visibleLapAId && visibleLapBId && visibleLapAId !== visibleLapBId ? comparison : undefined}
                    selectionStatus={comparison && visibleLapAId && visibleLapBId && visibleLapAId !== visibleLapBId ? null : processingLap ? lapProcessingMessage(processingLap) : loading ? <LoadingIndicator label={m.compare_loading()} /> : error ? error : visibleLapAId != null && visibleLapAId === visibleLapBId ? m.compare_select_different_laps() : m.compare_select_two_laps()}
                    pickerA={<CompareOverviewPicker side="a" cars={trackCars} carNames={carNames} carId={carAId} lapId={visibleLapAId} laps={carALaps} onCarChange={setCarAId} onLapChange={setLapAId} />}
                    pickerB={<CompareOverviewPicker side="b" cars={trackCars} carNames={carNames} carId={carBId} lapId={visibleLapBId} laps={carBLaps} onCarChange={setCarBId} onLapChange={setLapBId} />} />
                </div>
              </DialogContent>
            )}
          </Dialog>
      </div>
      {referenceMode === "opponent"
        ? processingLap && processingLap.processing.stage !== "opponent-index"
          ? <LapProcessingNotice lap={processingLap} onRefresh={() => { void lapsQuery.refetch(); }} />
          : <OpponentComparisonPanel
              catalog={catalogForDisplay}
              summary={selectedOpponent}
              comparison={opponentComparison}
              loading={opponentComparisonLoading}
              error={opponentComparisonError}
              playerLap={selectedPlayerLap}
              processingLap={processingLap}
              selectionValid={opponentSelectionValid}
              hasSelection={opponentLapId != null || opponentReferenceInvalidated}
              onRefreshStatus={() => { void opponentCatalogQuery.refetch(); }}
              onProcessingRefresh={() => { void opponentCatalogQuery.refetch(); }}
              replay={gameId && opponentReplayComparison ? <div className="mt-4 flex min-h-[38rem] flex-col" data-opponent-replay>
                <SpectateSession key={`${gameId}:${opponentRevision}:${opponentLapId}`} gameId={gameId} comparison={opponentReplayComparison}
                  active outline={trackOutline} segments={trackSegments ?? []} distanceRef={spectateDistanceRef} onDistanceChange={receiveSpectateDistance}
                  aiOpen={false} telemetryOpen={spectateTelemetryOpen} carPanelOpen={spectateCarPanelOpen} onTelemetryOpenChange={setSpectateTelemetryOpen}
                  onCarPanelOpenChange={setSpectateCarPanelOpen} onAiOpenChange={toggleAiPanel} panelHeaderTarget={null}
                  onOpponentStatusRefresh={() => { void opponentCatalogQuery.refetch(); }} />
              </div> : null}
            />
        : <>
      <ComparisonLoadStatus loading={loading} error={error} hasComparison={comparison != null} />
      {processingLap && <LapProcessingNotice lap={processingLap} onRefresh={() => { void lapsQuery.refetch(); }} />}
      <div className="-mt-2 -mb-4 flex shrink-0 flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-app-border text-app-label">
        <div role="tablist" aria-label={m.spectate_body_views()} className="flex gap-4">
          {(["spectate", "compare"] as const).map((view) => (
            <button key={view} id={`compare-tab-${view}`} type="button" role="tab" aria-controls={`compare-body-${view}`} aria-selected={view === (spectateActive ? "spectate" : "compare")} tabIndex={view === (spectateActive ? "spectate" : "compare") ? 0 : -1}
              className={`border-b-2 px-1 pb-2 focus-visible:outline-2 focus-visible:outline-app-accent ${view === (spectateActive ? "spectate" : "compare") ? "border-app-accent text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-text"}`}
              onClick={() => changeBodyView(view)}
              onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") { event.preventDefault(); const next = event.key === "Home" ? "spectate" : event.key === "End" ? "compare" : view === "compare" ? "spectate" : "compare"; changeBodyView(next); document.getElementById(`compare-tab-${next}`)?.focus(); } }}>
              {view === "spectate" ? m.spectate_view() : m.compare_focus_view()}
            </button>
          ))}
        </div>
        <div className="relative ml-auto flex max-w-full min-w-0 flex-wrap items-end justify-end gap-2">
          {spectateActive && <div ref={setSpectatePanelHeader} className="flex min-w-0 max-w-full flex-wrap items-end justify-end" />}
          {!spectateActive && <div data-panel-header="compare-ai-panel"
            className={`flex h-10 max-w-[88vw] shrink-0 items-center border-b-2 border-l border-l-app-border bg-app-bg ${aiPanelOpen ? "border-b-app-accent" : "border-b-transparent"}`}
            style={{ width: aiPanelOpen ? aiPanelWidth : 112 }}>
            <button data-panel-toggle="compare-ai-panel" type="button" aria-pressed={aiPanelOpen} aria-expanded={aiPanelOpen} aria-controls={aiPanelOpen ? "compare-ai-panel" : undefined} disabled={!comparison} onClick={toggleAiPanel}
              className={`flex h-full min-w-0 flex-1 items-center px-3 text-left text-app-label focus-visible:outline-2 focus-visible:outline-app-accent disabled:cursor-not-allowed disabled:opacity-50 ${aiPanelOpen ? "text-app-accent" : "text-app-text-secondary hover:text-app-text"}`}>
              <span className="truncate">{m.label_ai_analysis()}</span>
            </button>
            {aiPanelOpen && <div ref={setCompareAiHeaderControls} className="shrink-0 pr-3" />}
          </div>}
        </div>
      </div>
      {comparison?.traces.distance.length && gameId && visibleLapAId && visibleLapBId && visibleLapAId !== visibleLapBId ? (
        <div id="compare-body-spectate" role="tabpanel" aria-labelledby="compare-tab-spectate" hidden={!spectateActive} className={spectateActive ? "flex min-h-[32rem] flex-1 flex-col @5xl/workspace:min-h-0" : "hidden"}>
          <SpectateSession key={`${gameId}:${visibleLapAId}:${visibleLapBId}`} gameId={gameId} comparison={comparison} active={spectateActive} outline={trackOutline} segments={trackSegments ?? []} distanceRef={spectateDistanceRef} onDistanceChange={receiveSpectateDistance} aiOpen={aiPanelOpen} telemetryOpen={spectateTelemetryOpen} carPanelOpen={spectateCarPanelOpen} onTelemetryOpenChange={setSpectateTelemetryOpen} onCarPanelOpenChange={setSpectateCarPanelOpen} onAiOpenChange={toggleAiPanel} panelHeaderTarget={spectatePanelHeader} cursor={search.lapA === visibleLapAId && search.lapB === visibleLapBId ? search.cursor : undefined} />
        </div>
      ) : null}

      {/* No selection prompt */}
      {!visibleLapAId || !visibleLapBId ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">{m.compare_select_two_laps()}</div>
      ) : visibleLapAId === visibleLapBId ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">{m.compare_select_different_laps()}</div>
      ) : comparison?.traces.distance.length ? (
        <div
          id="compare-body-compare"
          role="tabpanel"
          aria-labelledby="compare-tab-compare"
          hidden={spectateActive}
          ref={comparisonLayoutRef}
          className={spectateActive ? "hidden" : "relative flex flex-none flex-col gap-4 overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:flex-row @5xl/workspace:overflow-hidden"}
        >
          {/* Left: track map */}
          <div
            className="h-[42rem] w-full shrink-0 @5xl/workspace:h-full @5xl/workspace:min-h-0 @5xl/workspace:w-(--compare-map-width)"
            style={{ "--compare-map-width": `${mapWidth}px` } as CSSProperties}
          >
            <CompareTrackMap
              outline={trackOutline ?? syntheticOutline}
              traces={mergedComparison?.traces ?? comparison.traces}
              labelA={`${carNames.get(comparison.lapA.carId!) || m.compare_car_a_fallback()} — ${m.compare_lap_label()} ${comparison.lapA.lapNumber}`}
              labelB={`${carNames.get(comparison.lapB.carId!) || m.compare_car_b_fallback()} — ${m.compare_lap_label()} ${comparison.lapB.lapNumber}`}
              lapTimeA={formatLapTime(comparison.lapA.lapTime)}
              lapTimeB={formatLapTime(comparison.lapB.lapTime)}
              segments={segmentTimings}
              hoveredDistanceRef={hoveredDistanceRef}
              redrawRef={mapRedrawRef}
              trackId={selectedTrack}
              gameId={gameId}
            />
          </div>

          <hr
            aria-label={m.compare_resize_track_map()}
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
          <ComparisonCharts
            comparison={chartComparison ?? comparison}
            units={units}
            onCursorMove={handleCursorMove}
            onRangeSelect={handleRangeSelect}
            visibleRange={visibleRange}
            refining={detailLoading}
            onZoomOut={handleZoomOut}
          />

          {/* AI compare sidebar */}
          {aiPanelOpen && (
            <CompareAiSidebar
              lapA={{
                id: lapAId!,
                label: `${carNames.get(comparison.lapA.carId!) || m.compare_car_a_fallback()} — ${m.compare_lap_label()} ${comparison.lapA.lapNumber} (${formatLapTime(comparison.lapA.lapTime)})`,
                lapTime: comparison.lapA.lapTime,
              }}
              lapB={{
                id: lapBId!,
                label: `${carNames.get(comparison.lapB.carId!) || m.compare_car_b_fallback()} — ${m.compare_lap_label()} ${comparison.lapB.lapNumber} (${formatLapTime(comparison.lapB.lapTime)})`,
                lapTime: comparison.lapB.lapTime,
              }}
              panelRef={aiPanelRef}
              headerTarget={compareAiHeaderControls}
              width={aiPanelWidth}
              segments={segmentTimings}
              onJumpToFrac={handleJumpToFrac}
            />
          )}
        </div>
      ) : comparison ? (
        <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm">{m.compare_telemetry_unavailable()}</div>
      ) : null}
      </>}
    </div>
  );
}

function OpponentComparisonPanel({
  catalog,
  summary,
  comparison,
  loading,
  error,
  playerLap,
  processingLap,
  selectionValid,
  hasSelection,
  onRefreshStatus,
  onProcessingRefresh,
  replay,
}: {
  catalog: OpponentLapCatalog | undefined;
  summary: OpponentLapSummary | undefined;
  comparison: OpponentLapComparison | undefined;
  loading: boolean;
  error: Error | null;
  playerLap: LapMeta | null;
  processingLap: LapMeta | null;
  selectionValid: boolean;
  hasSelection: boolean;
  onRefreshStatus: () => void;
  onProcessingRefresh: () => void;
  replay: ReactNode;
}) {
  const [exporting, setExporting] = useState(false);
  const resolved = (value: { state: string; value: number | null } | undefined) =>
    value?.state === "ok" && typeof value.value === "number" && Number.isFinite(value.value) ? value.value : null;
  const delta = resolved(comparison?.lapDeltaSeconds);
  if (loading) return processingLap
    ? <LapProcessingNotice lap={processingLap} onRefresh={onProcessingRefresh} />
    : <div className="flex min-h-48 items-center justify-center text-app-text-secondary">{m.compare_loading()}</div>;
  if (error instanceof OpponentQueryError && error.code === "OPPONENT_DATA_REMOVED") {
    return <div role="status" data-opponent-state="removed" className="p-4 text-app-text-secondary">{m.compare_opponent_removed()}</div>;
  }
  if (error instanceof OpponentQueryError && ["SOURCE_CHANGED", "OPPONENT_LAP_NOT_FOUND", "OPPONENT_DATA_UNAVAILABLE"].includes(error.code ?? "")) {
    return <div role="status" data-opponent-state={error.code === "SOURCE_CHANGED" ? "source-changed" : "unavailable"} className="p-4 text-app-text-secondary">{m.analyse_unavailable()}</div>;
  }
  if (catalog?.opponentRetention === "removed") return <div role="status" data-opponent-state="removed" className="p-4 text-app-text-secondary">{m.compare_opponent_removed()}</div>;
  if (catalog?.opponentRetention === "not-recorded") return <div role="status" data-opponent-state="not-recorded" className="p-4 text-app-text-secondary">{m.compare_opponent_not_recorded()}</div>;
  if (catalog?.opponentAvailability === "missing" || catalog?.opponentAvailability === "corrupt") return <div role="status" data-opponent-state={catalog.opponentAvailability} className="p-4 text-app-text-secondary">{catalog.opponentAvailability === "corrupt" ? m.storage_opponents_skip_invalid_source() : m.lmu_state_missing()}</div>;
  if (error instanceof OpponentQueryError && error.code === "OPPONENT_INDEX_FAILED") return <div role="alert" data-opponent-state="failed" className="flex flex-wrap items-center gap-2 p-4 text-status-danger">
    <span>{m.compare_opponent_index_failed()}</span><span>{error.message}</span>
    <Button type="button" variant="app-outline" size="app-sm" onClick={onRefreshStatus}>{m.recording_processing_refresh()}</Button>
  </div>;
  if (error instanceof OpponentQueryError && error.code === "OPPONENT_INDEX_NOT_READY") return <div role="status" data-opponent-state="not-ready" className="p-4 text-app-text-secondary">{m.compare_loading()}</div>;
  if (error) return <div role="alert" className="flex min-h-48 items-center justify-center text-status-danger">{m.compare_load_failed()}</div>;
  if (!catalog) return <div role="status" className="p-4 text-app-text-secondary">{m.compare_select_two_laps()}</div>;
  if (catalog.indexState === "waiting-finalization") return <div role="status" data-opponent-state="waiting-finalization" className="p-4 text-app-text-secondary">{m.compare_opponent_index_waiting()}</div>;
  if (catalog.indexState === "queued") return <div role="status" data-opponent-state="queued" className="p-4 text-app-text-secondary">{m.compare_opponent_index_queued()}</div>;
  if (catalog.indexState === "building") return <div role="status" data-opponent-state="building" className="p-4 text-app-text-secondary">{m.compare_opponent_index_building()}</div>;
  if (catalog.indexState === "failed") return <div role="alert" data-opponent-state="failed" className="flex flex-wrap items-center gap-2 p-4 text-status-danger">
    <span>{m.compare_opponent_index_failed()}</span>
    {playerLap?.processing.state === "failed" && playerLap.processing.stage === "opponent-index" && <span>{playerLap.processing.error}</span>}
    <Button type="button" variant="app-outline" size="app-sm" onClick={onRefreshStatus}>{m.recording_processing_refresh()}</Button>
  </div>;
  if (catalog.indexState === "not-required") return <div role="status" data-opponent-state="not-required" className="p-4 text-app-text-secondary">{m.sessions_opponents_unavailable()}</div>;
  if (processingLap) return <LapProcessingNotice lap={processingLap} onRefresh={onProcessingRefresh} />;
  if (hasSelection && !selectionValid) return <div role="status" data-opponent-state="source-changed" className="p-4 text-app-text-secondary">{m.analyse_unavailable()}</div>;
  if (!summary && catalog.laps.length === 0) return <div role="status" data-opponent-state="ready-empty" className="p-4 text-app-text-secondary">{m.compare_opponent_no_laps()}</div>;
  if (!summary) return <div role="status" data-opponent-state="ready" className="p-4 text-app-text-secondary">{m.compare_opponent_lap()}</div>;
  const reasons: Record<OpponentLapSummary["reasons"][number], string> = {
    "partial-lap": m.compare_opponent_coverage_partial(),
    "invalid-lap": m.sessions_cleanup_invalid(),
    "unknown-validity": `${m.driver_validity()}: ${m.common_unknown()}`,
    "restricted-channels": m.compare_opponent_restricted_channels(),
    "missing-timing": `${m.label_lap_time()}: ${m.analyse_unavailable()}`,
    "missing-distance": m.compare_telemetry_unavailable(),
    "missing-position": m.spectate_pose_unavailable(),
    "no-comparable-data": m.compare_telemetry_unavailable(),
  };
  return <section className="min-h-48 p-4" data-testid="opponent-comparison" data-opponent-state="ready" data-mode={comparison?.mode ?? summary.mode}>
    <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2 border-b border-app-border pb-3">
      <h2 className="text-app-subtext font-semibold">{summary.driverName ?? m.compare_reference_opponents()} · {summary.carName ?? m.compare_car_fallback()}</h2>
      <span className="text-app-caption text-app-text-secondary">{m.compare_lap_label()} {summary.lapNumber ?? "?"} · {summary.coverage === "complete" ? m.compare_opponent_coverage_complete() : m.compare_opponent_coverage_partial()} · {summary.validity === "valid" ? m.sessions_cleanup_valid() : summary.validity === "invalid" ? m.sessions_cleanup_invalid() : m.common_unknown()}</span>
    </header>
    <dl className="mt-3 grid grid-cols-1 gap-3 @md/workspace:grid-cols-3">
      <div><dt className="text-app-caption text-app-text-muted">{m.compare_lap_a()}</dt><dd className="tabular-nums">{playerLap ? formatLapTime(playerLap.lapTime) : "—"}</dd></div>
      <div><dt className="text-app-caption text-app-text-muted">{m.compare_opponent_lap()}</dt><dd className="tabular-nums">{resolved(summary.lapTime) == null ? "—" : formatLapTime(resolved(summary.lapTime)!)}</dd></div>
      <div><dt className="text-app-caption text-app-text-muted">{m.compare_time_delta()}</dt><dd className="tabular-nums">{delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(3)} s`}</dd></div>
    </dl>
    <Button type="button" variant="app-outline" size="app-sm" className="mt-3"
      disabled={exporting || !playerLap || !selectionValid}
      onClick={async () => {
        if (!playerLap || !selectionValid) return;
        setExporting(true);
        try {
          await exportLapsZip({ lapIds: [playerLap.id], opponent: { opponentLapId: summary.opponentLapId, sourceRevision: catalog.sourceRevision } });
        } catch (cause) { window.alert(cause instanceof Error ? cause.message : String(cause)); }
        finally { setExporting(false); }
      }}>{exporting ? m.analyse_exporting() : m.label_export()}</Button>
    {comparison?.sectorDeltas.length ? <section className="mt-4" aria-label={m.compare_overview_title()}>
      <h3 className="mb-2 text-app-caption font-semibold text-app-text-muted">{m.compare_overview_title()}</h3>
      <ul className="grid grid-cols-1 gap-2 @md/workspace:grid-cols-2">
        {comparison.sectorDeltas.map((sector) => {
          const value = resolved(sector.deltaSeconds);
          const sectorNumber = sector.semanticId.match(/\.s(\d+)$/)?.[1];
          return <li key={sector.semanticId} data-semantic-id={sector.semanticId} className="flex justify-between gap-3 rounded border border-app-border px-3 py-2">
            <span>{sectorNumber ? m.tunes_sector_title({ number: sectorNumber }) : sector.semanticId}</span><span className="tabular-nums">{value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(3)} s`}</span>
          </li>;
        })}
      </ul>
    </section> : null}
    {replay}
    {summary.reasons.length > 0 && <p className="mt-3 text-app-caption text-app-text-muted">{[...new Set(summary.reasons.map((reason) => reasons[reason]))].join(" · ")}</p>}
  </section>;
}
