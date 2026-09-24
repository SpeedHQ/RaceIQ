import { getGame } from "@shared/games/registry";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { carIdentityKey, trackIdentityKey, type LapMeta } from "../../../../shared/racing/sessions/types";
import { useCarName, useResolveNames } from "../../hooks/catalog-queries";
import type { SemanticReplayFrame } from "../../hooks/laps";
import { useLapSemanticTelemetry, useLaps as useLapsQuery } from "../../hooks/laps";
import { useTrackBoundaries, useTrackName, useTrackOutline, useTrackSectorBoundaries, useTrackSectors } from "../../hooks/track-queries";
import { useCookieState } from "../../hooks/useCookieState";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { AnalyseSearch } from "../../lib/game-routes";
import { mergeNameCache } from "../../lib/name-cache";
import { routePrefixForGameId } from "../../lib/game-routes";
import {
  DEFAULT_TRACK_OVERLAYS,
  semanticValues,
  type Point,
  type SectorBoundaries,
  type SemanticAnalysisFrame,
  type TrackMapBoundaries,
  type TrackMapLabel,
  type TrackOverlays,
} from "./track-map/types";
interface AnalyseSemanticFrame {
  sequence: number;
  observedAtMs: number;
  values: SemanticAnalysisFrame["values"];
  states: Readonly<Record<string, string | undefined>>;
  freshness: Readonly<Record<string, string | undefined>>;
  source?: "motec" | null;
}
const emptyLaps: LapMeta[] = [];

type IdentityKey = number | string;

function lapTrackKey(lap: LapMeta): IdentityKey | null {
  return trackIdentityKey(lap);
}

function lapCarKey(lap: LapMeta): IdentityKey | null {
  return carIdentityKey(lap);
}

export function useAnalyseSelections(search: AnalyseSearch, gameId: Parameters<typeof getGame>[0], sessionId?: number) {
  const navigate = useNavigate();
  const [laps, setLaps] = useState<LapMeta[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<IdentityKey | null>(search.track ?? null);
  const [selectedCar, setSelectedCar] = useState<IdentityKey | null>(search.car ?? null);
  const [selectedLapId, setSelectedLapId] = useState<number | null>(search.lap ?? null);
  const routeSelectionKey = `${gameId}:${search.track ?? ""}:${search.car ?? ""}:${search.lap ?? ""}`;
  const pendingRouteSelectionKey = useRef<string | null>(null);
  useEffect(() => {
    pendingRouteSelectionKey.current = routeSelectionKey;
    setSelectedTrack(search.track ?? null);
    setSelectedCar(search.car ?? null);
    setSelectedLapId(search.lap ?? null);
  }, [routeSelectionKey]);
  const { data: allLaps = emptyLaps } = useLapsQuery();
  const selectedLap = allLaps.find((lap) => lap.id === selectedLapId);
  const { data: semanticReplay, isLoading: semanticLoading, error: semanticError } = useLapSemanticTelemetry(search.view === "track" ? null : selectedLapId);
  const semanticFrames = useMemo<AnalyseSemanticFrame[]>(
    () =>
      semanticReplay?.envelopes.map((envelope: SemanticReplayFrame) => ({
        sequence: envelope.sequence,
        observedAtMs: envelope.observedAt.milliseconds,
        values: semanticValues(envelope.values),
        states: Object.fromEntries(envelope.values.filter((entry) => entry.state).map((entry) => [entry.semanticId, entry.state])),
        freshness: Object.fromEntries(envelope.values.filter((entry) => entry.freshness).map((entry) => [entry.semanticId, entry.freshness])),
        source: selectedLap?.source ?? null,
      })) ?? [],
    [semanticReplay, selectedLap?.source],
  );
  const lapLoading = semanticLoading;

  const parseError = semanticError instanceof Error && "parseError" in semanticError ? String((semanticError as Error & { parseError?: unknown }).parseError ?? "") : null;
  const lapError = parseError ? null : semanticError;
  useEffect(() => {
    if (selectedTrack == null && selectedLap) setSelectedTrack(lapTrackKey(selectedLap));
    if (selectedCar == null && selectedLap) setSelectedCar(lapCarKey(selectedLap));
  }, [selectedLap, selectedTrack, selectedCar]);
  const trackOrd = selectedTrack ?? (selectedLap ? lapTrackKey(selectedLap) : null);
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
  const sectorData = useMemo<{ sectorStarts: number[]; sectorCount: number; firstDist: number; lapDist: number; times: number[] } | null>(() => {
    if (!semanticReplay || semanticFrames.length < 2) return null;
    const distances = semanticFrames.map((frame) => frame.values["timing.distance-traveled"]).filter((value): value is number => typeof value === "number");
    const firstDist = distances[0] ?? 0;
    const lapDist = (distances.at(-1) ?? 0) - firstDist;
    const rawSectors = sectorsRaw && typeof sectorsRaw === "object" ? (sectorsRaw as { s1End?: number; s2End?: number }) : null;
    const starts = semanticReplay.sectorStarts ?? (rawSectors?.s1End != null && rawSectors.s2End != null ? [0, rawSectors.s1End, rawSectors.s2End] : null);
    if (!starts?.length) return null;
    const times = semanticReplay.sectorTimes ?? [];
    return { sectorStarts: starts, sectorCount: starts.length, firstDist, lapDist, times };
  }, [semanticReplay, semanticFrames, sectorsRaw]);
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
  const [trackOverlays, setTrackOverlays] = useLocalStorage<TrackOverlays>("analyse-trackOverlays", DEFAULT_TRACK_OVERLAYS);
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
    setLaps(allLaps.filter((l) => l.lapTime > 0 && (sessionId == null || l.sessionId === sessionId)));
  }, [allLaps, sessionId]);
  const [trackNames, setTrackNames] = useState<Record<string, string>>({});
  const [carNames, setCarNames] = useState<Record<string, string>>({});
  const tracks = useMemo(() => {
    const seen = new Map<IdentityKey, number>();
    for (const lap of laps) {
      const key = lapTrackKey(lap);
      if (key != null) seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return Array.from(seen.entries()).sort((a, b) => (trackNames[a[0]] ?? `Track ${a[0]}`).localeCompare(trackNames[b[0]] ?? `Track ${b[0]}`));
  }, [laps, trackNames, gameId]);
  const carsForTrack = useMemo(() => {
    if (selectedTrack == null) return [];
    const seen = new Map<IdentityKey, number>();
    for (const lap of laps) {
      const trackKey = lapTrackKey(lap);
      const carKey = lapCarKey(lap);
      if (trackKey === selectedTrack && carKey != null) seen.set(carKey, (seen.get(carKey) ?? 0) + 1);
    }
    return Array.from(seen.entries()).sort((a, b) => (carNames[a[0]] ?? `Car ${a[0]}`).localeCompare(carNames[b[0]] ?? `Car ${b[0]}`));
  }, [laps, selectedTrack, carNames, gameId]);
  const filteredLaps = useMemo(
    () => sessionId != null
      ? laps.filter((lap) => lap.sessionId === sessionId)
      : selectedTrack == null || selectedCar == null
        ? []
        : laps.filter((lap) => lapTrackKey(lap) === selectedTrack && lapCarKey(lap) === selectedCar),
    [laps, selectedTrack, selectedCar, gameId, sessionId],
  );
  const { data: initialTrackName } = useTrackName(selectedTrack ?? undefined);
  const { data: initialCarName } = useCarName(selectedCar ?? undefined);
  useEffect(() => {
    if (initialTrackName && selectedTrack != null) setTrackNames((p) => (p[selectedTrack] === initialTrackName ? p : { ...p, [selectedTrack]: initialTrackName }));
  }, [initialTrackName, selectedTrack]);
  useEffect(() => {
    if (initialCarName && selectedCar != null) setCarNames((p) => (p[selectedCar] === initialCarName ? p : { ...p, [selectedCar]: initialCarName }));
  }, [initialCarName, selectedCar]);
  const missingTrackOrds = useMemo(() => gameId === "lmu" ? [] : [...new Set(laps.map((l) => l.trackOrdinal).filter((ord): ord is number => ord != null && !trackNames[ord]))], [laps, trackNames, gameId]);
  const missingCarOrds = useMemo(() => gameId === "lmu" ? [] : [...new Set(laps.map((l) => l.carOrdinal).filter((ord): ord is number => ord != null && !carNames[ord]))], [laps, carNames, gameId]);
  const { data: resolvedNames } = useResolveNames(missingTrackOrds, missingCarOrds);
  useEffect(() => {
    if (!resolvedNames) return;
    if (resolvedNames.trackNames) setTrackNames((p) => mergeNameCache(p, resolvedNames.trackNames));
    if (resolvedNames.carNames) setCarNames((p) => mergeNameCache(p, resolvedNames.carNames));
  }, [resolvedNames]);
  const carName = selectedCar != null ? (carNames[selectedCar] ?? "") : "";
  const trackName = selectedTrack != null ? (trackNames[selectedTrack] ?? "") : "";

  useEffect(() => {
    if (sessionId != null) {
      if (selectedLapId == null) return;
      const routePrefix = routePrefixForGameId(gameId);
      if (routePrefix) void navigate({
        to: `/${routePrefix}/sessions/${sessionId}/replay/${selectedLapId}` as never,
        search: {} as never,
        replace: true,
      });
      return;
    }
    const pendingKey = pendingRouteSelectionKey.current;
    if (pendingKey != null) {
      const routeMatchesState = selectedTrack === (search.track ?? null) && selectedCar === (search.car ?? null) && selectedLapId === (search.lap ?? null);
      if (!routeMatchesState) return;
      pendingRouteSelectionKey.current = null;
      return;
    }
    void navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, track: selectedTrack ?? undefined, car: selectedCar ?? undefined, lap: selectedLapId ?? undefined }) as never,
      replace: true,
    });
  }, [search.track, search.car, search.lap, selectedTrack, selectedCar, selectedLapId, sessionId, gameId, navigate]);
  const handleTrackChange = useCallback((value: IdentityKey | null) => {
    setSelectedTrack(value);
    setSelectedCar(null);
    setSelectedLapId(null);
  }, []);
  const handleCarChange = useCallback((value: IdentityKey | null) => {
    setSelectedCar(value);
    setSelectedLapId(null);
  }, []);
  const selectLap = useCallback((trackKey: IdentityKey, carKey: IdentityKey, lapId: number) => {
    setSelectedTrack(trackKey);
    setSelectedCar(carKey);
    setSelectedLapId(lapId);
  }, []);

  const cursorRef = useRef(0);
  return {
    laps,
    setLaps,
    lapLoading,
    lapError,
    parseError,
    selectedLap,
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
    trackOverlays,
    setTrackOverlays,
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
    handleTrackChange,
    handleCarChange,
    selectLap,
    cursorRef,
  };
}
