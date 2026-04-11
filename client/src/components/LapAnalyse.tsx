import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import type { TelemetryPacket, LapMeta } from "@shared/types";
import { useCookieState } from "../hooks/useCookieState";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUnits } from "../hooks/useUnits";
import { useConvertedTelemetry } from "../hooks/useConvertedTelemetry";
import { useLaps as useLapsQuery, useLapTelemetry, useTrackName, useCarName, useResolveNames, useTrackOutline, useTrackBoundaries, useTrackSectorBoundaries, useTrackSectors, useSettings } from "../hooks/queries";
import { client } from "../lib/rpc";
import { useRequiredGameId } from "../stores/game";
import { analyzeLap } from "../lib/lap-insights";
import { useLapPlayback } from "../hooks/useLapPlayback";
import { type AnalysisHighlight, type AiPanelHandle } from "./AiPanel";
import { F1SetupModal } from "./analyse/F1SetupModal";
import { type TrackMapHandle, type Point } from "./analyse/AnalyseTrackMap";
import { AnalyseChartsPanel, type ChartsPanelHandle } from "./analyse/AnalyseChartsPanel";
import { AnalyseTimelineScrubber } from "./analyse/AnalyseTimelineScrubber";
import { TuneViewModal } from "./analyse/TuneViewModal";
import { AnalyseLapHeader } from "./analyse/AnalyseLapHeader";
import { AnalyseDataPanel } from "./analyse/AnalyseDataPanel";
import { AnalyseTopSection } from "./analyse/AnalyseTopSection";
import { AnalyseAiSidebar } from "./analyse/AnalyseAiSidebar";
import { buildExportCsv, parseLapCsv } from "../lib/lap-export";

// Stable empty array to avoid re-renders when no telemetry loaded
const emptyTelemetry: TelemetryPacket[] = [];

// ── Main Component ───────────────────────────────────────────────────

export function LapAnalyse() {
  const search = useSearch({ strict: false }) as { track?: number; car?: number; lap?: number };
  const navigate = useNavigate();
  const units = useUnits();
  const gameId = useRequiredGameId();
  const queryClient = useQueryClient();
  const { displaySettings } = useSettings();

  const [laps, setLaps] = useState<LapMeta[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(search.track ?? null);
  const [selectedCar, setSelectedCar] = useState<number | null>(search.car ?? null);
  const [selectedLapId, setSelectedLapId] = useState<number | null>(search.lap ?? null);

  // Fetch lap telemetry via TanStack Query
  const { data: lapData, isLoading: lapLoading } = useLapTelemetry(selectedLapId);
  const [importedTelemetry, setImportedTelemetry] = useState<TelemetryPacket[] | null>(null);
  const telemetry = importedTelemetry ?? lapData?.telemetry ?? emptyTelemetry;
  const displayTelemetry = useConvertedTelemetry(telemetry);

  // Fetch track data via TanStack Query (keyed on trackOrdinal derived from selection or lap data)
  const trackOrd = selectedTrack ?? lapData?.meta?.trackOrdinal ?? null;
  const { data: outlineRaw } = useTrackOutline(trackOrd ?? undefined);
  const outline = useMemo(() => {
    if (!outlineRaw) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = outlineRaw as any;
    if (d?.points && Array.isArray(d.points)) return d.points as Point[];
    if (Array.isArray(d)) return d as Point[];
    return null;
  }, [outlineRaw]);
  const { data: boundariesRaw } = useTrackBoundaries(trackOrd ?? undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const boundaries = (boundariesRaw as any) ?? null;
  const { data: sectorsRaw } = useTrackSectorBoundaries(trackOrd ?? undefined);
  const sectors = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = sectorsRaw as any;
    return s?.s1End ? s as { s1End: number; s2End: number } : null;
  }, [sectorsRaw]);
  const { data: segmentsRaw } = useTrackSectors(trackOrd ?? undefined);
  const segments = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = segmentsRaw as any;
    return s?.segments ? (s.segments as { type: string; name: string; startFrac: number; endFrac: number }[]) : null;
  }, [segmentsRaw]);

  const [carName, setCarName] = useState("");
  const [trackName, setTrackName] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initialCursor = (search as any).cursor as number | undefined;
  const [cursorIdx, setCursorIdx] = useState(0);
  // Visual time fraction override — set during scrubbing through gaps
  // null = use cursorIdx's time fraction, number = override position
  const [visualTimeFrac, setVisualTimeFrac] = useState<number | null>(null);
  const [sidebarTab, setSidebarTab] = useState<"live" | "insights">("live");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vizParam = (search as any).viz as string | undefined;
  const [vizMode, setWheelTab] = useCookieState<"2d" | "3d">("analyse-vizMode", "2d");
  // URL ?viz= param overrides cookie on mount
  const appliedVizParam = useRef(false);
  useEffect(() => {
    if (appliedVizParam.current) return;
    if (vizParam === "3d" || vizParam === "2d") {
      setWheelTab(vizParam);
      appliedVizParam.current = true;
    }
  }, [vizParam]);
  const [leftColWidth, setLeftColWidth] = useCookieState("analyse-leftCol", 150);
  const [rightColWidth, setRightColWidth] = useCookieState("analyse-rightCol", 650);
  const [playing, setPlaying] = useState(false);
  const [rotateWithCar, setRotateWithCar] = useLocalStorage("analyse-rotateWithCar", false);
  const [trackOverlay, setTrackOverlay] = useLocalStorage<"none" | "inputs" | "segments" | "sectors">("analyse-trackOverlay", "none");
  const [mapZoom, setMapZoom] = useLocalStorage("analyse-mapZoom", 1);
  const [topHeight, setTopHeight] = useCookieState("analyse-topHeight", 500);
  const loading = lapLoading;
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [aiPanelOpen, setAiPanelOpen] = useCookieState("analyse-aiPanel", false);
  const [aiHighlights, setAiHighlights] = useState<AnalysisHighlight[] | null>(null);
  const aiPanelRef = useRef<AiPanelHandle>(null);
  const [viewingTuneId, setViewingTuneId] = useState<number | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  // Actual driving line from telemetry positions (for 3D visual)
  const lapLine = useMemo(() => {
    if (telemetry.length < 2) return null;
    const pts: Point[] = [];
    for (const p of telemetry) {
      if (p.PositionX !== 0 || p.PositionZ !== 0) {
        pts.push({ x: p.PositionX, z: p.PositionZ });
      }
    }
    return pts.length > 2 ? pts : null;
  }, [telemetry]);

  const playRef = useRef(false);
  const speedRef = useRef(1);
  const cursorRef = useRef(0);
  const displayTelemetryRef = useRef(displayTelemetry);
  useEffect(() => { displayTelemetryRef.current = displayTelemetry; }, [displayTelemetry]);
  const seekRef = useRef(0);

  // Imperative refs for smooth animation without React re-renders
  const trackMapRef = useRef<TrackMapHandle>(null);
  const lastStateUpdateRef = useRef(0);
  const interpolatedTimeRef = useRef(0);
  const thumbRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const chartsPanelRef = useRef<ChartsPanelHandle>(null);
  const triggerImportRef = useRef<(() => void) | undefined>(undefined);


  // Name caches for track/car ordinals
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});
  const [carNames, setCarNames] = useState<Record<number, string>>({});

  // Fetch lap list
  const { data: allLaps = [] } = useLapsQuery();
  const fetchedLaps = useMemo(() => allLaps.filter((l) => l.lapTime > 0), [allLaps]);
  // Merge fetched laps with local optimistic updates
  useEffect(() => { setLaps(fetchedLaps); }, [fetchedLaps]);

  // Derive unique tracks from laps
  const tracks = useMemo(() => {
    const seen = new Map<number, number>(); // trackOrdinal -> lap count
    for (const l of laps) {
      if (l.trackOrdinal != null) seen.set(l.trackOrdinal, (seen.get(l.trackOrdinal) ?? 0) + 1);
    }
    return Array.from(seen.entries())
      .sort((a, b) => (trackNames[a[0]] ?? `Track ${a[0]}`).localeCompare(trackNames[b[0]] ?? `Track ${b[0]}`));
  }, [laps, trackNames]);

  // Derive unique cars for the selected track
  const carsForTrack = useMemo(() => {
    if (selectedTrack == null) return [];
    const seen = new Map<number, number>();
    for (const l of laps) {
      if (l.trackOrdinal === selectedTrack && l.carOrdinal != null) {
        seen.set(l.carOrdinal, (seen.get(l.carOrdinal) ?? 0) + 1);
      }
    }
    return Array.from(seen.entries())
      .sort((a, b) => (carNames[a[0]] ?? `Car ${a[0]}`).localeCompare(carNames[b[0]] ?? `Car ${b[0]}`));
  }, [laps, selectedTrack, carNames]);

  // Derive laps for the selected track + car
  const filteredLaps = useMemo(() => {
    if (selectedTrack == null || selectedCar == null) return [];
    return laps.filter((l) => l.trackOrdinal === selectedTrack && l.carOrdinal === selectedCar);
  }, [laps, selectedTrack, selectedCar]);

  // Resolve names for URL-param track/car immediately via query hooks
  const { data: initialTrackName } = useTrackName(selectedTrack ?? undefined);
  const { data: initialCarName } = useCarName(selectedCar ?? undefined);
  useEffect(() => {
    if (initialTrackName && selectedTrack != null) setTrackNames((prev) => prev[selectedTrack] === initialTrackName ? prev : { ...prev, [selectedTrack]: initialTrackName });
  }, [initialTrackName, selectedTrack]);
  useEffect(() => {
    if (initialCarName && selectedCar != null) setCarNames((prev) => prev[selectedCar] === initialCarName ? prev : { ...prev, [selectedCar]: initialCarName });
  }, [initialCarName, selectedCar]);

  // Batch-resolve track/car names for display via query hook
  const missingTrackOrds = useMemo(() => [...new Set(laps.filter(l => l.trackOrdinal != null && !trackNames[l.trackOrdinal!]).map(l => l.trackOrdinal!))], [laps, trackNames]);
  const missingCarOrds = useMemo(() => [...new Set(laps.filter(l => l.carOrdinal != null && !carNames[l.carOrdinal!]).map(l => l.carOrdinal!))], [laps, carNames]);
  const { data: resolvedNames } = useResolveNames(missingTrackOrds, missingCarOrds);
  useEffect(() => {
    if (!resolvedNames) return;
    if (resolvedNames.trackNames && Object.keys(resolvedNames.trackNames).length > 0) {
      setTrackNames((prev) => ({ ...prev, ...Object.fromEntries(Object.entries(resolvedNames.trackNames).map(([k, v]) => [Number(k), v])) }));
    }
    if (resolvedNames.carNames && Object.keys(resolvedNames.carNames).length > 0) {
      setCarNames((prev) => ({ ...prev, ...Object.fromEntries(Object.entries(resolvedNames.carNames).map(([k, v]) => [Number(k), v])) }));
    }
  }, [resolvedNames]);

  // Sync selections to URL (preserve cursor/viz params)
  useEffect(() => {
    navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        track: selectedTrack ?? undefined,
        car: selectedCar ?? undefined,
        lap: selectedLapId ?? undefined,
      }) as never,
      replace: true,
    });
  }, [selectedTrack, selectedCar, selectedLapId, navigate]);

  // Reset downstream selections when track changes
  const handleTrackChange = useCallback((trackOrd: number | null) => {
    setSelectedTrack(trackOrd);
    setSelectedCar(null);
    setSelectedLapId(null);
  }, []);

  // Reset lap selection when car changes
  const handleCarChange = useCallback((carOrd: number | null) => {
    setSelectedCar(carOrd);
    setSelectedLapId(null);
  }, []);

  // Reset playback state when lap changes (skip first mount for URL cursor)
  const lapChangeCount = useRef(0);
  useEffect(() => {
    if (selectedLapId == null) return;
    lapChangeCount.current++;
    const isInitialMount = lapChangeCount.current === 1;
    setPlaying(false);
    playRef.current = false;
    if (!isInitialMount || !initialCursor) {
      setCursorIdx(0);
      cursorRef.current = 0;
    }
    setImportedTelemetry(null);
    setCarName(selectedCar != null ? (carNames[selectedCar] ?? "") : "");
    setTrackName(selectedTrack != null ? (trackNames[selectedTrack] ?? "") : "");
  }, [selectedLapId]);

  // Set cursor from URL param once telemetry loads
  const appliedInitialCursor = useRef(false);
  useEffect(() => {
    if (appliedInitialCursor.current) return;
    if (initialCursor != null && telemetry.length > 1) {
      const idx = Math.min(initialCursor, telemetry.length - 1);
      setCursorIdx(idx);
      cursorRef.current = idx;
      appliedInitialCursor.current = true;
    }
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



  // Sector data from server response
  const sectorData = lapData?.sectorTimes ?? null;

  // Derive cursor sector cheaply from precomputed server data
  const sectorTimes = useMemo(() => {
    if (!sectorData || !sectors) return null;
    const cursorFrac = telemetry.length > 1
      ? (telemetry[cursorIdx]?.DistanceTraveled - sectorData.firstDist) / sectorData.lapDist
      : 0;
    const cursorSector = cursorFrac < sectors.s1End ? 0 : cursorFrac < sectors.s2End ? 1 : 2;
    return { ...sectorData, cursorSector };
  }, [sectorData, sectors, telemetry, cursorIdx]);


  const handleChartClick = useCallback((idx: number) => {
    setCursorIdx(idx);
    cursorRef.current = idx;
    seekRef.current++;
    updateOverlays(idx);
  }, [updateOverlays]);

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
  const lapInsights = useMemo(() => analyzeLap(telemetry), [telemetry]);

  // Time display — use interpolated time during playback so timer doesn't freeze in gaps
  // Separate display time state that ticks during playback (even through gaps)
  const [displayTime, setDisplayTime] = useState(0);
  useEffect(() => {
    if (!playing) return;
    let raf: number;
    const tick = () => {
      setDisplayTime(interpolatedTimeRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  const currentTime = playing ? displayTime : (currentPacket ? currentPacket.CurrentLap : 0);
  const selectedLap = laps.find((l) => l.id === selectedLapId);
  const totalTime = selectedLap?.lapTime ?? 0;

  // Tune selector
  const { data: availableTunes } = useQuery({
    queryKey: ["tunes", selectedLap?.carOrdinal],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: () => client.api.tunes.$get({ query: { carOrdinal: selectedLap?.carOrdinal != null ? String(selectedLap.carOrdinal) : undefined } }).then((r) => r.json() as any),
    enabled: !!selectedLap?.carOrdinal,
  });

  const updateLapTune = useMutation({
    mutationFn: (tuneId: number | null) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.api.laps[":id"].tune.$patch({ param: { id: String(selectedLapId) }, json: { tuneId } }).then((r) => r.json() as any),
    onMutate: (tuneId) => {
      // Optimistically update local laps state so dropdown doesn't reset
      setLaps((prev) =>
        prev.map((l) =>
          l.id === selectedLapId
            ? { ...l, tuneId: tuneId ?? undefined, tuneName: availableTunes?.find((t: { id: number; name: string }) => t.id === tuneId)?.name }
            : l
        )
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["laps"] });
    },
  });

  const updateLapNotesMutation = useMutation({
    mutationFn: (notes: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.api.laps[":id"].notes.$patch({ param: { id: String(selectedLapId) }, json: { notes: notes || null } }).then((r) => r.json() as any),
    onMutate: (notes) => {
      setLaps((prev) =>
        prev.map((l) => l.id === selectedLapId ? { ...l, notes: notes || undefined } : l)
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["laps"] });
    },
  });

  const deleteLapMutation = useMutation({
    mutationFn: (lapId: number) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.api.laps[":id"].$delete({ param: { id: String(lapId) } }).then((r) => r.json() as any),
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

  // Export handler
  const handleExport = useCallback(() => {
    if (telemetry.length === 0) return;
    buildExportCsv(telemetry, carName, trackName, selectedLap, selectedLapId, displaySettings.driverName);
  }, [telemetry, selectedLapId, selectedLap, carName, trackName]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
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
        onLapChange={setSelectedLapId}
        onTuneChange={(tuneId) => updateLapTune.mutate(tuneId)}
        onViewTune={setViewingTuneId}
        onShowSetup={() => setShowSetup(true)}
        onExport={handleExport}
        onToggleAi={() => setAiPanelOpen((v) => !v)}
        onDeleteLap={handleDeleteLap}
        onNotesChange={(notes) => updateLapNotesMutation.mutate(notes)}
        {...(import.meta.env.DEV && {
          onImport: (csv: string) => {
            const { telemetry: packets, meta } = parseLapCsv(csv);
            if (packets.length === 0) return;
            setImportedTelemetry(packets);
            if (meta.carName) setCarName(meta.carName);
            if (meta.trackName) setTrackName(meta.trackName);
            if (meta.carOrdinal != null) setSelectedCar(meta.carOrdinal);
            if (meta.trackOrdinal != null) setSelectedTrack(meta.trackOrdinal);
          },
          triggerImportRef,
        })}
      />

      {telemetry.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-app-text-muted text-sm">
          <span>{loading ? "Loading lap telemetry..." : selectedLapId ? "No telemetry data for this lap." : "Select a track, car, and lap to analyse."}</span>
          {import.meta.env.DEV && !loading && (
            <button
              className="text-xs text-app-text-muted/40 underline underline-offset-2 hover:text-app-text-muted/70"
              onClick={() => triggerImportRef.current?.()}
            >
              [dev] import exported CSV
            </button>
          )}
        </div>
      )}

      {telemetry.length > 0 && (
        <div className="flex flex-1 overflow-hidden">
          {/* Left: main content (map, charts, scrubber) */}
          <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
          {/* Top section: Track Map + Metrics */}
          <AnalyseTopSection
            topHeight={topHeight}
            leftColWidth={leftColWidth}
            rightColWidth={rightColWidth}
            onLeftResize={setLeftColWidth}
            onRightResize={setRightColWidth}
            telemetry={telemetry}
            cursorIdx={cursorIdx}
            outline={outline}
            boundaries={boundaries}
            sectors={sectors}
            segments={segments}
            currentPacket={currentPacket}
            currentDisplayPacket={currentDisplayPacket}
            displayTelemetry={displayTelemetry}
            lapLine={lapLine}
            units={units}
            aiPanelOpen={aiPanelOpen}
            aiHighlights={aiHighlights}
            rotateWithCar={rotateWithCar}
            trackOverlay={trackOverlay}
            mapZoom={mapZoom}
            onRotateWithCarToggle={() => setRotateWithCar((r) => !r)}
            onTrackOverlayCycle={() => setTrackOverlay((v) => v === "none" ? "inputs" : v === "inputs" ? "segments" : v === "segments" ? "sectors" : "none")}
            onMapZoomChange={setMapZoom}
            vizMode={vizMode}
            onVizModeChange={setWheelTab}
            trackMapRef={trackMapRef}
            cursorRef={cursorRef}
            displayTelemetryRef={displayTelemetryRef}
          />

          {/* Resize handle */}
          <div
            className="h-3 cursor-row-resize border-y border-app-border bg-app-surface-alt/80 hover:bg-app-accent/30 transition-colors shrink-0 flex items-center justify-center"
            onMouseDown={(e) => {
              e.preventDefault();
              const startY = e.clientY;
              const startH = topHeight;
              const onMove = (ev: MouseEvent) => {
                const newH = Math.max(250, Math.min(800, startH + ev.clientY - startY));
                setTopHeight(newH);
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          >
            <div className="w-10 h-1 rounded-full bg-app-text-muted/60" />
          </div>

          {/* Lap time + Timeline scrubber */}
          <AnalyseTimelineScrubber
            displayTelemetry={displayTelemetry}
            cursorIdx={cursorIdx}
            totalPackets={telemetry.length}
            currentTime={currentTime}
            totalTime={totalTime}
            lapNumber={selectedLap?.lapNumber ?? "?"}
            sectorTimes={sectorTimes}
            playing={playing}
            playbackSpeed={playbackSpeed}
            visualTimeFrac={visualTimeFrac}
            progressRef={progressRef}
            thumbRef={thumbRef}
            onTogglePlay={() => setPlaying((p) => !p)}
            onSpeedChange={setPlaybackSpeed}
            onSeek={handleChartClick}
            onVisualFracChange={setVisualTimeFrac}
          />

          {/* Stacked charts — with own scroll */}
          {displayTelemetry.length > 0 && (
            <AnalyseChartsPanel
              ref={chartsPanelRef}
              displayTelemetry={displayTelemetry}
              cursorIdx={cursorIdx}
              totalPackets={telemetry.length}
              visualTimeFrac={visualTimeFrac}
              onVisualFracChange={setVisualTimeFrac}
              onClickIndex={handleChartClick}
              onScrubStart={handleScrubStart}
              speedLabel={units.speedLabel}
              tempLabel={units.tempLabel}
            />
          )}
          </div>

          {/* Right panel – full height */}
          <AnalyseDataPanel
            sidebarTab={sidebarTab}
            onSidebarTabChange={setSidebarTab}
            currentPacket={currentPacket}
            currentDisplayPacket={currentDisplayPacket}
            startFuel={telemetry[0]?.Fuel}
            gameId={gameId}
            units={units}
            wearRate={wearRate}
            lapInsights={lapInsights}
            onJumpToFrame={(idx) => {
              setCursorIdx(idx);
              cursorRef.current = idx;
              seekRef.current++;
            }}
          />

          {/* AI panel — analysis + chat */}
          {aiPanelOpen && selectedLapId && (
            <AnalyseAiSidebar
              lapId={selectedLapId}
              carName={carName}
              trackName={trackName}
              segments={segments}
              aiPanelRef={aiPanelRef}
              telemetryLength={telemetry.length}
              onClose={() => setAiPanelOpen(false)}
              onJumpToFrac={(frac) => {
                const idx = Math.round(frac * (telemetry.length - 1));
                setCursorIdx(idx);
                cursorRef.current = idx;
                seekRef.current++;
              }}
              onHighlightsChange={setAiHighlights}
            />
          )}
        </div>
      )}
      {/* Tune viewer modal */}
      {viewingTuneId && (
        <TuneViewModal tuneId={viewingTuneId} onClose={() => setViewingTuneId(null)} />
      )}

      {/* F1 Car Setup modal */}
      {showSetup && telemetry[0]?.f1?.setup && (
        <F1SetupModal setup={telemetry[0].f1.setup} onClose={() => setShowSetup(false)} />
      )}
    </div>
  );
}
