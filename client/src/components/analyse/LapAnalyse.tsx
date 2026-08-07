import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import type { LapInsight } from "../../../../shared/racing/analysis/laps/insights/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiPanelHandle } from "@/components/ai/AiPanel";
import type { AnalysisHighlight } from "@/components/ai/analysis-types";
import { useCookieState } from "../../hooks/useCookieState";
import { useLapPlayback } from "../../hooks/useLapPlayback";
import { useUnits } from "../../hooks/useUnits";
import type { AnalyseSearch } from "../../lib/game-routes";
import { client } from "../../lib/rpc";
import { useRequiredGameId } from "../../stores/game";
import type { ChartsPanelHandle } from "./AnalyseChartsPanel";
import { AnalyseLapHeader } from "./AnalyseLapHeader";
import { AnalyseWorkspaceModals } from "./AnalyseWorkspaceModals";
import { AnalyseWorkspacePanels } from "./AnalyseWorkspacePanels";
import { AnalyseWorkspaceStatus } from "./AnalyseWorkspaceStatus";
import { semanticNumber, type Point, type TrackMapHandle } from "./track-map/types";
import { useAnalyseImports } from "./useAnalyseImports";
import { useAnalyseSelections } from "./useAnalyseSelections";

// ── Main Component ───────────────────────────────────────────────────

export function LapAnalyse() {
  return <LapAnalyseInner />;
}

function LapAnalyseInner() {
  const search = useSearch({ strict: false }) as AnalyseSearch;
  const units = useUnits();
  const gameId = useRequiredGameId();
  const queryClient = useQueryClient();
  const {
    laps,
    setLaps,
    lapLoading,
    lapError,
    parseError,
    telemetry,
    semanticFrames,
    semanticReplay,
    selectedTrack,
    setSelectedTrack,
    selectedCar,
    setSelectedCar,
    selectedLapId,
    setSelectedLapId,
    outline,
    mapLabels,
    boundaries,
    sectorData,
    sectors,
    segments,
    initialCursor,
    mapZoom,
    setMapZoom,
    rotateWithCar,
    setRotateWithCar,
    trackOverlay,
    setTrackOverlay,
    vizMode,
    setWheelTab,
    leftColWidth,
    setLeftColWidth,
    rightColWidth,
    setRightColWidth,
    topHeight,
    setTopHeight,
    trackNames,
    carNames,
    tracks,
    carsForTrack,
    filteredLaps,
    carName,
    trackName,
    setCarName,
    setTrackName,
    handleTrackChange,
    handleCarChange,
    cursorRef,
  } = useAnalyseSelections(search, gameId);
  const loading = lapLoading;
  const [cursorIdx, setCursorIdx] = useState(0);
  const [visualTimeFrac, setVisualTimeFrac] = useState<number | null>(null);
  const [sidebarTab, setSidebarTab] = useState<"live" | "insights">("live");
  const [playing, setPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [aiPanelOpen, setAiPanelOpen] = useCookieState("analyse-aiPanel", false);
  useEffect(() => {
    if (search.ai === 1) setAiPanelOpen(true);
  }, [search.ai, setAiPanelOpen]);
  const [aiHighlights, setAiHighlights] = useState<AnalysisHighlight[] | null>(null);
  const aiPanelRef = useRef<AiPanelHandle>(null);
  const [viewingTuneId, setViewingTuneId] = useState<number | null>(null);
  const lapLine = useMemo(() => {
    if (telemetry.length < 2) return null;
    const pts: Point[] = [];
    for (const p of telemetry) {
      const x = semanticNumber(p, "motion.position-x");
      const z = semanticNumber(p, "motion.position-z");
      if (x != null || z != null) pts.push({ x: x ?? 0, z: z ?? 0 });
    }
    return pts.length > 2 ? pts : null;
  }, [telemetry]);
  const playRef = useRef(false);
  const speedRef = useRef(1);
  const displayTelemetryRef = useRef(semanticFrames);
  useEffect(() => {
    displayTelemetryRef.current = semanticFrames;
  }, [semanticFrames]);
  const seekRef = useRef(0);
  const trackMapRef = useRef<TrackMapHandle>(null);
  const lastStateUpdateRef = useRef(0);
  const interpolatedTimeRef = useRef(0);
  const thumbRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const chartsPanelRef = useRef<ChartsPanelHandle>(null);
  const lapChangeCount = useRef(0);
  useEffect(() => {
    if (selectedLapId == null) return;
    lapChangeCount.current++;
    const initial = lapChangeCount.current === 1;
    setPlaying(false);
    playRef.current = false;
    if (!initial || !initialCursor) {
      setCursorIdx(0);
      cursorRef.current = 0;
    }
    setCarName(selectedCar != null ? (carNames[selectedCar] ?? "") : "");
    setTrackName(selectedTrack != null ? (trackNames[selectedTrack] ?? "") : "");
  }, [selectedLapId]);
  const appliedInitialCursor = useRef(false);
  useEffect(() => {
    if (appliedInitialCursor.current || initialCursor == null || telemetry.length <= 1) return;
    const idx = Math.min(initialCursor, telemetry.length - 1);
    setCursorIdx(idx);
    cursorRef.current = idx;
    appliedInitialCursor.current = true;
  }, [initialCursor, telemetry.length]);

  // Keep speedRef in sync and signal the animation to re-anchor timing
  const speedChangeRef = useRef(0);
  useEffect(() => {
    speedRef.current = playbackSpeed;
    speedChangeRef.current++;
  }, [playbackSpeed]);

  // Draw initial cursor overlays after URL cursor is applied
  useEffect(() => {
    if (!appliedInitialCursor.current) return;
    if (cursorIdx > 0 && telemetry.length > 1) {
      // Delay to let charts mount
      const timer = setTimeout(() => {
        trackMapRef.current?.updateCursor(cursorIdx);
        chartsPanelRef.current?.updateCursor(cursorIdx);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [cursorIdx, telemetry.length]);

  // Expose deterministic frame control for Playwright recording.
  // Mirrors Onboarding's hook so the full analyse cockpit (track dot, gauges,
  // traces) can be stepped frame-by-frame — same index -> identical pixels.
  useEffect(() => {
    if (!(window as unknown as Record<string, unknown>).__recording) return;
    const w = window as unknown as Record<string, unknown>;
    w.__setFrame = (n: number) => {
      const idx = Math.max(0, Math.min(telemetry.length - 1, n));
      setCursorIdx(idx);
      trackMapRef.current?.updateCursor(idx);
      chartsPanelRef.current?.updateCursor(idx);
    };
    w.__pauseAnimation = () => setPlaying(false);
    w.__totalFrames = telemetry.length;
    w.__frameTimes = telemetry.map((p) => semanticNumber(p, "timing.current-lap") ?? 0);
    return () => {
      w.__setFrame = undefined;
      w.__pauseAnimation = undefined;
      w.__totalFrames = undefined;
      w.__frameTimes = undefined;
    };
  }, [telemetry.length]);

  // Playback animation + keyboard controls
  const { updateOverlays } = useLapPlayback({
    playing,
    telemetry,
    playRef,
    speedRef,
    cursorRef,
    seekRef,
    speedChangeRef,
    lastStateUpdateRef,
    interpolatedTimeRef,
    trackMapRef,
    chartsPanelRef,
    thumbRef,
    progressRef,
    setCursorIdx,
    setPlaying,
  });

  const sectorTimes = useMemo(() => {
    if (!sectorData || !sectors) return null;
    const cursorDistance = semanticNumber(telemetry[cursorIdx], "timing.distance-traveled") ?? 0;
    const cursorFrac = telemetry.length > 1 ? (cursorDistance - sectorData.firstDist) / sectorData.lapDist : 0;
    let cursorSector = 0;
    for (let index = 1; index < sectors.sectorStarts.length; index++) {
      if (cursorFrac < sectors.sectorStarts[index]) break;
      cursorSector = index;
    }
    return { ...sectorData, times: sectorData.times, cursorSector };
  }, [sectorData, sectors, telemetry, cursorIdx]);

  const handleChartClick = useCallback(
    (idx: number) => {
      setCursorIdx(idx);
      cursorRef.current = idx;
      seekRef.current++;
      updateOverlays(idx);
    },
    [updateOverlays],
  );

  const handleScrubStart = useCallback(() => {
    setPlaying(false);
    playRef.current = false;
  }, []);

  const currentFrame = telemetry[cursorIdx] ?? null;
  const wearRate = useMemo(() => {
    if (!currentFrame || telemetry.length < 2) return null;
    const previous = telemetry[Math.max(0, cursorIdx - 60)];
    const currentTime = semanticNumber(currentFrame, "timing.current-lap");
    const previousTime = semanticNumber(previous, "timing.current-lap");
    const dt = (currentTime ?? 0) - (previousTime ?? 0);
    const currentWear = currentFrame.values["tires.tire-wear"];
    const previousWear = previous.values["tires.tire-wear"];
    if (dt <= 0.1 || !Array.isArray(currentWear) || !Array.isArray(previousWear)) return null;
    const values = [0, 1, 2, 3].map((index) => {
      const current = currentWear[index];
      const prior = previousWear[index];
      return typeof current === "number" && typeof prior === "number" ? (current - prior) / dt : null;
    });
    return values.every((value): value is number => value != null) ? { FL: values[0], FR: values[1], RL: values[2], RR: values[3] } : null;
  }, [currentFrame, cursorIdx, telemetry]);
  const lapInsights = useMemo<LapInsight[]>(() => (semanticReplay?.insights ?? []) as LapInsight[], [semanticReplay]);
  const currentTime = playing ? interpolatedTimeRef.current : semanticNumber(currentFrame, "timing.current-lap") ?? 0;
  const selectedLap = laps.find((l) => l.id === selectedLapId);
  const totalTime = selectedLap?.lapTime ?? 0;

  // Tune selector
  const { data: availableTunes } = useQuery({
    queryKey: ["tunes", selectedLap?.carOrdinal],
    queryFn: () => client.api.tunes.$get({ query: { carOrdinal: selectedLap?.carOrdinal != null ? String(selectedLap.carOrdinal) : undefined } }).then((r) => r.json() as any),
    enabled: !!selectedLap?.carOrdinal,
  });

  const updateLapTune = useMutation({
    mutationFn: (tuneId: number | null) => client.api.laps[":id"].tune.$patch({ param: { id: String(selectedLapId) }, json: { tuneId } }).then((r) => r.json() as any),
    onMutate: (tuneId) => {
      // Optimistically update local laps state so dropdown doesn't reset
      setLaps((prev) =>
        prev.map((l) => (l.id === selectedLapId ? { ...l, tuneId: tuneId ?? undefined, tuneName: availableTunes?.find((t: { id: number; name: string }) => t.id === tuneId)?.name } : l)),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["laps"] });
    },
  });

  const updateLapNotesMutation = useMutation({
    mutationFn: (notes: string) => client.api.laps[":id"].notes.$patch({ param: { id: String(selectedLapId) }, json: { notes: notes || null } }).then((r) => r.json() as any),
    onMutate: (notes) => {
      setLaps((prev) => prev.map((l) => (l.id === selectedLapId ? { ...l, notes: notes || undefined } : l)));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["laps"] });
    },
  });

  const deleteLapMutation = useMutation({
    mutationFn: (lapId: number) => client.api.laps[":id"].$delete({ param: { id: String(lapId) } }).then((r) => r.json() as any),
    onSuccess: () => {
      setSelectedLapId(null);
      queryClient.invalidateQueries({ queryKey: ["laps"] });
    },
  });

  const handleDeleteLap = useCallback(() => {
    if (!selectedLapId) return;
    const lap = filteredLaps.find((l) => l.id === selectedLapId);
    const label = lap ? `Lap ${lap.lapNumber}` : `Lap ${selectedLapId}`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    deleteLapMutation.mutate(selectedLapId);
  }, [selectedLapId, filteredLaps, deleteLapMutation]);


  const { exportingBin, importingBin, ownership, setOwnership, importResult, ibtPreview, handleExportBin, handleImportBin, handleCancelIbt, handleCommitIbt, setImportResult } = useAnalyseImports({
    queryClient,
    gameId,
    setSelectedTrack,
    setSelectedCar,
    setSelectedLapId,
  });

  return (
    <div data-testid="lap-analyse-workspace" className="flex min-h-full min-w-0 flex-col @5xl/workspace:h-full @5xl/workspace:min-h-0 @5xl/workspace:overflow-hidden">
      {/* Header: cascading selectors + export */}
      <AnalyseLapHeader
        onExport={() => undefined}
        onExportBin={() => undefined}
        selectedTrack={selectedTrack}
        selectedCar={selectedCar}
        selectedLapId={selectedLapId}
        selectedLap={selectedLap}
        trackNames={trackNames}
        carNames={carNames}
        tracks={tracks}
        carsForTrack={carsForTrack}
        filteredLaps={filteredLaps}
        hasTelemetry={telemetry.length > 0}
        hasF1Setup={false}
        availableTunes={availableTunes}
        tunePending={updateLapTune.isPending}
        loading={loading}
        aiPanelOpen={aiPanelOpen}
        onTrackChange={handleTrackChange}
        onCarChange={handleCarChange}
        onLapChange={setSelectedLapId}
        onTuneChange={(tuneId) => updateLapTune.mutate(tuneId)}
        onViewTune={setViewingTuneId}
        onShowSetup={() => undefined}
        onImportBin={handleImportBin}
        exportingBin={exportingBin}
        importingBin={importingBin}
        onToggleAi={() => setAiPanelOpen((v) => !v)}
        onDeleteLap={handleDeleteLap}
        onNotesChange={(notes) => updateLapNotesMutation.mutate(notes)}
      />

      {telemetry.length === 0 && <AnalyseWorkspaceStatus loading={loading} lapError={lapError} parseError={parseError} selectedLapId={selectedLapId} />}

      {telemetry.length > 0 && (
        <AnalyseWorkspacePanels
          topSectionProps={{
            gameId,
            topHeight,
            leftColWidth,
            rightColWidth,
            onLeftResize: setLeftColWidth,
            onRightResize: setRightColWidth,
            telemetry,
            cursorIdx,
            outline,
            mapLabels,
            boundaries,
            sectors,
            segments,
            currentFrame,
            displayTelemetry: semanticFrames,
            lapLine,
            units,
            aiPanelOpen,
            aiHighlights,
            rotateWithCar,
            trackOverlay,
            mapZoom,
            onRotateWithCarToggle: () => setRotateWithCar((r) => !r),
            onTrackOverlayCycle: () => setTrackOverlay((v) => (v === "none" ? "inputs" : v === "inputs" ? "segments" : v === "segments" ? "sectors" : "none")),
            onMapZoomChange: setMapZoom,
            vizMode,
            onVizModeChange: setWheelTab,
            trackMapRef,
            cursorRef,
            displayTelemetryRef,
          }}
          resizeHandleProps={{ topHeight, onHeightChange: setTopHeight }}
          timelineScrubberProps={{
            displayTelemetry: semanticFrames,
            cursorIdx,
            totalPackets: telemetry.length,
            currentTime,
            totalTime,
            lapNumber: selectedLap?.lapNumber ?? "?",
            sectorTimes,
            playing,
            playbackSpeed,
            visualTimeFrac,
            progressRef,
            thumbRef,
            onTogglePlay: () => setPlaying((p) => !p),
            onSpeedChange: setPlaybackSpeed,
            onSeek: handleChartClick,
            onVisualFracChange: setVisualTimeFrac,
          }}
          chartsPanelProps={{
            totalPackets: telemetry.length,
            displayTelemetry: semanticFrames,
            visualTimeFrac,
            onVisualFracChange: setVisualTimeFrac,
            onClickIndex: handleChartClick,
            onScrubStart: handleScrubStart,
            speedLabel: units.speedLabel,
            tempLabel: units.tempLabel,
          }}
          chartsPanelRef={chartsPanelRef}
          displayTelemetryLength={semanticFrames.length}
          dataPanelProps={{
            sidebarTab,
            onSidebarTabChange: setSidebarTab,
            currentFrame,
            startFuel: semanticNumber(telemetry[0], "fuel.fuel") ?? undefined,
            gameId,
            units,
            wearRate,
            lapInsights,
            onJumpToFrame: handleChartClick,
          }}
          aiSidebarProps={
            aiPanelOpen && selectedLapId
              ? {
                  lapId: selectedLapId,
                  trackName,
                  carName,
                  segments,
                  aiPanelRef,
                  onJumpToFrac: (frac) => {
                    handleChartClick(Math.round(frac * (telemetry.length - 1)));
                  },
                  onHighlightsChange: setAiHighlights,
                }
              : null
          }
        />
      )}
      <AnalyseWorkspaceModals
        viewingTuneId={viewingTuneId}
        onCloseTune={() => setViewingTuneId(null)}
        ibtPreview={ibtPreview}
        setup={null}
        onCloseSetup={() => undefined}
        importingBin={importingBin}
        ownership={ownership}
        onOwnershipChange={setOwnership}
        onCommitIbt={() => void handleCommitIbt()}
        onCancelIbt={handleCancelIbt}
        importResult={importResult}
        gameId={gameId}
        setSelectedTrack={setSelectedTrack}
        setSelectedCar={setSelectedCar}
        setSelectedLapId={setSelectedLapId}
        onCloseImport={() => setImportResult(null)}
      />
    </div>
  );
}
