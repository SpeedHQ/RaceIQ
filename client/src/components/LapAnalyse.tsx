import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import type { TelemetryPacket, LapMeta } from "@shared/types";
import { convertTemp } from "../lib/temperature";
import { useCookieState } from "../hooks/useCookieState";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { formatLapTime } from "../lib/format";
import { getSteeringLock } from "./Settings";
import { Compass } from "./Compass";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUnits } from "../hooks/useUnits";
import { useConvertedTelemetry } from "../hooks/useConvertedTelemetry";
import { useLaps as useLapsQuery, useLapTelemetry, useTrackName, useCarName, useResolveNames, useTrackOutline, useTrackBoundaries, useTrackSectorBoundaries, useTrackSectors } from "../hooks/queries";
import { useActiveProfileId } from "../hooks/useProfiles";
import { client } from "../lib/rpc";
import { useGameId } from "../stores/game";
import { analyzeLap } from "../lib/lap-insights";
import { AiPanel, type AnalysisHighlight, type AiPanelHandle } from "./AiPanel";
import { Sparkles } from "lucide-react";
import { WeatherWidget } from "./analyse/WeatherWidget";
import { F1SetupModal } from "./analyse/F1SetupModal";
import { AiPanelMenu } from "./analyse/AiPanelMenu";
import { AnalyseTrackMap, type TrackMapHandle, type Point } from "./analyse/AnalyseTrackMap";
import { AnalyseChartsPanel, type ChartsPanelHandle } from "./analyse/AnalyseChartsPanel";
import { AnalyseSegmentList } from "./analyse/AnalyseSegmentList";
import { AnalyseTimelineScrubber } from "./analyse/AnalyseTimelineScrubber";
import { TuneViewModal } from "./analyse/TuneViewModal";
import { AnalyseLapHeader } from "./analyse/AnalyseLapHeader";
import { AnalyseSteeringOverlay } from "./analyse/AnalyseSteeringOverlay";
import { AnalyseDataPanel } from "./analyse/AnalyseDataPanel";
import { AnalyseVizPanel } from "./analyse/AnalyseVizPanel";

// Stable empty array to avoid re-renders when no telemetry loaded
const emptyTelemetry: TelemetryPacket[] = [];

// ── Main Component ───────────────────────────────────────────────────

export function LapAnalyse() {
  const search = useSearch({ strict: false }) as { track?: number; car?: number; lap?: number };
  const navigate = useNavigate();
  const units = useUnits();
  const gameId = useGameId();
  const { data: activeProfileId } = useActiveProfileId();
  const queryClient = useQueryClient();

  const [laps, setLaps] = useState<LapMeta[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(search.track ?? null);
  const [selectedCar, setSelectedCar] = useState<number | null>(search.car ?? null);
  const [selectedLapId, setSelectedLapId] = useState<number | null>(search.lap ?? null);

  // Fetch lap telemetry via TanStack Query
  const { data: lapData, isLoading: lapLoading } = useLapTelemetry(selectedLapId);
  const telemetry = lapData?.telemetry ?? emptyTelemetry;
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
  const [showInputs, setShowInputs] = useLocalStorage("analyse-showInputs", false);
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


  // Name caches for track/car ordinals
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});
  const [carNames, setCarNames] = useState<Record<number, string>>({});

  // Fetch lap list
  const { data: allLaps = [] } = useLapsQuery(activeProfileId);
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

  // Imperatively update all overlay canvases without triggering React re-renders
  const updateOverlays = useCallback((idx: number) => {
    trackMapRef.current?.updateCursor(idx);
    chartsPanelRef.current?.updateCursor(idx);
    // Imperatively update timeline thumb/progress at 60fps
    const tf = chartsPanelRef.current?.timeFracs;
    const pct = tf ? `${(tf[idx] ?? 0) * 100}%` : `${(idx / Math.max(1, (telemetry.length - 1))) * 100}%`;
    if (thumbRef.current) thumbRef.current.style.left = pct;
    if (progressRef.current) progressRef.current.style.width = pct;
  }, [telemetry.length]);

  // Play/pause animation — uses CurrentLap timer for accurate real-time playback
  // Updates overlays imperatively at 60fps, throttles React state to ~15fps
  useEffect(() => {
    playRef.current = playing;
    if (!playing || telemetry.length < 2) return;

    let rafId: number;
    // Track wall-clock time elapsed since playback started at current index
    let wallStart = performance.now();
    let gameStart = telemetry[cursorRef.current].CurrentLap;
    let lastSpeedChange = speedChangeRef.current;
    let lastSeek = seekRef.current;

    function step(now: number) {
      if (!playRef.current) return;
      const idx = cursorRef.current;
      if (idx >= telemetry.length - 1) {
        // Loop back to start
        cursorRef.current = 0;
        updateOverlays(0);
        setCursorIdx(0);
        lastStateUpdateRef.current = now;
        wallStart = now;
        gameStart = telemetry[0].CurrentLap;
        lastSeek = seekRef.current;
        rafId = requestAnimationFrame(step);
        return;
      }

      // Re-anchor timing when user seeks or speed changes mid-playback
      if (seekRef.current !== lastSeek) {
        lastSeek = seekRef.current;
        wallStart = now;
        gameStart = telemetry[idx].CurrentLap;
      }
      if (speedChangeRef.current !== lastSpeedChange) {
        lastSpeedChange = speedChangeRef.current;
        wallStart = now;
        gameStart = telemetry[idx].CurrentLap;
      }

      // How much game-time should have elapsed based on wall-clock and speed
      const wallElapsed = (now - wallStart) / 1000; // seconds
      const gameTarget = gameStart + wallElapsed * speedRef.current;
      interpolatedTimeRef.current = gameTarget;

      // Advance cursor to the packet matching the target game time
      let nextIdx = idx;
      while (nextIdx < telemetry.length - 1 && telemetry[nextIdx + 1].CurrentLap <= gameTarget) {
        nextIdx++;
      }

      if (nextIdx !== idx) {
        cursorRef.current = nextIdx;
        // Imperative canvas updates at full 60fps — no React re-render
        updateOverlays(nextIdx);
        // Throttle React state updates to ~30fps — 3D uses useFrame at native fps
        if (now - lastStateUpdateRef.current > 33) {
          lastStateUpdateRef.current = now;
          setCursorIdx(nextIdx);
        }
      }

      rafId = requestAnimationFrame(step);
    }
    rafId = requestAnimationFrame(step);

    return () => cancelAnimationFrame(rafId);
  }, [playing, telemetry, updateOverlays]);

  // Keyboard controls
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (telemetry.length === 0) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCursorIdx((prev) => {
          const next = Math.max(0, prev - 1);
          cursorRef.current = next;
          return next;
        });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setCursorIdx((prev) => {
          const next = Math.min(telemetry.length - 1, prev + 1);
          cursorRef.current = next;
          return next;
        });
      } else if (e.key === " ") {
        // Don't capture space when typing in an input/textarea
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        setPlaying((p) => !p);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [telemetry]);



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
      queryClient.invalidateQueries({ queryKey: ["laps", activeProfileId ?? null] });
    },
  });

  // Export handler
  const handleExport = useCallback(() => {
    if (telemetry.length === 0) return;
    const header = [
      `# Car: ${carName || `Ordinal ${telemetry[0].CarOrdinal}`}`,
      `# Track: ${trackName || `Ordinal ${telemetry[0].TrackOrdinal}`}`,
      `# Lap: ${selectedLap?.lapNumber ?? "?"} | Time: ${selectedLap ? formatLapTime(selectedLap.lapTime) : "?"}`,
    ].join("\n");
    const csv = [
      header,
      Object.keys(telemetry[0]).join(","),
      ...telemetry.map((p) => Object.values(p).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lap-${selectedLapId}-telemetry.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [telemetry, selectedLapId, selectedLap, carName, trackName]);

  const handleCopyMetrics = useCallback(() => {
    if (!currentPacket) return;
    const p = currentPacket;
    const lock = getSteeringLock();
    const steerDeg = (p.Steer / 127) * (lock / 2);
    const startFuel = telemetry[0]?.Fuel ?? 0;
    const lines = [
      `Packet ${cursorIdx + 1}/${telemetry.length} | ${formatLapTime(p.CurrentLap)} / ${formatLapTime(totalTime)}`,
      `Track: ${trackName} | Car: ${carName} | Lap: ${selectedLap?.lapNumber ?? "?"}`,
      ``,
      `Speed: ${(currentDisplayPacket?.DisplaySpeed ?? units.speed(p.Speed)).toFixed(0)} ${units.speedLabel}`,
      `RPM: ${p.CurrentEngineRpm.toFixed(0)} / ${p.EngineMaxRpm.toFixed(0)}`,
      `Gear: ${p.Gear}`,
      `Throttle: ${((p.Accel / 255) * 100).toFixed(0)}%`,
      `Brake: ${((p.Brake / 255) * 100).toFixed(0)}%`,
      `Steer: ${steerDeg > 0 ? "+" : ""}${steerDeg.toFixed(0)}°`,
      ...(gameId === "fm-2023" || p.Boost > 0 ? [`Boost: ${p.Boost.toFixed(1)} psi`] : []),
      ...(gameId === "fm-2023" || p.Power > 0 ? [`Power: ${(p.Power / 745.7).toFixed(0)} hp`] : []),
      ...(gameId === "fm-2023" || p.Torque > 0 ? [`Torque: ${p.Torque.toFixed(0)} Nm`] : []),
      `Fuel: ${(p.Fuel * 100).toFixed(1)}% left, ${((startFuel - p.Fuel) * 100).toFixed(1)}% used`,
      ``,
      `Wheel Speed (rad/s): FL=${p.WheelRotationSpeedFL.toFixed(1)} FR=${p.WheelRotationSpeedFR.toFixed(1)} RL=${p.WheelRotationSpeedRL.toFixed(1)} RR=${p.WheelRotationSpeedRR.toFixed(1)}`,
      `Tire Temp (${units.tempLabel}): FL=${(currentDisplayPacket?.DisplayTireTempFL ?? convertTemp(p.TireTempFL, units.tempUnit, gameId === "fm-2023" ? "F" : "C")).toFixed(0)} FR=${(currentDisplayPacket?.DisplayTireTempFR ?? convertTemp(p.TireTempFR, units.tempUnit, gameId === "fm-2023" ? "F" : "C")).toFixed(0)} RL=${(currentDisplayPacket?.DisplayTireTempRL ?? convertTemp(p.TireTempRL, units.tempUnit, gameId === "fm-2023" ? "F" : "C")).toFixed(0)} RR=${(currentDisplayPacket?.DisplayTireTempRR ?? convertTemp(p.TireTempRR, units.tempUnit, gameId === "fm-2023" ? "F" : "C")).toFixed(0)}`,
      `Tire Wear: FL=${(p.TireWearFL*100).toFixed(1)}% FR=${(p.TireWearFR*100).toFixed(1)}% RL=${(p.TireWearRL*100).toFixed(1)}% RR=${(p.TireWearRR*100).toFixed(1)}%`,
      `Slip Combined: FL=${p.TireCombinedSlipFL.toFixed(2)} FR=${p.TireCombinedSlipFR.toFixed(2)} RL=${p.TireCombinedSlipRL.toFixed(2)} RR=${p.TireCombinedSlipRR.toFixed(2)}`,
      `Slip Angle: FL=${(p.TireSlipAngleFL*180/Math.PI).toFixed(1)}° FR=${(p.TireSlipAngleFR*180/Math.PI).toFixed(1)}° RL=${(p.TireSlipAngleRL*180/Math.PI).toFixed(1)}° RR=${(p.TireSlipAngleRR*180/Math.PI).toFixed(1)}°`,
      `Suspension: FL=${(p.NormSuspensionTravelFL*100).toFixed(0)}% FR=${(p.NormSuspensionTravelFR*100).toFixed(0)}% RL=${(p.NormSuspensionTravelRL*100).toFixed(0)}% RR=${(p.NormSuspensionTravelRR*100).toFixed(0)}%`,
    ];
    navigator.clipboard.writeText(lines.join("\n"));
  }, [currentPacket, cursorIdx, telemetry, totalTime, trackName, carName, selectedLap]);

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
        onCopyMetrics={handleCopyMetrics}
        onExport={handleExport}
        onToggleAi={() => setAiPanelOpen((v) => !v)}
      />

      {telemetry.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">
          {loading ? "Loading lap telemetry..." : selectedLapId ? "No telemetry data for this lap." : "Select a track, car, and lap to analyse."}
        </div>
      )}

      {telemetry.length > 0 && (
        <div className="flex flex-1 overflow-hidden">
          {/* Left: main content (map, charts, scrubber) */}
          <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
          {/* Top section: Track Map + Metrics */}
          <div className="flex shrink-0 overflow-hidden" style={{ height: topHeight }}>
            {/* Segment table + legend */}
            <div className="border-r border-app-border overflow-y-auto p-2 shrink-0" style={{ height: "100%", width: leftColWidth }}>
              {/* Legend */}
              <div className="flex flex-wrap items-center gap-3 mb-2 pb-2 border-b border-app-border">
                <div className="flex items-center gap-1">
                  <div className="w-3 h-1.5 rounded-sm bg-amber-500" />
                  <span className="text-[9px] text-app-text-muted">Corner</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-1.5 rounded-sm bg-blue-500" />
                  <span className="text-[9px] text-app-text-muted">Straight</span>
                </div>
              </div>
              {/* Segment list */}
              <AnalyseSegmentList telemetry={telemetry} segments={segments} cursorIdx={cursorIdx} />
            </div>

            {/* Left resize handle */}
            <div
              className="w-1.5 shrink-0 cursor-col-resize bg-app-border hover:bg-app-accent/40 transition-colors"
              onMouseDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = leftColWidth;
                const onMove = (ev: MouseEvent) => {
                  setLeftColWidth(Math.max(60, Math.min(800, startW + ev.clientX - startX)));
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
            />

            {/* Track map */}
            <div
              className="border-r border-app-border bg-app-bg p-2 relative flex-1 min-w-0"
              style={{ height: "100%" }}
              onWheel={(e) => {
                if (!rotateWithCar) return;
                e.preventDefault();
                setMapZoom((z) => Math.max(0.5, Math.min(4, z - e.deltaY * 0.001)));
              }}
            >
              <AnalyseTrackMap
                ref={trackMapRef}
                telemetry={telemetry}
                cursorIdx={cursorIdx}
                outline={outline}
                boundaries={boundaries}
                sectors={sectors}
                segments={segments}
                highlights={aiPanelOpen ? aiHighlights : null}
                showInputs={showInputs}
                rotateWithCar={rotateWithCar}
                zoom={mapZoom}
                containerHeight={topHeight}
              />
              {/* Weather widget — top left (updates at cursor position) */}
              {telemetry[cursorIdx]?.f1 && <WeatherWidget f1={telemetry[cursorIdx].f1!} />}

              {/* View toggles — top left (matches 3D panel style) */}
              <div className="absolute top-2 left-2 flex flex-wrap gap-1">
                <button
                  onClick={() => setRotateWithCar((r) => !r)}
                  className={`px-2 py-1 text-[9px] uppercase tracking-wider font-semibold rounded border transition-colors ${
                    rotateWithCar
                      ? "bg-cyan-900/50 border-cyan-700 text-app-accent"
                      : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
                  }`}
                >
                  {rotateWithCar ? "Follow" : "Fixed"}
                </button>
                <button
                  onClick={() => setShowInputs((v) => !v)}
                  className={`px-2 py-1 text-[9px] uppercase tracking-wider font-semibold rounded border transition-colors ${
                    showInputs
                      ? "bg-cyan-900/50 border-cyan-700 text-app-accent"
                      : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
                  }`}
                >
                  Inputs
                </button>
              </div>

              {/* Right side controls */}
              <div className="absolute top-2 right-2 flex items-start gap-2">
                {rotateWithCar && (
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => setMapZoom((z) => Math.min(z + 0.25, 4))}
                      className="w-6 h-6 text-xs bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
                    >+</button>
                    <button
                      onClick={() => setMapZoom((z) => Math.max(z - 0.25, 0.5))}
                      className="w-6 h-6 text-xs bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
                    >-</button>
                  </div>
                )}
                {currentPacket && <Compass yaw={currentPacket.Yaw} />}
              </div>

              {/* Steering wheel + pedal bars — bottom right */}
              {currentPacket && <AnalyseSteeringOverlay packet={currentPacket} />}
            </div>

            {/* Right resize handle */}
            <div
              className="w-1.5 shrink-0 cursor-col-resize bg-app-border hover:bg-app-accent/40 transition-colors"
              onMouseDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = rightColWidth;
                const onMove = (ev: MouseEvent) => {
                  setRightColWidth(Math.max(200, startW - (ev.clientX - startX)));
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
            />

            {/* Rev meter + Steering wheel + Tire diagram */}
            <AnalyseVizPanel
              vizMode={vizMode}
              onVizModeChange={setWheelTab}
              width={rightColWidth}
              currentPacket={currentPacket}
              currentDisplayPacket={currentDisplayPacket}
              displayTelemetry={displayTelemetry}
              cursorRef={cursorRef}
              displayTelemetryRef={displayTelemetryRef}
              cursorIdx={cursorIdx}
              lapLine={lapLine}
              boundaries={boundaries}
              units={units}
            />

          </div>

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
            gameId={gameId ?? undefined}
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
            <div className="w-[22rem] h-full shrink-0 border-l border-app-border bg-app-surface/50 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-app-border shrink-0">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="size-3 text-amber-400" />
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-app-text">AI Analysis</span>
                </div>
                <div className="flex items-center gap-2">
                  <AiPanelMenu
                    onClearChat={() => aiPanelRef.current?.clearChat()}
                    onClearAnalysis={() => aiPanelRef.current?.clearAnalysis()}
                    onClearAll={() => aiPanelRef.current?.clearAll()}
                  />
                  <button onClick={() => setAiPanelOpen(false)} className="text-app-text-muted hover:text-app-text text-xs">✕</button>
                </div>
              </div>
              <AiPanel
                ref={aiPanelRef}
                lapId={selectedLapId}
                carName={carName}
                trackName={trackName}
                segments={segments}
                panelOpen={aiPanelOpen}
                onJumpToFrac={(frac) => {
                  // Convert fractional track distance to telemetry frame index
                  const idx = Math.round(frac * (telemetry.length - 1));
                  setCursorIdx(idx);
                  cursorRef.current = idx;
                  seekRef.current++;
                }}
                onHighlightsChange={setAiHighlights}
              />
            </div>
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
