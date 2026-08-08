import { getGame } from "@shared/games/registry";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LapMeta } from "../../../../shared/racing/sessions/types";
import { useCarName, useResolveNames } from "../../hooks/catalog-queries";
import { useLaps as useLapsQuery, useLapSemanticTelemetry } from "../../hooks/laps";
import { useConvertedTelemetry } from "../../hooks/useConvertedTelemetry";
import { useTrackBoundaries, useTrackName, useTrackOutline, useTrackSectorBoundaries, useTrackSectors } from "../../hooks/track-queries";
import { useCookieState } from "../../hooks/useCookieState";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { AnalyseSearch } from "../../lib/game-routes";
import { mergeNameCache } from "../../lib/name-cache";
import type { Point, SectorBoundaries, TrackMapBoundaries, TrackMapLabel } from "./track-map/types";
import type { SemanticLapTelemetry } from "../../hooks/laps";
import { semanticReplayToAnalysisFrames } from "../../lib/semantic-replay";

export interface SemanticAnalysisFrame {
  sequence: number;
  values: Readonly<Record<string, unknown>>;
  observedAtMs: number;
}

function toSemanticFrames(replay: SemanticLapTelemetry | undefined): SemanticAnalysisFrame[] {
  return replay?.envelopes.map((envelope) => ({
    sequence: envelope.sequence,
    observedAtMs: envelope.observedAt.milliseconds,
    values: Object.fromEntries(envelope.values.map((entry) => [entry.semanticId, entry.value])),
  })) ?? [];
}
const emptyLaps: LapMeta[] = [];

export function useAnalyseSelections(search: AnalyseSearch, gameId: Parameters<typeof getGame>[0]) {
  const navigate = useNavigate();
  const [laps, setLaps] = useState<LapMeta[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(search.track ?? null);
  const [selectedCar, setSelectedCar] = useState<number | null>(search.car ?? null);
  const [selectedLapId, setSelectedLapId] = useState<number | null>(search.lap ?? null);
  const { data: allLaps = emptyLaps } = useLapsQuery();
  const { data: semanticReplay, isLoading: semanticLoading, error: semanticError } = useLapSemanticTelemetry(selectedLapId);
  const semanticFrames = useMemo(() => toSemanticFrames(semanticReplay), [semanticReplay]);
  const telemetry = useMemo(() => semanticReplayToAnalysisFrames(semanticReplay), [semanticReplay]);
  const displayTelemetry = useConvertedTelemetry(telemetry);
  const selectedLap = allLaps.find((lap) => lap.id === selectedLapId);
  const lapLoading = semanticLoading;
  const parseError = null;
  const lapError = semanticError;
  useEffect(() => {
    if (selectedTrack == null && selectedLap?.trackOrdinal != null) setSelectedTrack(selectedLap.trackOrdinal);
    if (selectedCar == null && selectedLap?.carOrdinal != null) setSelectedCar(selectedLap.carOrdinal);
  }, [selectedLap, selectedTrack, selectedCar]);
  const trackOrd = selectedTrack ?? selectedLap?.trackOrdinal ?? null;
  const { data: outlineRaw } = useTrackOutline(trackOrd ?? undefined);
  const outline = useMemo(() => {
    if (!outlineRaw) return null;
    if (Array.isArray(outlineRaw)) return outlineRaw as Point[];
    if (typeof outlineRaw !== "object") return null;
    const d = outlineRaw as { points?: unknown };
    return Array.isArray(d.points) ? (d.points as Point[]) : null;
  }, [outlineRaw]);
  const mapLabels = useMemo(() => {
    if (!outlineRaw || Array.isArray(outlineRaw) || typeof outlineRaw !== "object") return null;
    const labels = (outlineRaw as { labels?: unknown }).labels;
    return Array.isArray(labels) ? (labels as TrackMapLabel[]) : null;
  }, [outlineRaw]);
  const { data: boundariesRaw } = useTrackBoundaries(trackOrd ?? undefined);
  const boundaries = boundariesRaw && typeof boundariesRaw === "object" ? (boundariesRaw as TrackMapBoundaries) : null;
  const { data: sectorsRaw } = useTrackSectorBoundaries(trackOrd ?? undefined);
  const sectorData = useMemo<{ sectorStarts: number[]; sectorCount: number; firstDist: number; lapDist: number } | null>(() => null, [semanticReplay]);
  const sectors = useMemo(() => {
    if (getGame(gameId).nativeSectors) return sectorData ? ({ sectorStarts: sectorData.sectorStarts, sectorCount: sectorData.sectorCount } satisfies SectorBoundaries) : null;
    if (!sectorsRaw || typeof sectorsRaw !== "object") return null;
    const s = sectorsRaw as { s1End?: number; s2End?: number };
    return s.s1End != null && s.s2End != null ? ({ sectorStarts: [0, s.s1End, s.s2End], sectorCount: 3 } satisfies SectorBoundaries) : null;
  }, [gameId, sectorData, sectorsRaw]);
  const { data: segmentsRaw } = useTrackSectors(trackOrd ?? undefined);
  const segments = useMemo(() => {
    if (!segmentsRaw || typeof segmentsRaw !== "object") return null;
    const s = segmentsRaw as { segments?: unknown };
    return Array.isArray(s.segments) ? (s.segments as { type: string; name: string; startFrac: number; endFrac: number }[]) : null;
  }, [segmentsRaw]);
  const initialCursor = search.cursor;
  const [mapZoom, setMapZoom] = useLocalStorage("analyse-mapZoom", 1);
  const [rotateWithCar, setRotateWithCar] = useLocalStorage("analyse-rotateWithCar", false);
  const [trackOverlay, setTrackOverlay] = useLocalStorage<"none" | "inputs" | "segments" | "sectors">("analyse-trackOverlay", "none");
  const [vizMode, setWheelTab] = useCookieState<"2d" | "3d">("analyse-vizMode", "2d");
  const appliedVizParam = useRef(false);
  useEffect(() => {
    if (!appliedVizParam.current && (search.viz === "3d" || search.viz === "2d")) {
      setWheelTab(search.viz);
      appliedVizParam.current = true;
    }
  }, [search.viz]);
  const [leftColWidth, setLeftColWidth] = useCookieState("analyse-leftCol", 150);
  const [rightColWidth, setRightColWidth] = useCookieState("analyse-rightCol", 650);
  const [topHeight, setTopHeight] = useCookieState("analyse-topHeight", 500);
  useEffect(() => {
    setLaps(allLaps.filter((l) => l.lapTime > 0));
  }, [allLaps]);
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});
  const [carNames, setCarNames] = useState<Record<number, string>>({});
  const tracks = useMemo(() => {
    const seen = new Map<number, number>();
    for (const l of laps) if (l.trackOrdinal != null) seen.set(l.trackOrdinal, (seen.get(l.trackOrdinal) ?? 0) + 1);
    return Array.from(seen.entries()).sort((a, b) => (trackNames[a[0]] ?? `Track ${a[0]}`).localeCompare(trackNames[b[0]] ?? `Track ${b[0]}`));
  }, [laps, trackNames]);
  const carsForTrack = useMemo(() => {
    if (selectedTrack == null) return [];
    const seen = new Map<number, number>();
    for (const l of laps) if (l.trackOrdinal === selectedTrack && l.carOrdinal != null) seen.set(l.carOrdinal, (seen.get(l.carOrdinal) ?? 0) + 1);
    return Array.from(seen.entries()).sort((a, b) => (carNames[a[0]] ?? `Car ${a[0]}`).localeCompare(carNames[b[0]] ?? `Car ${b[0]}`));
  }, [laps, selectedTrack, carNames]);
  const filteredLaps = useMemo(
    () => (selectedTrack == null || selectedCar == null ? [] : laps.filter((l) => l.trackOrdinal === selectedTrack && l.carOrdinal === selectedCar)),
    [laps, selectedTrack, selectedCar],
  );
  const { data: initialTrackName } = useTrackName(selectedTrack ?? undefined);
  const { data: initialCarName } = useCarName(selectedCar ?? undefined);
  useEffect(() => {
    if (initialTrackName && selectedTrack != null) setTrackNames((p) => (p[selectedTrack] === initialTrackName ? p : { ...p, [selectedTrack]: initialTrackName }));
  }, [initialTrackName, selectedTrack]);
  useEffect(() => {
    if (initialCarName && selectedCar != null) setCarNames((p) => (p[selectedCar] === initialCarName ? p : { ...p, [selectedCar]: initialCarName }));
  }, [initialCarName, selectedCar]);
  const missingTrackOrds = useMemo(() => [...new Set(laps.map((l) => l.trackOrdinal).filter((ord): ord is number => ord != null && !trackNames[ord]))], [laps, trackNames]);
  const missingCarOrds = useMemo(() => [...new Set(laps.map((l) => l.carOrdinal).filter((ord): ord is number => ord != null && !carNames[ord]))], [laps, carNames]);
  const { data: resolvedNames } = useResolveNames(missingTrackOrds, missingCarOrds);
  useEffect(() => {
    if (!resolvedNames) return;
    if (resolvedNames.trackNames) setTrackNames((p) => mergeNameCache(p, resolvedNames.trackNames));
    if (resolvedNames.carNames) setCarNames((p) => mergeNameCache(p, resolvedNames.carNames));
  }, [resolvedNames]);
  useEffect(() => {
    void navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, track: selectedTrack ?? undefined, car: selectedCar ?? undefined, lap: selectedLapId ?? undefined }) as never,
      replace: true,
    });
  }, [selectedTrack, selectedCar, selectedLapId, navigate]);
  const handleTrackChange = (value: number | null) => {
    setSelectedTrack(value);
    setSelectedCar(null);
    setSelectedLapId(null);
  };
  const handleCarChange = (value: number | null) => {
    setSelectedCar(value);
    setSelectedLapId(null);
  };
  const [carName, setCarName] = useState("");
  const [trackName, setTrackName] = useState("");
  const cursorRef = useRef(0);
  const lapChangeCount = useRef(0);
  useEffect(() => {
    if (selectedLapId == null) return;
    lapChangeCount.current++;
    if (lapChangeCount.current !== 1 || !initialCursor) cursorRef.current = 0;
    setCarName(selectedCar != null ? (carNames[selectedCar] ?? "") : "");
    setTrackName(selectedTrack != null ? (trackNames[selectedTrack] ?? "") : "");
  }, [selectedLapId]);
  return {
    laps,
    setLaps,
    lapData: undefined as { insights?: unknown[] } | undefined,
    lapLoading,
    lapError,
    parseError,
    telemetry,
    displayTelemetry,
    semanticReplay,
    semanticFrames,
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
  };
}
