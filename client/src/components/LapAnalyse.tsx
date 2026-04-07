import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import type { TelemetryPacket, LapMeta } from "@shared/types";
import { convertTemp } from "../lib/temperature";
import { useCookieState } from "../hooks/useCookieState";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { formatLapTime, TireDiagram, GForceCircle } from "./LiveTelemetry";
import { getSteeringLock } from "./Settings";
import { Compass } from "./Compass";
import { BodyAttitude } from "./BodyAttitude";
import {
  allWheelStates,
  allFrictionCircle,
  steerBalance,
  slipRatioColor,
  frictionUtilColor,
  balanceColor,
} from "../lib/vehicle-dynamics";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUnits } from "../hooks/useUnits";
import { useConvertedTelemetry } from "../hooks/useConvertedTelemetry";
import { useLaps as useLapsQuery, useLapTelemetry, useTrackName, useCarName, useResolveNames, useTrackOutline, useTrackBoundaries, useTrackSectorBoundaries, useTrackSectors } from "../hooks/queries";
import { useActiveProfileId } from "../hooks/useProfiles";
import { client } from "../lib/rpc";
import { useGameId } from "../stores/game";
import { analyzeLap } from "../lib/lap-insights";
import { InsightPanel } from "./InsightPanel";
import { AiPanel, type AnalysisHighlight, type AiPanelHandle } from "./AiPanel";
import { Sparkles, Settings2, Info } from "lucide-react";
import { SearchSelect } from "./ui/SearchSelect";
import { WeatherWidget } from "./analyse/WeatherWidget";
import { F1SetupModal } from "./analyse/F1SetupModal";
import { CarWireframe } from "./CarWireframe";
import { AnalyseTrackMap, type TrackMapHandle, type Point } from "./analyse/AnalyseTrackMap";
import { AnalyseChartsPanel, type ChartsPanelHandle } from "./analyse/AnalyseChartsPanel";
import { AnalyseSegmentList } from "./analyse/AnalyseSegmentList";
import { AnalyseTimelineScrubber } from "./analyse/AnalyseTimelineScrubber";
import { MetricsPanel, WearValue, SlipAngleValue, WheelSpeedValue, SuspValue, brakeBarColor } from "./analyse/AnalyseMetricsPanel";
import { TuneViewModal } from "./analyse/TuneViewModal";

// Stable empty array to avoid re-renders when no telemetry loaded
const emptyTelemetry: TelemetryPacket[] = [];

function AiPanelMenu({ onClearChat, onClearAnalysis, onClearAll }: { onClearChat: () => void; onClearAnalysis: () => void; onClearAll: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} className="text-app-text-muted hover:text-app-text transition-colors" title="Manage">
        <Settings2 className="size-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-app-surface border border-app-border-input rounded-lg shadow-xl py-1 min-w-[160px]">
          <button onClick={() => { onClearChat(); setOpen(false); }} className="w-full text-left px-3 py-1.5 text-[11px] text-app-text-secondary hover:text-app-text hover:bg-app-surface-alt transition-colors">
            Clear chat only
          </button>
          <button onClick={() => { onClearAnalysis(); setOpen(false); }} className="w-full text-left px-3 py-1.5 text-[11px] text-app-text-secondary hover:text-app-text hover:bg-app-surface-alt transition-colors">
            Clear analysis (keep chat)
          </button>
          <div className="border-t border-app-border-input my-1" />
          <button onClick={() => { onClearAll(); setOpen(false); }} className="w-full text-left px-3 py-1.5 text-[11px] text-red-400 hover:text-red-300 hover:bg-app-surface-alt transition-colors">
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

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
      <div className="flex items-center gap-2 p-3 border-b border-app-border flex-wrap shrink-0">
        {/* Track selector */}
        <SearchSelect
          value={selectedTrack != null ? String(selectedTrack) : ""}
          onChange={(v) => handleTrackChange(v ? Number(v) : null)}
          options={tracks.map(([ord, count]) => ({ value: String(ord), label: `${trackNames[ord] || `Track ${ord}`} (${count})` }))}
          placeholder="Search tracks..."
          className="min-w-[200px]"
          fallbackLabel={selectedTrack != null ? (trackNames[selectedTrack] || `Track ${selectedTrack}`) : undefined}
        />

        {/* Car selector */}
        <SearchSelect
          value={selectedCar != null ? String(selectedCar) : ""}
          onChange={(v) => handleCarChange(v ? Number(v) : null)}
          options={carsForTrack.map(([ord, count]) => ({ value: String(ord), label: `${carNames[ord] || `Car ${ord}`} (${count})` }))}
          placeholder="Search cars..."
          disabled={selectedTrack == null}
          className="min-w-[200px]"
          fallbackLabel={selectedCar != null ? (carNames[selectedCar] || `Car ${selectedCar}`) : undefined}
        />

        {/* Lap selector */}
        <SearchSelect
          value={selectedLapId != null ? String(selectedLapId) : ""}
          onChange={(v) => setSelectedLapId(v ? Number(v) : null)}
          options={filteredLaps.map((lap) => {
            const sessionLaps = filteredLaps.filter((l) => l.sessionId === lap.sessionId);
            const sessionDate = new Date(sessionLaps[sessionLaps.length - 1].createdAt);
            const sessionLabel = `Session · ${sessionDate.toLocaleDateString()} ${sessionDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${sessionLaps.length} lap${sessionLaps.length !== 1 ? "s" : ""}`;
            return {
              value: String(lap.id),
              label: `Lap ${lap.lapNumber} – ${formatLapTime(lap.lapTime)}`,
              group: sessionLabel,
            };
          })}
          placeholder="Search laps..."
          disabled={selectedCar == null}
          fallbackLabel={selectedLapId != null ? `Lap ${selectedLapId}` : undefined}
        />

        {/* Tune selector */}
        {selectedLapId && telemetry.length > 0 && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-app-text-muted">Tune:</span>
            <select
              value={selectedLap?.tuneId ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                updateLapTune.mutate(val ? parseInt(val, 10) : null);
              }}
              disabled={updateLapTune.isPending}
              className="bg-app-surface border border-app-border-input rounded px-2 py-1 text-sm text-app-text"
            >
              <option value="">No tune</option>
              {availableTunes?.map((t: { id: number; name: string }) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {selectedLap?.tuneId && (
              <button
                onClick={() => setViewingTuneId(selectedLap.tuneId!)}
                className="px-2 py-1 text-xs bg-app-surface-alt border border-app-border-input rounded text-app-text-muted hover:text-app-text transition-colors"
              >
                View
              </button>
            )}
            {updateLapTune.isPending && (
              <span className="text-xs text-app-text-muted animate-pulse">Saving...</span>
            )}
            {telemetry[0]?.f1?.setup && (
              <button
                onClick={() => setShowSetup(true)}
                className="px-2 py-1 text-xs bg-app-surface-alt border border-app-border-input rounded text-app-text-muted hover:text-app-text transition-colors"
              >
                Car Setup
              </button>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {telemetry.length > 0 && (
            <button
              onClick={handleCopyMetrics}
              className="text-xs text-app-text-secondary hover:text-app-text border border-app-border-input rounded px-3 py-1.5 transition-colors"
            >
              Copy
            </button>
          )}
          {telemetry.length > 0 && (
            <button
              onClick={handleExport}
              className="text-xs text-app-text-secondary hover:text-app-text border border-app-border-input rounded px-3 py-1.5 transition-colors"
            >
              Export CSV
            </button>
          )}
          {telemetry.length > 0 && (
            <button
              onClick={() => setAiPanelOpen((v) => !v)}
              className={`flex items-center gap-1.5 text-xs border rounded px-3 py-1.5 transition-colors ${
                aiPanelOpen
                  ? "text-amber-400 border-amber-400/40 bg-amber-400/10"
                  : "text-app-text-secondary hover:text-amber-400 border-app-border-input"
              }`}
            >
              <Sparkles className="size-3" />
              AI
            </button>
          )}
          {loading && (
            <span className="text-xs text-app-text-muted animate-pulse">
              Loading...
            </span>
          )}
        </div>
      </div>

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
              {currentPacket && (
                <div className="absolute bottom-2 right-2 flex flex-col items-center gap-1">
                  <svg
                    width="44" height="44" viewBox="-22 -22 44 44"
                    style={{ transform: `rotate(${(currentPacket.Steer / 127) * 180}deg)` }}
                  >
                    <circle cx="0" cy="0" r="18" fill="none" stroke="#64748b" strokeWidth="3" opacity="0.6" />
                    <line x1="-12" y1="0" x2="-6" y2="0" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
                    <line x1="6" y1="0" x2="12" y2="0" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
                    <line x1="0" y1="6" x2="0" y2="12" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
                    <circle cx="0" cy="0" r="3" fill="#475569" />
                    <line x1="0" y1="-18" x2="0" y2="-14" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <div className="relative bg-app-surface-alt/60 rounded-sm" style={{ width: 80, height: 8 }}>
                    <div className="absolute left-1/2 top-0 w-px h-full bg-app-text-dim/40" />
                    <div
                      className="absolute top-1/2 w-2.5 h-2.5 rounded-full bg-cyan-400 border border-cyan-300 shadow-sm shadow-cyan-400/50"
                      style={{
                        left: `${50 + (currentPacket.Steer / 127) * 50}%`,
                        transform: "translate(-50%, -50%)",
                      }}
                    />
                  </div>
                  <span className="text-[9px] font-mono text-app-text-secondary tabular-nums">
                    {currentPacket.Steer > 0 ? "R" : currentPacket.Steer < 0 ? "L" : ""} {Math.abs(currentPacket.Steer / 127 * 180).toFixed(0)}&deg;
                  </span>
                  <div className="flex gap-1 items-end" style={{ height: 60 }}>
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[9px] font-mono font-bold tabular-nums" style={{ color: brakeBarColor(currentPacket.Brake) }}>{((currentPacket.Brake / 255) * 100).toFixed(0)}</span>
                      <div className="w-4 bg-app-surface-alt/60 rounded-sm overflow-hidden relative" style={{ height: 40 }}>
                        <div className="absolute bottom-0 w-full rounded-sm transition-all" style={{ height: `${(currentPacket.Brake / 255) * 100}%`, background: `linear-gradient(to top, #ff9933, ${brakeBarColor(currentPacket.Brake)})` }} />
                      </div>
                      <span className="text-[7px] text-app-text-muted">B</span>
                    </div>
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[9px] font-mono text-emerald-400 font-bold tabular-nums">{((currentPacket.Accel / 255) * 100).toFixed(0)}</span>
                      <div className="w-4 bg-app-surface-alt/60 rounded-sm overflow-hidden relative" style={{ height: 40 }}>
                        <div className="absolute bottom-0 w-full bg-emerald-400 rounded-sm transition-all" style={{ height: `${(currentPacket.Accel / 255) * 100}%` }} />
                      </div>
                      <span className="text-[7px] text-app-text-muted">T</span>
                    </div>
                  </div>
                </div>
              )}
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
            <div className="border-r border-app-border flex flex-col items-center justify-start overflow-y-auto shrink-0" style={{ width: rightColWidth }}>
              {/* Wheel panel tabs */}
              <div className="flex w-full border-b border-app-border shrink-0">
                <button
                  onClick={() => setWheelTab("2d")}
                  className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
                    vizMode === "2d"
                      ? "text-app-text border-b-2 border-app-accent"
                      : "text-app-text-muted hover:text-app-text"
                  }`}
                >
                  2D
                </button>
                <button
                  onClick={() => setWheelTab("3d")}
                  className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
                    vizMode === "3d"
                      ? "text-app-text border-b-2 border-app-accent"
                      : "text-app-text-muted hover:text-app-text"
                  }`}
                >
                  3D
                </button>
              </div>

              <div className="p-2 flex flex-col items-center gap-2 w-full flex-1 min-h-0">
              {vizMode === "2d" ? (
                <>
                  {currentPacket && (
                    <div className="flex items-center justify-center gap-2">
                      <span className="text-lg font-mono font-bold text-app-accent">{currentPacket.Gear === 0 ? "R" : currentPacket.Gear === 11 ? "N" : currentPacket.Gear}</span>
                      <span className="text-xl font-mono font-bold tabular-nums text-app-text">{(currentDisplayPacket?.DisplaySpeed ?? units.speed(currentPacket.Speed)).toFixed(0)} <span className="text-[10px] text-app-text-muted">{units.speedLabel}</span></span>
                    </div>
                  )}
                  {currentPacket && (
                    <div className="flex items-center gap-2">
                      <GForceCircle packet={currentPacket} />
                    </div>
                  )}
                  {currentPacket && <TireDiagram packet={currentPacket} />}
                </>
              ) : (
                <div className="w-full flex-1 min-h-0 relative">
                  {currentDisplayPacket && <CarWireframe packet={currentDisplayPacket} telemetry={displayTelemetry} cursorRef={cursorRef} telemetryRef={displayTelemetryRef} cursorIdx={cursorIdx} outline={lapLine} boundaries={boundaries} carOrdinal={currentDisplayPacket.CarOrdinal} tempLabel={units.tempLabel} />}
                  {currentPacket && (
                    <div className="absolute bottom-1 left-1 opacity-80">
                      <BodyAttitude packet={currentPacket} />
                    </div>
                  )}
                  {currentPacket && (
                    <div className="absolute bottom-1 left-1 opacity-90" style={{ bottom: "9rem" }}>
                      <GForceCircle packet={currentPacket} />
                    </div>
                  )}
                </div>
              )}
              </div>
            </div>

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
          <div className="w-[22rem] h-full shrink-0 border-l border-app-border bg-app-surface/50 flex flex-col overflow-hidden">
              {/* Tab switcher */}
              <div className="flex border-b border-app-border shrink-0">
                <button
                  onClick={() => setSidebarTab("live")}
                  className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
                    sidebarTab === "live"
                      ? "text-app-text border-b-2 border-app-accent"
                      : "text-app-text-muted hover:text-app-text"
                  }`}
                >
                  Data
                </button>
                <button
                  onClick={() => setSidebarTab("insights")}
                  className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
                    sidebarTab === "insights"
                      ? "text-app-text border-b-2 border-app-accent"
                      : "text-app-text-muted hover:text-app-text"
                  }`}
                >
                  Insights
                  {lapInsights.length > 0 && (
                    <span className="ml-1 text-[9px] bg-app-border-input text-app-text rounded-full px-1.5">
                      {lapInsights.length}
                    </span>
                  )}
                </button>
              </div>

              {sidebarTab === "live" && (
                <div className="px-3 pt-3 pb-1 shrink-0">
                  <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-0 font-semibold">
                    Metrics at Cursor
                  </h3>
                </div>
              )}
              <div className="p-3 flex-1 min-h-0 overflow-y-auto">
              {sidebarTab === "live" ? (
                <>
              {currentPacket && <MetricsPanel pkt={currentPacket} startFuel={telemetry[0]?.Fuel} gameId={gameId ?? undefined} />}

              {currentPacket && (
                <>
                  <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2 mt-3 pt-2 border-t border-app-border font-semibold">
                    Dynamics
                  </h3>
                  {(() => {
                    const isF1 = gameId === "f1-2025";
                    const ws = allWheelStates(currentPacket);
                    const fc = allFrictionCircle(currentPacket);
                    const bal = steerBalance(currentPacket);
                    const latG = Math.abs(currentPacket.AccelerationX) / 9.81;
                    const lonG = currentPacket.AccelerationZ / 9.81;
                    return (
                      <div className="text-[11px] font-mono space-y-1.5 mb-3">
                        {/* Balance — estimated from slip angles */}
                        {(
                          <div className="flex justify-between">
                            <span className="text-app-text-muted">Balance</span>
                            <span className="tabular-nums" style={{ color: balanceColor(bal.state) }}>
                              {bal.state === "neutral" ? "Neutral" : bal.state === "understeer" ? "Understeer" : "Oversteer"}
                              <span className="text-app-text-dim ml-1">({bal.deltaDeg > 0 ? "+" : ""}{bal.deltaDeg.toFixed(1)}°)</span>
                            </span>
                          </div>
                        )}
                        {/* G-Force */}
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">G-Force</span>
                          <span className="tabular-nums text-app-text">
                            Lat {latG.toFixed(2)}g
                            <span className="text-app-text-dim"> </span>
                            Lon {lonG > 0 ? "+" : ""}{lonG.toFixed(2)}g
                          </span>
                        </div>
                        {/* Grip / slip ratios — Forza has real data, F1 skips */}
                        {!isF1 && (
                          <>
                            <div className="flex justify-between">
                              <span className="text-app-text-muted">Grip Used</span>
                              <span className="tabular-nums">
                                <span style={{ color: frictionUtilColor(fc.fl) }}>FL {(fc.fl * 100).toFixed(0)}</span>
                                <span className="text-app-text-dim"> </span>
                                <span style={{ color: frictionUtilColor(fc.fr) }}>FR {(fc.fr * 100).toFixed(0)}</span>
                                <span className="text-app-text-dim"> </span>
                                <span style={{ color: frictionUtilColor(fc.rl) }}>RL {(fc.rl * 100).toFixed(0)}</span>
                                <span className="text-app-text-dim"> </span>
                                <span style={{ color: frictionUtilColor(fc.rr) }}>RR {(fc.rr * 100).toFixed(0)}%</span>
                              </span>
                            </div>
                            <div className="border-t border-app-border pt-1">
                              <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">Slip</div>
                              <div className="space-y-1">
                                <div className="flex justify-between">
                                  <span className="text-app-text-muted">Ratio</span>
                                  <span className="tabular-nums">
                                    <span style={{ color: slipRatioColor(ws.fl.slipRatio) }}>FL {(ws.fl.slipRatio * 100).toFixed(0)}</span>
                                    <span className="text-app-text-dim"> </span>
                                    <span style={{ color: slipRatioColor(ws.fr.slipRatio) }}>FR {(ws.fr.slipRatio * 100).toFixed(0)}</span>
                                    <span className="text-app-text-dim"> </span>
                                    <span style={{ color: slipRatioColor(ws.rl.slipRatio) }}>RL {(ws.rl.slipRatio * 100).toFixed(0)}</span>
                                    <span className="text-app-text-dim"> </span>
                                    <span style={{ color: slipRatioColor(ws.rr.slipRatio) }}>RR {(ws.rr.slipRatio * 100).toFixed(0)}%</span>
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-app-text-muted">Angle</span>
                                  <span className="tabular-nums">
                                    <SlipAngleValue label="FL" value={currentPacket.TireSlipAngleFL} speedMph={currentPacket.Speed * 2.23694} />
                                    <span className="text-app-text-dim"> </span>
                                    <SlipAngleValue label="FR" value={currentPacket.TireSlipAngleFR} speedMph={currentPacket.Speed * 2.23694} />
                                    <span className="text-app-text-dim"> </span>
                                    <SlipAngleValue label="RL" value={currentPacket.TireSlipAngleRL} speedMph={currentPacket.Speed * 2.23694} />
                                    <span className="text-app-text-dim"> </span>
                                    <SlipAngleValue label="RR" value={currentPacket.TireSlipAngleRR} speedMph={currentPacket.Speed * 2.23694} />
                                  </span>
                                </div>
                              </div>
                            </div>
                          </>
                        )}
                        {/* Tire state — derived from slip angles for all games */}
                        {(() => {
                          const RAD2DEG = 180 / Math.PI;
                          const slipFL = Math.abs(currentPacket.TireSlipAngleFL) * RAD2DEG;
                          const slipFR = Math.abs(currentPacket.TireSlipAngleFR) * RAD2DEG;
                          const slipRL = Math.abs(currentPacket.TireSlipAngleRL) * RAD2DEG;
                          const slipRR = Math.abs(currentPacket.TireSlipAngleRR) * RAD2DEG;
                          const braking = currentPacket.Brake > 50;
                          const tireState = (slip: number, isRear: boolean) => {
                            if (braking && slip > 15) return { label: "LOCK", color: "#ef4444" };
                            if (!isRear && slip > 12) return { label: "SLIDE", color: "#fb923c" };
                            if (isRear && slip > 8) return { label: "SLIDE", color: "#fb923c" };
                            if (slip > 4) return { label: "SLIP", color: "#fbbf24" };
                            return { label: "GRIP", color: "#34d399" };
                          };
                          const states = [
                            { l: "FL", ...tireState(slipFL, false) },
                            { l: "FR", ...tireState(slipFR, false) },
                            { l: "RL", ...tireState(slipRL, true) },
                            { l: "RR", ...tireState(slipRR, true) },
                          ];
                          return (
                            <div className="flex justify-between">
                              <span className="text-app-text-muted">Tire State</span>
                              <span className="tabular-nums">
                                {states.map(s => (
                                  <span key={s.l} className="ml-1" style={{ color: s.color }}>
                                    {s.l} {s.label}
                                  </span>
                                ))}
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })()}

                  {gameId === "f1-2025" && currentPacket && (() => {
                    const ersPct = (currentPacket.ErsStoreEnergy ?? 0) / 4_000_000 * 100;
                    const ersBarColor = ersPct < 20 ? "bg-red-500" : ersPct < 50 ? "bg-yellow-500" : "bg-green-500";
                    const WEATHER_NAMES = ["Clear", "Light Cloud", "Overcast", "Light Rain", "Heavy Rain", "Storm"];
                    return (
                    <>
                      <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2 pt-2 border-t border-app-border font-semibold">
                        DRS / ERS
                      </h3>
                      <div className="text-[11px] font-mono space-y-1.5 mb-3">
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">DRS</span>
                          <span className={`font-bold ${currentPacket.DrsActive ? "text-green-400" : "text-app-text-dim"}`}>
                            {currentPacket.DrsActive ? "OPEN" : "OFF"}
                          </span>
                        </div>
                        <div>
                          <div className="flex justify-between mb-0.5">
                            <span className="text-app-text-muted">ERS Store</span>
                            <span className="tabular-nums text-blue-400">{ersPct.toFixed(1)}%</span>
                          </div>
                          <div className="h-1.5 bg-app-surface-alt rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all ${ersBarColor}`} style={{ width: `${ersPct}%` }} />
                          </div>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Deployed</span>
                          <span className="tabular-nums text-amber-400">{((currentPacket.ErsDeployed ?? 0) / 4_000_000 * 100).toFixed(1)}%</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Harvested</span>
                          <span className="tabular-nums text-emerald-400">{((currentPacket.ErsHarvested ?? 0) / 4_000_000 * 100).toFixed(1)}%</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Mode</span>
                          <span className="tabular-nums text-app-text">{["None", "Low", "Medium", "High", "Overtake"][currentPacket.ErsDeployMode ?? 0] ?? "Unknown"}</span>
                        </div>
                      </div>

                      <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2 pt-2 border-t border-app-border font-semibold">
                        Conditions
                      </h3>
                      <div className="text-[11px] font-mono space-y-1.5 mb-3">
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Weather</span>
                          <span className="text-app-text">{WEATHER_NAMES[currentPacket.WeatherType ?? 0] ?? "Unknown"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Track</span>
                          <span className="tabular-nums text-orange-400">{currentPacket.TrackTemp ?? 0}°C</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Air</span>
                          <span className="tabular-nums text-cyan-400">{currentPacket.AirTemp ?? 0}°C</span>
                        </div>
                        {(currentPacket.RainPercent ?? 0) > 0 && (
                          <div className="flex justify-between">
                            <span className="text-app-text-muted">Rain</span>
                            <span className="tabular-nums text-blue-400">{currentPacket.RainPercent}%</span>
                          </div>
                        )}
                      </div>
                    </>
                    );
                  })()}

                  <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2 pt-2 border-t border-app-border font-semibold">
                    Wheels
                  </h3>
                  {(() => {
                    const isF1 = gameId === "f1-2025";
                    return (
                  <div className="space-y-2 text-[11px] font-mono">
                    {/* Tyres */}
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                      <div className="space-y-2">
                        <div>
                          <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">Tyre Temp</div>
                          <div className="grid grid-cols-2 gap-x-2">
                            {(() => {
                              const fl = currentDisplayPacket?.DisplayTireTempFL ?? currentPacket.TireTempFL;
                              const fr = currentDisplayPacket?.DisplayTireTempFR ?? currentPacket.TireTempFR;
                              const rl = currentDisplayPacket?.DisplayTireTempRL ?? currentPacket.TireTempRL;
                              const rr = currentDisplayPacket?.DisplayTireTempRR ?? currentPacket.TireTempRR;
                              const tireColor = isF1 || gameId === "acc"
                                ? (t: number) => t < 70 ? "#3b82f6" : t < 80 ? "#94a3b8" : t < 105 ? "#34d399" : t < 115 ? "#fbbf24" : "#ef4444"
                                : (t: number) => t < 160 ? "#3b82f6" : t < 180 ? "#94a3b8" : t < 220 ? "#34d399" : t < 240 ? "#fbbf24" : "#ef4444";
                              return <>
                                <span className="text-app-text-secondary">FL: <span className="tabular-nums" style={{ color: tireColor(fl) }}>{fl.toFixed(0)}{units.tempLabel}</span></span>
                                <span className="text-app-text-secondary">FR: <span className="tabular-nums" style={{ color: tireColor(fr) }}>{fr.toFixed(0)}{units.tempLabel}</span></span>
                                <span className="text-app-text-secondary">RL: <span className="tabular-nums" style={{ color: tireColor(rl) }}>{rl.toFixed(0)}{units.tempLabel}</span></span>
                                <span className="text-app-text-secondary">RR: <span className="tabular-nums" style={{ color: tireColor(rr) }}>{rr.toFixed(0)}{units.tempLabel}</span></span>
                              </>;
                            })()}
                          </div>
                        </div>
                        <div className="border-t border-app-border pt-1">
                          <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">Health</div>
                          <div className="grid grid-cols-2 gap-x-2">
                            <WearValue label="FL" value={currentPacket.TireWearFL} />
                            <WearValue label="FR" value={currentPacket.TireWearFR} />
                            <WearValue label="RL" value={currentPacket.TireWearRL} />
                            <WearValue label="RR" value={currentPacket.TireWearRR} />
                          </div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div>
                          <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">Speed (rad/s)</div>
                          <div className="grid grid-cols-2 gap-x-2">
                            <WheelSpeedValue label="FL" value={currentPacket.WheelRotationSpeedFL} />
                            <WheelSpeedValue label="FR" value={currentPacket.WheelRotationSpeedFR} />
                            <WheelSpeedValue label="RL" value={currentPacket.WheelRotationSpeedRL} />
                            <WheelSpeedValue label="RR" value={currentPacket.WheelRotationSpeedRR} />
                          </div>
                        </div>
                        <div className="border-t border-app-border pt-1">
                          <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">Wear /s</div>
                          <div className="grid grid-cols-2 gap-x-2">
                            {(["FL", "FR", "RL", "RR"] as const).map((w) => {
                              const rate = wearRate ? wearRate[w] * 100 : null;
                              const color = rate == null || rate < 0.01 ? "#94a3b8" : rate < 0.05 ? "#34d399" : rate < 0.1 ? "#fbbf24" : "#ef4444";
                              return (
                                <span key={w} className="text-app-text-secondary">
                                  {w}: <span className="tabular-nums" style={{ color }}>{rate != null ? rate.toFixed(3) + "%" : "—"}</span>
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>


                    {/* Brakes — separate section */}
                    {(currentPacket.BrakeTempFrontLeft || currentPacket.f1?.brakeTempFL) ? (
                    <div className="border-t border-app-border pt-2">
                      <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2 font-semibold">Brakes</h3>
                      <div className="grid grid-cols-2 gap-x-2">
                        {(() => {
                          const fl = currentPacket.BrakeTempFrontLeft ?? currentPacket.f1?.brakeTempFL ?? 0;
                          const fr = currentPacket.BrakeTempFrontRight ?? currentPacket.f1?.brakeTempFR ?? 0;
                          const rl = currentPacket.BrakeTempRearLeft ?? currentPacket.f1?.brakeTempRL ?? 0;
                          const rr = currentPacket.BrakeTempRearRight ?? currentPacket.f1?.brakeTempRR ?? 0;
                          const color = (t: number) => t > 800 ? "#ef4444" : t > 500 ? "#fb923c" : t > 200 ? "#fbbf24" : "#94a3b8";
                          return <>
                            <span className="text-app-text-secondary">FL: <span className="tabular-nums" style={{ color: color(fl) }}>{fl.toFixed(0)}°C</span></span>
                            <span className="text-app-text-secondary">FR: <span className="tabular-nums" style={{ color: color(fr) }}>{fr.toFixed(0)}°C</span></span>
                            <span className="text-app-text-secondary">RL: <span className="tabular-nums" style={{ color: color(rl) }}>{rl.toFixed(0)}°C</span></span>
                            <span className="text-app-text-secondary">RR: <span className="tabular-nums" style={{ color: color(rr) }}>{rr.toFixed(0)}°C</span></span>
                          </>;
                        })()}
                      </div>
                    </div>
                    ) : null}

                    {/* Suspension — separate section */}
                    <div className="border-t border-app-border pt-2">
                      <div className="flex items-center gap-1 mb-2 group relative">
                        <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider font-semibold">Suspension</h3>
                        <Info className="w-3.5 h-3.5 text-app-text-dim cursor-help" />
                        <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1 text-[10px] text-app-text-secondary whitespace-nowrap z-10 pointer-events-none">
                          Load Distribution:<br/>50% = balanced<br/>0% Lon = all front<br/>0% Lat = all left
                        </div>
                      </div>
                      <div className="text-[11px] font-mono mb-2 space-y-1">
                        <div className="flex justify-between">
                          <span className="text-app-text-muted">Load Distribution</span>
                          <span className="tabular-nums text-app-text">
                            Lon {((currentPacket.NormSuspensionTravelFL + currentPacket.NormSuspensionTravelFR) / 2 * 100).toFixed(0)}%
                            <span className="text-app-text-dim"> </span>
                            Lat {((currentPacket.NormSuspensionTravelFL + currentPacket.NormSuspensionTravelRL) / 2 * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-x-2">
                        <SuspValue label="FL" value={currentPacket.NormSuspensionTravelFL} />
                        <SuspValue label="FR" value={currentPacket.NormSuspensionTravelFR} />
                        <SuspValue label="RL" value={currentPacket.NormSuspensionTravelRL} />
                        <SuspValue label="RR" value={currentPacket.NormSuspensionTravelRR} />
                      </div>
                    </div>
                  </div>
                    );
                  })()}
                  {/* Surface conditions — Forza only */}
                  {gameId !== "f1-2025" && (
                  <>
                  <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2 mt-3 pt-2 border-t border-app-border font-semibold">
                    Surface
                  </h3>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] font-mono">
                    {[
                      { label: "FL", rumble: currentPacket.WheelOnRumbleStripFL !== 0, puddle: currentPacket.WheelInPuddleDepthFL },
                      { label: "FR", rumble: currentPacket.WheelOnRumbleStripFR !== 0, puddle: currentPacket.WheelInPuddleDepthFR },
                      { label: "RL", rumble: currentPacket.WheelOnRumbleStripRL !== 0, puddle: currentPacket.WheelInPuddleDepthRL },
                      { label: "RR", rumble: currentPacket.WheelOnRumbleStripRR !== 0, puddle: currentPacket.WheelInPuddleDepthRR },
                    ].map(w => (
                      <span key={w.label} className="text-app-text-secondary">
                        {w.label}:{" "}
                        {w.rumble && <span className="font-bold text-orange-400">CURB </span>}
                        {w.puddle > 0 && <span className="font-bold text-blue-400">WET {(w.puddle * 100).toFixed(0)}%</span>}
                        {!w.rumble && w.puddle <= 0 && <span className="text-app-text-dim">—</span>}
                      </span>
                    ))}
                  </div>
                  </>
                  )}
                </>
              )}
              </>
            ) : (
              <InsightPanel insights={lapInsights} onJumpToFrame={(idx) => {
                setCursorIdx(idx);
                cursorRef.current = idx;
                seekRef.current++;
              }} />
            )}
            </div>
          </div>

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
