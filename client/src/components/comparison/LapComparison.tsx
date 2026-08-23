import type { ComparisonData } from "@shared/racing/comparison/types";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { FindingEvidenceRef } from "@shared/racing/findings/types";
import { isTimedLapEligibilityUsable } from "@shared/racing/quality/policies";
const semanticNumber = (sample: ComparisonData["telemetryA"][number], id: keyof ComparisonData["telemetryA"][number]["values"]): number | undefined => {
  const value = sample.values[id];
  return typeof value === "number" ? value : undefined;
};

export function telemetryForFindingEvidence(comparison: Pick<ComparisonData, "lapA" | "lapB" | "telemetryA" | "telemetryB">, evidence: FindingEvidenceRef): SemanticTelemetrySample[] | null {
  if (evidence.kind !== "telemetry-range" || evidence.startFrameIndex == null) return null;
  if (evidence.lapId == null && evidence.sessionId == null) return null;
  const matches = (lap: ComparisonData["lapA"]) => (evidence.lapId == null || evidence.lapId === String(lap.id)) && (evidence.sessionId == null || evidence.sessionId === String(lap.sessionId));
  const matchesA = matches(comparison.lapA);
  const matchesB = matches(comparison.lapB);
  if (matchesA === matchesB) return null;
  return matchesA ? comparison.telemetryA : comparison.telemetryB;
}
import type { LapMeta } from "@shared/racing/sessions/types";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLaps } from "@/hooks/laps";
import { useTrackOutline, useTrackSectors } from "@/hooks/track-queries";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useUnits } from "@/hooks/useUnits";
import { COMPARE_MAP_DEFAULT_WIDTH, COMPARE_MAP_MIN_WIDTH, clampCompareMapWidth } from "@/lib/comparison-layout";
import type { Point } from "@/lib/comparison-utils";
import { formatLapTime } from "@/lib/format";
import type { CompareSearch } from "@/lib/game-routes";
import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";
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
  const prevTrackRef = useRef<number | null | undefined>(undefined);
  const prevCarARef = useRef<number | null | undefined>(undefined);
  const prevCarBRef = useRef<number | null | undefined>(undefined);
  const hoveredDistanceRef = useRef<number | null>(null);
  const mapRedrawRef = useRef<(() => void) | null>(null);
  const aiPanelRef = useRef<CompareAiPanelHandle | null>(null);
  const comparisonLayoutRef = useRef<HTMLDivElement>(null);
  const mapResizeCleanupRef = useRef<(() => void) | null>(null);
  const comparisonFindingPollsRef = useRef(0);
  const comparisonFindingTimerRef = useRef<number | null>(null);
  const comparisonIdentityRef = useRef("");
  const comparisonRequestSequenceRef = useRef(0);
  const comparisonAbortControllerRef = useRef<AbortController | null>(null);
  const comparisonIdentity = `${gameId ?? ""}:${lapAId ?? ""}:${lapBId ?? ""}`;
  comparisonIdentityRef.current = comparisonIdentity;
  useEffect(() => {
    comparisonFindingPollsRef.current = 0;
    if (comparisonFindingTimerRef.current != null) {
      window.clearTimeout(comparisonFindingTimerRef.current);
      comparisonFindingTimerRef.current = null;
    }
    comparisonAbortControllerRef.current?.abort();
    comparisonAbortControllerRef.current = null;
    comparisonIdentityRef.current = comparisonIdentity;
    comparisonRequestSequenceRef.current += 1;
  }, [comparisonIdentity]);
  useEffect(
    () => () => {
      comparisonAbortControllerRef.current?.abort();
      if (comparisonFindingTimerRef.current != null) window.clearTimeout(comparisonFindingTimerRef.current);
      comparisonRequestSequenceRef.current += 1;
    },
    [],
  );
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
  const mapWidth = comparisonLayoutWidth > 0 ? clampCompareMapWidth(savedMapWidth, comparisonLayoutWidth, aiPanelOpen) : savedMapWidth;
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
  const handleFindingEvidence = useCallback(
    (evidence: FindingEvidenceRef) => {
      if (!comparison || evidence.kind !== "telemetry-range" || evidence.startFrameIndex == null) return;
      const telemetry = telemetryForFindingEvidence(comparison, evidence);
      const sample = telemetry?.[evidence.startFrameIndex];
      const distance = sample && semanticNumber(sample, "timing.distance-traveled");
      if (distance == null || !Number.isFinite(distance)) return;
      hoveredDistanceRef.current = distance;
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
        if (!isTimedLapEligibilityUsable(lap)) continue;
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
  const selectedLapA = allLaps.find((lap) => lap.id === lapAId);
  const selectedLapB = allLaps.find((lap) => lap.id === lapBId);

  // Fetch comparison when both laps selected
  const fetchComparison = useCallback(async () => {
    const requestIdentity = `${gameId ?? ""}:${lapAId ?? ""}:${lapBId ?? ""}`;
    const requestSequence = comparisonRequestSequenceRef.current + 1;
    comparisonRequestSequenceRef.current = requestSequence;
    comparisonAbortControllerRef.current?.abort();
    const controller = new AbortController();
    comparisonAbortControllerRef.current = controller;
    comparisonIdentityRef.current = requestIdentity;
    const isCurrentRequest = () => comparisonRequestSequenceRef.current === requestSequence && comparisonIdentityRef.current === requestIdentity && !controller.signal.aborted;

    if (comparisonFindingTimerRef.current != null) window.clearTimeout(comparisonFindingTimerRef.current);
    comparisonFindingTimerRef.current = null;
    if (!lapAId || !lapBId || lapAId === lapBId || !gameId) {
      comparisonFindingPollsRef.current = 0;
      if (isCurrentRequest()) {
        setLoading(false);
        setComparison(null);
      }
      return;
    }
    if (!isCurrentRequest()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await client.api.laps[":id1"].compare[":id2"].$get(
        { param: { id1: String(lapAId), id2: String(lapBId) } },
        { headers: { "X-Game-Id": gameId }, init: { signal: controller.signal } },
      );
      if (!isCurrentRequest()) return;
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; status?: string; retryable?: boolean };
        if (!isCurrentRequest()) return;
        if (res.status === 409 && body.status === "backfilling" && body.retryable === true && comparisonFindingPollsRef.current < 20) {
          comparisonFindingPollsRef.current += 1;
          setError("Findings are backfilling. Results will update automatically.");
          setComparison(null);
          comparisonFindingTimerRef.current = window.setTimeout(() => {
            if (isCurrentRequest()) void fetchComparison();
          }, 1500);
          return;
        }
        comparisonFindingPollsRef.current = 0;
        const msg = body.error ?? m.compare_load_failed();
        setError(msg.includes("no telemetry") ? m.compare_telemetry_unavailable() : msg);
        setComparison(null);
        return;
      }
      const comparisonData = await rpcJson<ComparisonData>(res);
      if (!isCurrentRequest()) return;
      if (comparisonData.gameId !== gameId) throw new Error("Comparison game does not match request");
      comparisonFindingPollsRef.current = 0;
      setComparison(comparisonData);
    } catch {
      if (!isCurrentRequest()) return;
      setError(m.compare_load_failed());
      setComparison(null);
    } finally {
      if (isCurrentRequest()) {
        setLoading(false);
      }
    }
  }, [lapAId, lapBId, gameId]);

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
            className="h-[42rem] w-full shrink-0 @5xl/workspace:h-full @5xl/workspace:min-h-0 @5xl/workspace:w-(--compare-map-width)"
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

          <ComparisonCharts comparison={comparison} units={units} onCursorMove={handleCursorMove} onEvidenceSelect={handleFindingEvidence} />

          {/* AI compare sidebar */}
          {aiPanelOpen && gameId && selectedLapA && selectedLapB && (
            <CompareAiSidebar
              gameId={gameId}
              lapA={{
                id: selectedLapA.id,
                label: `${carNames.get(comparison.lapA.carOrdinal ?? -1) || m.compare_car_a_fallback()} — ${m.compare_lap_label()} ${comparison.lapA.lapNumber} (${formatLapTime(comparison.lapA.lapTime)})`,
                lapTime: comparison.lapA.lapTime,
                sessionId: selectedLapA.sessionId,
                quality: selectedLapA.quality,
                eligibility: selectedLapA.eligibility,
                qualityGeneration: selectedLapA.qualityGeneration,
                analysisGenerationId: selectedLapA.analysisGenerationId,
                findingGenerationId: comparison.findingReceipts.lapA.generationId,
                findingContentHash: comparison.findingReceipts.lapA.contentHash,
                findingStatus: comparison.findingReceipts.lapA.status,
                source: selectedLapA.source,
              }}
              lapB={{
                id: selectedLapB.id,
                label: `${carNames.get(comparison.lapB.carOrdinal ?? -1) || m.compare_car_b_fallback()} — ${m.compare_lap_label()} ${comparison.lapB.lapNumber} (${formatLapTime(comparison.lapB.lapTime)})`,
                lapTime: comparison.lapB.lapTime,
                sessionId: selectedLapB.sessionId,
                quality: selectedLapB.quality,
                eligibility: selectedLapB.eligibility,
                qualityGeneration: selectedLapB.qualityGeneration,
                analysisGenerationId: selectedLapB.analysisGenerationId,
                findingGenerationId: comparison.findingReceipts.lapB.generationId,
                findingContentHash: comparison.findingReceipts.lapB.contentHash,
                findingStatus: comparison.findingReceipts.lapB.status,
                source: selectedLapB.source,
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
