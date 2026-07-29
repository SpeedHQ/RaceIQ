import { tryGetGame } from "@shared/games/registry";
import type { LapMeta } from "@shared/types";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useDriverProfile, useDriverProfileRuns, useLaps, useSessionRecap, useSessions, useSettings, useTrackOutline, useTrackSectorBoundaries } from "../hooks/queries";
import { client } from "../lib/rpc";
import { getGameRoute, useGameId } from "../stores/game";
import { useUiStore } from "../stores/ui";
import { buildRecapText } from "./SessionRecap";
import { HomePageView, type GameStats, type PeriodKey, type PeriodStats } from "./HomePage";

export function HomePageContainer() {
  const gameId = useGameId();
  const gameAdapter = gameId ? tryGetGame(gameId) : null;
  const { data: allLaps = [], isLoading: lapsLoading, isError: lapsError } = useLaps();
  const driverProfileQuery = useDriverProfile({ gameId });
  const driverProfileRunsQuery = useDriverProfileRuns({ gameId });
  const { data: sessions = [], isLoading: sessionsLoading, isError: sessionsError } = useSessions();
  const { displaySettings } = useSettings();
  const { openSettings } = useUiStore();
  const hiddenGames: string[] = displaySettings.hiddenGames ?? [];

  const latestSession = useMemo(() => {
    if (sessions.length === 0) return null;
    return [...sessions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  }, [sessions]);
  const { data: latestRecap, isLoading: latestRecapLoading, isError: latestRecapError } = useSessionRecap(latestSession?.id, latestSession?.gameId ?? null);
  const { data: latestRecapOutline } = useTrackOutline(latestRecap?.trackOrdinal, latestRecap?.gameId ?? latestSession?.gameId ?? null);
  const { data: latestRecapBounds } = useTrackSectorBoundaries(latestRecap?.trackOrdinal, latestRecap?.gameId ?? latestSession?.gameId ?? null);
  const [recapCopied, setRecapCopied] = useState(false);

  const [carNames, setCarNames] = useState<Record<number, string>>({});
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});

  const recentLaps = useMemo(
    () =>
      [...allLaps]
        .filter((l) => l.lapTime > 0)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10),
    [allLaps],
  );

  const medianLapSec = useMemo(() => {
    const selectedLapTimes = driverProfileQuery.data?.selectedLapTimes ?? [];
    const times = selectedLapTimes
      .filter((lap) => lap.isValid && lap.lapTime > 0)
      .map((lap) => lap.lapTime)
      .sort((a, b) => a - b);
    if (times.length === 0) return null;
    const middle = Math.floor(times.length / 2);
    return times.length % 2 === 0 ? (times[middle - 1] + times[middle]) / 2 : times[middle];
  }, [driverProfileQuery.data]);

  const gameQueries = useQueries({
    queries: (["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"] as const).map((g) => ({
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
    return { fm: pick(0), f1: pick(1), acc: pick(2), acEvo: pick(3), iracing: pick(4) };
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

  useEffect(() => {
    const carOrds = [...new Set([...recentLaps.map((l) => l.carOrdinal), periodStats.today.favCarOrd, periodStats.week.favCarOrd, periodStats.month.favCarOrd].filter((o): o is number => o != null))];
    const trackOrds = [...new Set(recentLaps.map((l) => l.trackOrdinal).filter((o): o is number => o != null))];
    for (const ord of carOrds) {
      if (carNames[ord]) continue;
      const lapForCar = recentLaps.find((l) => l.carOrdinal === ord);
      client.api["car-name"][":ordinal"]
        .$get({ param: { ordinal: String(ord) }, query: { gameId: (lapForCar?.gameId ?? gameId)! } })
        .then((r) => (r.ok ? r.text() : ""))
        .then((name) => setCarNames((prev) => ({ ...prev, [ord]: name })))
        .catch(() => {});
    }
    for (const ord of trackOrds) {
      if (trackNames[ord]) continue;
      const lapForTrack = recentLaps.find((l) => l.trackOrdinal === ord);
      client.api["track-name"][":ordinal"]
        .$get({ param: { ordinal: String(ord) }, query: { gameId: (lapForTrack?.gameId ?? gameId)! } })
        .then((r) => (r.ok ? r.text() : ""))
        .then((name) => setTrackNames((prev) => ({ ...prev, [ord]: name })))
        .catch(() => {});
    }
  }, [recentLaps, periodStats, gameId]);

  const copyRecap = () => {
    if (!latestRecap) return;
    navigator.clipboard.writeText(buildRecapText(latestRecap)).then(() => {
      setRecapCopied(true);
      setTimeout(() => setRecapCopied(false), 1500);
    });
  };
  const analyseRecap = () => {
    if (!latestRecap || latestRecap.bestLapId == null) return;
    window.location.href = `${getGameRoute(latestRecap.gameId)}/analyse?track=${latestRecap.trackOrdinal}&car=${latestRecap.carOrdinal}&lap=${latestRecap.bestLapId}`;
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
        window.location.href = `${getGameRoute(lap.gameId)}/analyse?track=${lap.trackOrdinal ?? ""}&car=${lap.carOrdinal ?? ""}&lap=${lap.id}`;
      }}
      periodTab={periodTab}
      periodStats={periodStats}
      onPeriodTabChange={setPeriodTab}
      onOpenSettings={() => openSettings("games")}
      driverGameId={gameId}
      driverFingerprint={driverProfileQuery.data?.fingerprint ?? null}
      driverLoading={driverProfileQuery.isLoading}
      driverError={driverProfileQuery.error instanceof Error ? driverProfileQuery.error.message : driverProfileQuery.error ? String(driverProfileQuery.error) : null}
      medianLapSec={medianLapSec}
      driverRunState={driverProfileRunsQuery.data?.state}
      lapsLoading={lapsLoading}
      lapsError={lapsError}
      sessionsLoading={sessionsLoading}
      sessionsError={sessionsError}
    />
  );
}
