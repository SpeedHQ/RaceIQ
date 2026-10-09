import { tryGetGame } from "@raceiq/shared/games/registry";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useLaps } from "@/hooks/laps";
import { useSessionRecap, useSessions } from "@/hooks/session-queries";
import { useSettings } from "@/hooks/settings";
import { useTrackOutline, useTrackSectorBoundaries } from "@/hooks/track-queries";
import { queryKeys } from "@/hooks/query-keys";
import { errorFromResponse } from "@/lib/rpc-error";
import { client } from "@/lib/rpc";
import { getGameRoute, useGameId } from "@/stores/game";
import { parseUtcTimestamp } from "@/lib/utc-date";
import { HomePageView } from "./HomePageView";
import type { GameStats, PeriodKey, PeriodStats } from "./types";

export function HomePageContainer() {
  const gameId = useGameId();
  const navigate = useNavigate();
  const gameAdapter = gameId ? tryGetGame(gameId) : null;
  const { data: allLaps = [], isLoading: lapsLoading, isError: lapsError } = useLaps({ allGames: true });
  const { data: sessions = [], isLoading: sessionsLoading, isError: sessionsError } = useSessions({ allGames: true });
  const { displaySettings } = useSettings();
  const hiddenGames: string[] = displaySettings.hiddenGames ?? [];

  const [periodTab, setPeriodTab] = useState<PeriodKey>("year");
  const [{ todayStart, weekAgo, monthAgo, yearAgo }] = useState(() => {
    const now = Date.now();
    return {
      todayStart: new Date().setHours(0, 0, 0, 0),
      weekAgo: now - 7 * 24 * 60 * 60 * 1000,
      monthAgo: now - 30 * 24 * 60 * 60 * 1000,
      yearAgo: now - 365 * 24 * 60 * 60 * 1000,
    };
  });

  const periodStart = { today: todayStart, week: weekAgo, month: monthAgo, year: yearAgo }[periodTab];
  const dashboardLaps = useMemo(() => allLaps.filter((lap) => parseUtcTimestamp(lap.createdAt).getTime() >= periodStart), [allLaps, periodStart]);
  const dashboardSessions = useMemo(() => sessions.filter((session) => parseUtcTimestamp(session.createdAt).getTime() >= periodStart), [sessions, periodStart]);
  const recentSessions = useMemo(() => dashboardSessions
    .filter((session) => gameId === null || session.gameId === gameId)
    .sort((a, b) => parseUtcTimestamp(b.createdAt).getTime() - parseUtcTimestamp(a.createdAt).getTime() || b.id - a.id)
    .slice(0, 10), [dashboardSessions, gameId]);
  const latestSession = recentSessions[0] ?? null;
  const { data: latestRecap, isLoading: latestRecapLoading, isError: latestRecapError } = useSessionRecap(latestSession?.id, latestSession?.gameId ?? null);
  const recapGameId = latestRecap?.gameId ?? null;
  const recapCarId = latestRecap?.carId;
  const { data: recapCars } = useQuery<{ id?: string | number | null; ordinal?: number | null; imageUrl?: string | null; specs?: { imageUrl?: string | null } | null }[]>({
    queryKey: ["cars", recapGameId],
    queryFn: async () => {
      if (recapGameId === "acc") {
        const response = await client.api.acc.cars.$get();
        if (!response.ok) throw await errorFromResponse(response);
        const cars = await response.json() as { id: number }[];
        return cars.map((car) => ({ id: car.id, imageUrl: `/car-images/acc-${car.id}.jpg` }));
      }
      if (!recapGameId) return [];
      const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": recapGameId } });
      if (!response.ok) throw await errorFromResponse(response);
      return response.json();
    },
    enabled: !!recapGameId && recapCarId != null,
    staleTime: Infinity,
  });
  const matchedRecapCar = recapCars?.find((car) => String(car.id) === String(recapCarId) || (typeof recapCarId === "number" && car.ordinal === recapCarId));
  const latestRecapCarImageUrl = matchedRecapCar?.imageUrl || matchedRecapCar?.specs?.imageUrl || undefined;
  const { data: latestRecapOutline } = useTrackOutline(latestRecap?.trackId, latestRecap?.gameId ?? latestSession?.gameId ?? null);
  const { data: latestRecapBounds } = useTrackSectorBoundaries(latestRecap?.trackId, latestRecap?.gameId ?? latestSession?.gameId ?? null);
  const gameStats: GameStats = useMemo(() => {
    const totals = new Map<string, { laps: number; seconds: number }>();
    for (const lap of dashboardLaps) {
      if (!lap.gameId) continue;
      const total = totals.get(lap.gameId) ?? { laps: 0, seconds: 0 };
      total.laps += 1;
      total.seconds += lap.lapTime > 0 ? lap.lapTime : 0;
      totals.set(lap.gameId, total);
    }
    const pick = (id: string) => {
      const total = totals.get(id);
      const seconds = total?.seconds ?? 0;
      const time = seconds <= 0 ? "—" : seconds >= 86400 ? `${Math.floor(seconds / 86400)}d` : seconds >= 3600 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 60)}m`;
      return { laps: total?.laps ?? 0, time };
    };
    return { fm: pick("fm-2023"), f1: pick("f1-2025"), acc: pick("acc"), acEvo: pick("ac-evo"), iracing: pick("iracing"), lmu: pick("lmu") };
  }, [dashboardLaps]);

  const periodStats: PeriodStats = useMemo(() => {
    function computePeriod(laps: LapMeta[]) {
      const valid = laps.filter((l) => l.isValid && l.lapTime > 0);
      const best = valid.length > 0 ? Math.min(...valid.map((l) => l.lapTime)) : 0;
      const avgTime = valid.length > 0 ? valid.reduce((s, l) => s + l.lapTime, 0) / valid.length : 0;
      const totalTime = laps.reduce((s, l) => s + (l.lapTime > 0 ? l.lapTime : 0), 0);
      const tracks = new Set(laps.map((l) => l.trackOrdinal).filter(Boolean)).size;
      const cars = new Set(laps.map((l) => l.carOrdinal).filter(Boolean)).size;
      const sessions = new Set(laps.map((l) => l.sessionId).filter(Boolean)).size;
      const carCounts = new Map<number, number>();
      for (const l of laps) {
        if (l.carOrdinal) carCounts.set(l.carOrdinal, (carCounts.get(l.carOrdinal) ?? 0) + 1);
      }
      let favCarOrd: number | null = null;
      let favCarCount = 0;
      for (const [ord, count] of carCounts) {
        if (count > favCarCount) {
          favCarOrd = ord;
          favCarCount = count;
        }
      }
      return { laps: laps.length, valid: valid.length, best, avgTime, totalTime, tracks, cars, sessions, favCarOrd, favCarCount };
    }

    const gameLaps = gameId ? allLaps.filter((l) => l.gameId === gameId) : allLaps;
    return {
      today: computePeriod(gameLaps.filter((l) => parseUtcTimestamp(l.createdAt).getTime() >= todayStart)),
      week: computePeriod(gameLaps.filter((l) => parseUtcTimestamp(l.createdAt).getTime() >= weekAgo)),
      month: computePeriod(gameLaps.filter((l) => parseUtcTimestamp(l.createdAt).getTime() >= monthAgo)),
      year: computePeriod(gameLaps.filter((l) => parseUtcTimestamp(l.createdAt).getTime() >= yearAgo)),
    };
  }, [allLaps, gameId, todayStart, weekAgo, monthAgo, yearAgo]);

  const nameTargets = useMemo(() => {
    const cars = new Map<string, { ordinal: number; gameId: NonNullable<SessionMeta["gameId"]> }>();
    const tracks = new Map<string, { ordinal: number; gameId: NonNullable<SessionMeta["gameId"]> }>();
    for (const session of [...dashboardSessions, ...recentSessions]) {
      if (!session.gameId) continue;
      if (session.carOrdinal != null && session.carOrdinal !== -1) cars.set(`${session.gameId}:${session.carOrdinal}`, { ordinal: session.carOrdinal, gameId: session.gameId });
      if (session.trackOrdinal != null && session.trackOrdinal !== -1) tracks.set(`${session.gameId}:${session.trackOrdinal}`, { ordinal: session.trackOrdinal, gameId: session.gameId });
    }
    for (const lap of dashboardLaps) {
      if (!lap.gameId) continue;
      if (lap.carOrdinal != null && lap.carOrdinal !== -1) cars.set(`${lap.gameId}:${lap.carOrdinal}`, { ordinal: lap.carOrdinal, gameId: lap.gameId });
      if (lap.trackOrdinal != null && lap.trackOrdinal !== -1) tracks.set(`${lap.gameId}:${lap.trackOrdinal}`, { ordinal: lap.trackOrdinal, gameId: lap.gameId });
    }
    return {
      cars: [...cars.values()].sort((a, b) => String(a.gameId).localeCompare(String(b.gameId)) || a.ordinal - b.ordinal),
      tracks: [...tracks.values()].sort((a, b) => String(a.gameId).localeCompare(String(b.gameId)) || a.ordinal - b.ordinal),
    };
  }, [dashboardLaps, dashboardSessions, recentSessions]);
  const carNameQueries = useQueries({
    queries: nameTargets.cars.map((target) => ({
      queryKey: [...queryKeys.carName(target.ordinal), target.gameId],
      queryFn: async () => {
        const response = await client.api["car-name"][":ordinal"].$get({ param: { ordinal: encodeURIComponent(String(target.ordinal)) }, query: { gameId: target.gameId } });
        return response.ok ? response.text() : "";
      },
    })),
  });
  const trackNameQueries = useQueries({
    queries: nameTargets.tracks.map((target) => ({
      queryKey: [...queryKeys.trackName(target.ordinal), target.gameId],
      queryFn: async () => {
        const response = await client.api["track-name"][":ordinal"].$get({ param: { ordinal: encodeURIComponent(String(target.ordinal)) }, query: { gameId: target.gameId } });
        return response.ok ? response.text() : "";
      },
    })),
  });
  const carNames = useMemo(
    () => Object.fromEntries(nameTargets.cars.map((target, index) => [`${target.gameId}:${target.ordinal}`, carNameQueries[index]?.data ?? ""])),
    [carNameQueries, nameTargets.cars],
  );
  const trackNames = useMemo(
    () => Object.fromEntries(nameTargets.tracks.map((target, index) => [`${target.gameId}:${target.ordinal}`, trackNameQueries[index]?.data ?? ""])),
    [nameTargets.tracks, trackNameQueries],
  );

  return (
    <HomePageView
      gameId={gameId}
      gameDisplayName={gameAdapter?.displayName ?? null}
      allLaps={dashboardLaps}
      periodStart={periodStart}
      sessions={dashboardSessions}
      recentSessions={recentSessions}
      carNames={carNames}
      trackNames={trackNames}
      gameStats={gameStats}
      hiddenGames={hiddenGames}
      latestSession={latestSession}
      latestRecap={latestRecap}
      latestRecapLoading={latestRecapLoading}
      latestRecapError={latestRecapError}
      latestRecapOutline={latestRecapOutline}
      latestRecapBounds={latestRecapBounds}
      latestRecapCarImageUrl={latestRecapCarImageUrl}
      onAnalyseSession={(session) => {
        if (!session.gameId) return;
        void navigate({ to: `${getGameRoute(session.gameId)}/sessions/${session.id}/analyse` as never });
      }}
      periodTab={periodTab}
      periodStats={periodStats}
      onPeriodTabChange={setPeriodTab}
      lapsLoading={lapsLoading}
      lapsError={lapsError}
      sessionsLoading={sessionsLoading}
      sessionsError={sessionsError}
    />
  );
}
