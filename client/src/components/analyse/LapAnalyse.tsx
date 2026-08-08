import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiPanelHandle } from "@/components/ai/AiPanel";
import type { AnalysisHighlight } from "@/components/ai/analysis-types";
import { useSettings } from "../../hooks/settings";
import { useCookieState } from "../../hooks/useCookieState";
import { useLapPlayback } from "../../hooks/useLapPlayback";
import { useUnits } from "../../hooks/useUnits";
import type { AnalyseSearch } from "../../lib/game-routes";
import { buildExportCsv } from "../../lib/lap-export";
import { client } from "../../lib/rpc";
import { useRequiredGameId } from "../../stores/game";
import type { ChartsPanelHandle } from "./AnalyseChartsPanel";
import { AnalyseLapHeader } from "./AnalyseLapHeader";
import { AnalyseWorkspaceModals } from "./AnalyseWorkspaceModals";
import { AnalyseWorkspacePanels } from "./AnalyseWorkspacePanels";
import { AnalyseWorkspaceStatus } from "./AnalyseWorkspaceStatus";
import type { Point, TrackMapHandle } from "./track-map/types";
import { useAnalyseImports } from "./useAnalyseImports";
import { useAnalyseSelections } from "./useAnalyseSelections";

// ── Main Component ───────────────────────────────────────────────────

export function LapAnalyse({ trackOrdinal, carOrdinal, lapId }: { trackOrdinal: number; carOrdinal: number; lapId: number }) {
  return <LapAnalyseInner trackOrdinal={trackOrdinal} carOrdinal={carOrdinal} lapId={lapId} />;
}

function LapAnalyseInner({ trackOrdinal, carOrdinal, lapId }: { trackOrdinal: number; carOrdinal: number; lapId: number }) {
  const navigate = useNavigate();

  const search = useSearch({ strict: false }) as AnalyseSearch;
  const units = useUnits();
  const gameId = useRequiredGameId();
  const queryClient = useQueryClient();
  const { displaySettings } = useSettings();
  const {
    laps,
    setLaps,
    lapData,
    lapLoading,
    lapError,
    parseError,
    telemetry,
    displayTelemetry,
    selectedTrack,
    selectedCar,
    selectedLapId,
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
    handleLapChange,
    cursorRef,
  } = useAnalyseSelections(search, gameId, { trackOrdinal, carOrdinal, lapId });
  const resourceMismatch = lapData != null && (lapData.trackOrdinal !== trackOrdinal || lapData.carOrdinal !== carOrdinal);
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
  const [showSetup, setShowSetup] = useState(false);
  const lapLine = useMemo(() => {
    if (telemetry.length < 2) return null;
    const pts: Point[] = [];
    for (const p of telemetry) if (p.PositionX !== 0 || p.PositionZ !== 0) pts.push({ x: p.PositionX, z: p.PositionZ });
    return pts.length > 2 ? pts : null;
  }, [telemetry]);
  const playRef = useRef(false);
  const speedRef = useRef(1);
  const displayTelemetryRef = useRef(displayTelemetry);
  useEffect(() => {
    displayTelemetryRef.current = displayTelemetry;
  }, [displayTelemetry]);
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
    // Per-frame lap timestamps (seconds) so the recorder can offset the start
    // by real seconds, not a guessed fraction.
    w.__frameTimes = telemetry.map((p) => p.CurrentLap);
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

  // Derive cursor sector cheaply from precomputed server data
  const sectorTimes = useMemo(() => {
    if (!sectorData || !sectors) return null;
    const cursorFrac = telemetry.length > 1 ? (telemetry[cursorIdx]?.DistanceTraveled - sectorData.firstDist) / sectorData.lapDist : 0;
    let cursorSector = 0;
    for (let index = 1; index < sectors.sectorStarts.length; index++) {
      if (cursorFrac < sectors.sectorStarts[index]) break;
      cursorSector = index;
    }
    return { ...sectorData, cursorSector };
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

  const currentPacket = telemetry[cursorIdx] ?? null;
  const currentDisplayPacket = displayTelemetry[cursorIdx] ?? null;
  const wearRate = useMemo(() => {
    if (!currentPacket || telemetry.length < 2) return null;
    const windowIdx = Math.max(0, cursorIdx - 60);
    const windowPacket = telemetry[windowIdx];
    const dt = currentPacket.CurrentLap - windowPacket.CurrentLap;
    if (dt <= 0.1) return null;
    return {
      FL: (currentPacket.TireWearFL - windowPacket.TireWearFL) / dt,
      FR: (currentPacket.TireWearFR - windowPacket.TireWearFR) / dt,
      RL: (currentPacket.TireWearRL - windowPacket.TireWearRL) / dt,
      RR: (currentPacket.TireWearRR - windowPacket.TireWearRR) / dt,
    };
  }, [currentPacket, cursorIdx, telemetry]);
  // Insights computed server-side, included in the initial lap fetch
  const lapInsights = useMemo(() => lapData?.insights ?? [], [lapData]);

  // Cursor state already publishes at 30 Hz during playback. Read interpolated
  // time on those renders instead of driving a second 60 Hz parent render loop.
  const currentTime = playing ? interpolatedTimeRef.current : currentPacket ? currentPacket.CurrentLap : 0;
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
    mutationFn: async (lapId: number) => {
      const response = await client.api.laps[":id"].$delete({ param: { id: String(lapId) } });
      if (!response.ok) throw new Error(`Failed to delete lap (${response.status})`);
      return response.json();
    },
    onSuccess: () => {
      void navigate({ search: { ...search, lap: undefined, view: "track", cursor: undefined } } as never);
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

  // Export handler
  const handleExport = useCallback(() => {
    if (telemetry.length === 0) return;
    buildExportCsv(telemetry, carName, trackName, selectedLap, selectedLapId, displaySettings.driverName);
  }, [telemetry, selectedLapId, selectedLap, carName, trackName]);

  const { exportingBin, importingBin, importResult, ibtPreview, handleExportBin, handleImportBin, handleCancelIbt, handleCommitIbt, setImportResult } = useAnalyseImports({ queryClient });

  return (
    <div data-testid="lap-analyse-workspace" className="flex min-h-full min-w-0 flex-col @5xl/workspace:h-full @5xl/workspace:min-h-0 @5xl/workspace:overflow-hidden">
      {/* Header: cascading selectors + export */}
      <AnalyseLapHeader
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
        hasF1Setup={!!telemetry[0]?.f1?.setup}
        availableTunes={availableTunes}
        tunePending={updateLapTune.isPending}
        loading={loading}
        aiPanelOpen={aiPanelOpen}
        onTrackChange={handleTrackChange}
        onCarChange={handleCarChange}
        onLapChange={handleLapChange}
        onTuneChange={(tuneId) => updateLapTune.mutate(tuneId)}
        onViewTune={setViewingTuneId}
        onShowSetup={() => setShowSetup(true)}
        onExport={handleExport}
        onExportBin={() => void handleExportBin(selectedLapId)}
        onImportBin={handleImportBin}
        exportingBin={exportingBin}
        importingBin={importingBin}
        onToggleAi={() => setAiPanelOpen((v) => !v)}
        onDeleteLap={handleDeleteLap}
        onNotesChange={(notes) => updateLapNotesMutation.mutate(notes)}
      />

      {(resourceMismatch || telemetry.length === 0) && <AnalyseWorkspaceStatus loading={loading} lapError={resourceMismatch ? new Error("Lap not found in this track/car analysis") : lapError} parseError={parseError} selectedLapId={selectedLapId} />}

      {telemetry.length > 0 && !resourceMismatch && (
        <AnalyseWorkspacePanels
          topSectionProps={{
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
            currentPacket,
            currentDisplayPacket,
            displayTelemetry,
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
            displayTelemetry,
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
            displayTelemetry,
            totalPackets: telemetry.length,
            visualTimeFrac,
            onVisualFracChange: setVisualTimeFrac,
            onClickIndex: handleChartClick,
            onScrubStart: handleScrubStart,
            speedLabel: units.speedLabel,
            tempLabel: units.tempLabel,
          }}
          chartsPanelRef={chartsPanelRef}
          displayTelemetryLength={displayTelemetry.length}
          dataPanelProps={{
            sidebarTab,
            onSidebarTabChange: setSidebarTab,
            currentPacket,
            currentDisplayPacket,
            startFuel: telemetry[0]?.Fuel,
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
                  carName,
                  trackName,
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
        setup={showSetup ? (telemetry[0]?.f1?.setup ?? null) : null}
        onCloseSetup={() => setShowSetup(false)}
        ibtPreview={ibtPreview}
        importingBin={importingBin}
        onCommitIbt={() => void handleCommitIbt()}
        onCancelIbt={handleCancelIbt}
        importResult={importResult}
        gameId={gameId}
        onGoToLap={(lap) =>
          void navigate({
            search: {
              ...search,
              track: lap.trackOrdinal,
              car: lap.carOrdinal,
              lap: lap.lapId,
              cursor: undefined,
            },
          } as never)
        }
        onCloseImport={() => setImportResult(null)}
      />
    </div>
  );
}
