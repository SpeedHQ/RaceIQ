import { tryGetGame } from "@shared/games/registry";
import { carIdentityKey, trackIdentityKey, type LapMeta } from "@shared/racing/sessions/types";
import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { buildRecapText } from "@/components/SessionRecap";
import { useLaps } from "@/hooks/laps";
import { useSessionRecap, useSessions } from "@/hooks/session-queries";
import { useSettings } from "@/hooks/settings";
import { useTrackOutline, useTrackSectorBoundaries } from "@/hooks/track-queries";
import { queryKeys } from "@/hooks/query-keys";
import { client } from "@/lib/rpc";
import { getGameRoute, useGameId } from "@/stores/game";
import { uiStore } from "@/stores/ui";
import { HomePageView } from "./HomePageView";
import type { GameStats, PeriodKey, PeriodStats } from "./types";

export function HomePageContainer() {
  const gameId = useGameId();
  const navigate = useNavigate();
  const gameAdapter = gameId ? tryGetGame(gameId) : null;
  const { data: allLaps = [], isLoading: lapsLoading, isError: lapsError } = useLaps();
  const { data: sessions = [], isLoading: sessionsLoading, isError: sessionsError } = useSessions();
  const { displaySettings } = useSettings();
  const { openSettings } = uiStore.actions;
  const hiddenGames: string[] = displaySettings.hiddenGames ?? [];

  const latestSession = useMemo(() => {
    if (sessions.length === 0) return null;
    return [...sessions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  }, [sessions]);
  const { data: latestRecap, isLoading: latestRecapLoading, isError: latestRecapError } = useSessionRecap(latestSession?.id, latestSession?.gameId ?? null);
  const { data: latestRecapOutline } = useTrackOutline(latestRecap?.trackOrdinal, latestRecap?.gameId ?? latestSession?.gameId ?? null);
  const { data: latestRecapBounds } = useTrackSectorBoundaries(latestRecap?.trackOrdinal, latestRecap?.gameId ?? latestSession?.gameId ?? null);
  const [recapCopied, setRecapCopied] = useState(false);

  const recentLaps = useMemo(
    () =>
      [...allLaps]
        .filter((l) => l.lapTime > 0)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10),
    [allLaps],
  );

  const gameQueries = useQueries({
    queries: (["fm-2023", "f1-2025", "acc", "ac-evo", "iracing", "lmu"] as const).map((g) => ({
      queryKey: ["stats", g],
      queryFn: async () => {
        const res = await client.api.stats.$get({ query: { gameId: g } });
        if (!res.ok) throw new Error(res.statusText);
        return res.json() as Promise<{ totalLaps: number; totalTimeSec: number }>;
      },
    })),
  });

  const gameStats: GameStats = useMemo(() => {
    const fmtTime = (sec: number) => {
      if (sec <= 0) return "—";
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };
    const pick = (i: number) => {
      const d = gameQueries[i].data;
      return { laps: d?.totalLaps ?? 0, time: fmtTime(d?.totalTimeSec ?? 0) };
    };
    return { fm: pick(0), f1: pick(1), acc: pick(2), acEvo: pick(3), iracing: pick(4), lmu: pick(5) };
  }, [gameQueries]);

  const [periodTab, setPeriodTab] = useState<PeriodKey>("allTime");
  const [{ todayStart, weekAgo, monthAgo, yearAgo }] = useState(() => {
    const now = Date.now();
    return {
      todayStart: new Date().setHours(0, 0, 0, 0),
      weekAgo: now - 7 * 24 * 60 * 60 * 1000,
      monthAgo: now - 30 * 24 * 60 * 60 * 1000,
      yearAgo: now - 365 * 24 * 60 * 60 * 1000,
    };
  });

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
      today: computePeriod(gameLaps.filter((l) => new Date(l.createdAt).getTime() >= todayStart)),
      week: computePeriod(gameLaps.filter((l) => new Date(l.createdAt).getTime() >= weekAgo)),
      month: computePeriod(gameLaps.filter((l) => new Date(l.createdAt).getTime() >= monthAgo)),
      year: computePeriod(gameLaps.filter((l) => new Date(l.createdAt).getTime() >= yearAgo)),
      allTime: computePeriod(gameLaps),
    };
  }, [allLaps, gameId, todayStart, weekAgo, monthAgo, yearAgo]);

  const nameTargets = useMemo(() => {
    const cars = new Map<string, { ordinal: number; gameId: NonNullable<LapMeta["gameId"]> }>();
    const tracks = new Map<string, { ordinal: number; gameId: NonNullable<LapMeta["gameId"]> }>();
    for (const lap of recentLaps) {
      if (!lap.gameId) continue;
      if (lap.carOrdinal != null) cars.set(`${lap.gameId}:${lap.carOrdinal}`, { ordinal: lap.carOrdinal, gameId: lap.gameId });
      if (lap.trackOrdinal != null) tracks.set(`${lap.gameId}:${lap.trackOrdinal}`, { ordinal: lap.trackOrdinal, gameId: lap.gameId });
    }
    return { cars: [...cars.values()].sort((a, b) => String(a.gameId).localeCompare(String(b.gameId)) || a.ordinal - b.ordinal), tracks: [...tracks.values()].sort((a, b) => String(a.gameId).localeCompare(String(b.gameId)) || a.ordinal - b.ordinal) };
  }, [recentLaps]);
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
  const carNames = useMemo(() => Object.fromEntries(nameTargets.cars.map((target, index) => [`${target.gameId}:${target.ordinal}`, carNameQueries[index]?.data ?? ""])), [carNameQueries, nameTargets.cars]);
  const trackNames = useMemo(() => Object.fromEntries(nameTargets.tracks.map((target, index) => [`${target.gameId}:${target.ordinal}`, trackNameQueries[index]?.data ?? ""])), [nameTargets.tracks, trackNameQueries]);
  const copyRecap = () => {
    if (!latestRecap) return;
    navigator.clipboard.writeText(buildRecapText(latestRecap)).then(() => {
      setRecapCopied(true);
      setTimeout(() => setRecapCopied(false), 1500);
    });
  };
  const analyseRecap = () => {
    if (!latestRecap || latestRecap.bestLapId == null) return;
    void navigate({
      to: `${getGameRoute(latestRecap.gameId)}/sessions/replay` as never,
      search: { track: trackIdentityKey(latestRecap), car: carIdentityKey(latestRecap), lap: latestRecap.bestLapId } as never,
    });
  };

  return (
    <HomePageView
      gameId={gameId}
      gameDisplayName={gameAdapter?.displayName ?? null}
      displaySettings={displaySettings}
      allLaps={allLaps}
      recentLaps={recentLaps}
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
      recapCopied={recapCopied}
      onCopyRecap={copyRecap}
      onAnalyseRecap={analyseRecap}
      onAnalyseLap={(lap) => {
        if (!lap.gameId) return;
        void navigate({
          to: `${getGameRoute(lap.gameId)}/sessions/replay` as never,
          search: { track: trackIdentityKey(lap), car: carIdentityKey(lap), lap: lap.id } as never,
        });
      }}
      periodTab={periodTab}
      periodStats={periodStats}
      onPeriodTabChange={setPeriodTab}
      onOpenSettings={() => openSettings("games")}
      lapsLoading={lapsLoading}
      lapsError={lapsError}
      sessionsLoading={sessionsLoading}
      sessionsError={sessionsError}
    />
  );
}
