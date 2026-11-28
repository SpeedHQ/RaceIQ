import { getGame } from "@raceiq/shared/games/registry"
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { useCarName, useResolveNames } from "../../hooks/catalog-queries";
import { useLapSemanticTelemetry, useLaps as useLapsQuery, useSessionLaps } from "../../hooks/laps";
import { useTrackName, useTrackOutline, useTrackSectors } from "../../hooks/track-queries";
import type { AnalyseSearch } from "@raceiq/session-analyse/contracts";
import { mergeNameCache } from "../../lib/name-cache";
import { routePrefixForGameId } from "../../lib/game-routes";
import type { Point } from "./track-map/types";
const emptyLaps: LapMeta[] = [];

type IdentityKey = string;

const lapTrackKey = (lap: LapMeta): IdentityKey | null => lap.trackId ?? null;
const lapCarKey = (lap: LapMeta): IdentityKey | null => lap.carId ?? null;
export function useAnalyseSelections(search: AnalyseSearch, gameId: Parameters<typeof getGame>[0], sessionId?: number) {
  const navigate = useNavigate();
  const [laps, setLaps] = useState<LapMeta[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<IdentityKey | null>(search.track ?? null);
  const [selectedCar, setSelectedCar] = useState<IdentityKey | null>(search.car ?? null);
  const [selectedLapId, setSelectedLapId] = useState<number | null>(search.lap ?? null);
  const routeSelectionKey = `${gameId}:${sessionId ?? ""}:${search.track ?? ""}:${search.car ?? ""}:${search.lap ?? ""}`;
  const pendingRouteSelectionKey = useRef<string | null>(null);
  const requestedRouteLapId = useRef<number | null>(null);
  useEffect(() => {
    pendingRouteSelectionKey.current = routeSelectionKey;
    setSelectedTrack(search.track ?? null);
    setSelectedCar(search.car ?? null);
    setSelectedLapId(search.lap ?? null);
  }, [routeSelectionKey]);
  const lapsQuery = useLapsQuery({ enabled: sessionId == null });
  const sessionLapsQuery = useSessionLaps(sessionId ?? null);
  const selectedLapsQuery = sessionId == null ? lapsQuery : sessionLapsQuery;
  const allLaps = selectedLapsQuery.data ?? emptyLaps;
  const selectedLap = allLaps.find((lap) => lap.id === selectedLapId && (lap.gameId == null || lap.gameId === gameId));
  const selectedLapReady = selectedLap?.processing?.state === "ready";
  const selectedLapProcessingLoading = selectedLapId != null && selectedLapsQuery.data === undefined;
  const { data: semanticReplay, isLoading: semanticLoading, error: semanticError } = useLapSemanticTelemetry(search.view === "track" || !selectedLapReady ? null : selectedLapId, sessionId);
  const lapLoading = selectedLapReady && semanticLoading;

  const parseError = semanticError instanceof Error && "parseError" in semanticError ? String((semanticError as Error & { parseError?: unknown }).parseError ?? "") : null;
  const lapError = parseError ? null : semanticError;
  useEffect(() => {
    if (selectedTrack == null && selectedLap) setSelectedTrack(lapTrackKey(selectedLap));
    if (selectedCar == null && selectedLap) setSelectedCar(lapCarKey(selectedLap));
  }, [selectedLap, selectedTrack, selectedCar]);
  const trackId = selectedTrack ?? (selectedLap ? lapTrackKey(selectedLap) : null);
  const { data: outlineRaw } = useTrackOutline(trackId ?? undefined);
  const outline = useMemo(() => {
    if (!outlineRaw) return null;
    if (Array.isArray(outlineRaw)) return outlineRaw as Point[];
    if (typeof outlineRaw !== "object") return null;
    const d = outlineRaw as { points?: unknown };
    return Array.isArray(d.points) ? (d.points as Point[]) : null;
  }, [outlineRaw]);
  const { data: segmentsRaw } = useTrackSectors(trackId ?? undefined);
  const segments = useMemo(() => {
    if (!segmentsRaw || typeof segmentsRaw !== "object") return null;
    const s = segmentsRaw as { segments?: unknown };
    return Array.isArray(s.segments) ? (s.segments as { type: string; name: string; startFrac: number; endFrac: number }[]) : null;
  }, [segmentsRaw]);
  const initialCursor = search.cursor;
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
  const missingTrackIds = useMemo(() => [...new Set(laps.map((l) => l.trackId).filter((id): id is string => id != null && !trackNames[id]))], [laps, trackNames]);
  const missingCarIds = useMemo(() => [...new Set(laps.map((l) => l.carId).filter((id): id is string => id != null && !carNames[id]))], [laps, carNames]);
  const { data: resolvedNames } = useResolveNames(missingTrackIds, missingCarIds);
  useEffect(() => {
    if (!resolvedNames) return;
    if (resolvedNames.trackNames) setTrackNames((p) => mergeNameCache(p, resolvedNames.trackNames));
    if (resolvedNames.carNames) setCarNames((p) => mergeNameCache(p, resolvedNames.carNames));
  }, [resolvedNames]);
  const carName = selectedCar != null ? (carNames[selectedCar] ?? "") : "";
  const trackName = selectedTrack != null ? (trackNames[selectedTrack] ?? "") : "";

  useEffect(() => {
    if (sessionId == null) return;
    const requestedLapId = requestedRouteLapId.current;
    if (requestedLapId == null || selectedLapId !== requestedLapId) return;
    requestedRouteLapId.current = null;
    if (!selectedLapReady) return;
    const routePrefix = routePrefixForGameId(gameId);
    if (routePrefix) void navigate({
      to: `/${routePrefix}/sessions/${sessionId}/replay/${selectedLapId}` as never,
      search: { cursor: search.cursor, viz: search.viz, ai: search.ai, view: search.view } as never,
      replace: true,
    });
  }, [search.cursor, search.viz, search.ai, search.view, selectedLapId, selectedLapReady, sessionId, gameId, navigate]);

  useEffect(() => {
    if (sessionId != null) return;
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
  }, [search.track, search.car, search.lap, selectedTrack, selectedCar, selectedLapId, sessionId, navigate]);
  const handleTrackChange = useCallback((value: IdentityKey | null) => {
    requestedRouteLapId.current = null;
    setSelectedTrack(value);
    setSelectedCar(null);
    setSelectedLapId(null);
  }, []);
  const handleCarChange = useCallback((value: IdentityKey | null) => {
    requestedRouteLapId.current = null;
    setSelectedCar(value);
    setSelectedLapId(null);
  }, []);

  const handleLapChange = useCallback((value: number | null) => {
    if (value == null) {
      requestedRouteLapId.current = null;
      setSelectedLapId(null);
      return;
    }
    if (!allLaps.some((lap) => lap.id === value && lap.processing?.state === "ready")) return;
    requestedRouteLapId.current = sessionId == null ? null : value;
    setSelectedLapId(value);
  }, [allLaps, sessionId]);


  const refreshProcessing = useCallback(() => {
    void selectedLapsQuery.refetch();
  }, [selectedLapsQuery.refetch]);
  return {
    laps,
    setLaps,
    lapLoading,
    lapError,
    parseError,
    selectedLap,
    selectedLapReady,
    selectedLapProcessingLoading,
    refreshProcessing,
    semanticReplay,
    selectedTrack,
    setSelectedTrack,
    selectedCar,
    setSelectedCar,
    selectedLapId,
    setSelectedLapId,
    handleLapChange,
    outline,
    segments,
    initialCursor,
    trackNames,
    carNames,
    tracks,
    carsForTrack,
    filteredLaps,
    carName,
    trackName,
    handleTrackChange,
    handleCarChange,
  };
}
