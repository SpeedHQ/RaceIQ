import { tryGetGame } from "@raceiq/shared/games/registry";
import type { DashboardRecentSession } from "@raceiq/shared/racing/sessions/dashboard";
import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useDashboard, useDashboardRecap } from "@/hooks/dashboard";
import { useSettings } from "@/hooks/settings";
import { useTrackOutline, useTrackSectorBoundaries } from "@/hooks/track-queries";
import { client } from "@/lib/rpc";
import { getGameRoute, useGameId } from "@/stores/game";
import { rpcJson } from "@/lib/rpc-json";
import { HomePageView } from "./HomePageView";
import type { GameStats, PeriodKey } from "./types";
import { useDashboardCars } from "@/hooks/dashboard-cars";

function cardStats(cards: Record<string, { laps: number; drivenSeconds: number }>): GameStats {
  const display = (seconds: number) => seconds <= 0 ? "—" : seconds >= 86400 ? `${Math.floor(seconds / 86400)}d` : seconds >= 3600 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 60)}m`;
  const get = (id: string) => ({ laps: cards[id]?.laps ?? 0, time: display(cards[id]?.drivenSeconds ?? 0) });
  return { fm: get("fm-2023"), f1: get("f1-2025"), acc: get("acc"), acEvo: get("ac-evo"), iracing: get("iracing"), lmu: get("lmu") };
}

export function HomePageContainer() {
  const gameId = useGameId();
  const navigate = useNavigate();
  const gameAdapter = gameId ? tryGetGame(gameId) : null;
  const [periodTab, setPeriodTab] = useState<PeriodKey>("week");
  const dashboard = useDashboard(periodTab);
  const response = dashboard.data;
  const { displaySettings } = useSettings();
  const hiddenGames: string[] = displaySettings.hiddenGames ?? [];
  const recentSessions = response?.recentSessions ?? [];
  const latestSession = response?.latestRecapSessionId == null ? null : recentSessions.find((session) => session.id === response.latestRecapSessionId) ?? null;
  const recapGameId = latestSession?.gameId ?? null;
  const { data: latestRecap, isLoading: latestRecapLoading, isError: latestRecapError } = useDashboardRecap(response?.latestRecapSessionId, recapGameId);
  const { data: recapCars } = useDashboardCars(recapGameId, latestRecap?.carId != null);
  const matchedRecapCar = recapCars?.find((car) => car.id === latestRecap?.carId);
  const latestRecapCarImageUrl = matchedRecapCar?.imageUrl || matchedRecapCar?.specs?.imageUrl || undefined;
  const { data: latestRecapOutline } = useTrackOutline(latestRecap?.trackId, latestRecap?.gameId ?? recapGameId);
  const { data: latestRecapBounds } = useTrackSectorBoundaries(latestRecap?.trackId, latestRecap?.gameId ?? recapGameId);
  const trackNameRequests = useMemo(() => {
    const idsByGame = new Map<string, Set<string>>();
    const identities = [...(response?.trackDistribution.topFive ?? []), ...(response?.favouriteTrack ? [response.favouriteTrack] : [])];
    for (const track of identities) {
      const ids = idsByGame.get(track.gameId) ?? new Set<string>();
      ids.add(track.identity);
      idsByGame.set(track.gameId, ids);
    }
    return [...idsByGame].map(([gameId, ids]) => ({ gameId, tracks: JSON.stringify([...ids].sort()) }));
  }, [response]);
  const resolvedTrackNames = useQueries({
    queries: trackNameRequests.map(({ gameId, tracks }) => ({
      queryKey: ["resolve-names", gameId, tracks, ""],
      queryFn: async () => rpcJson<{ trackNames: Record<string, string>; carNames: Record<string, string> }>(
        await client.api["resolve-names"].$get({ query: { gameId, tracks } }),
      ),
    })),
  });
  const names = useMemo(() => {
    const cars: Record<string, string> = {};
    const tracks: Record<string, string> = {};
    for (const session of recentSessions) {
      const key = `${session.gameId}:${session.car.id ?? ""}`;
      const carName = session.car.name;
      if (session.car.id != null && carName) cars[key] = carName;
      const trackKey = `${session.gameId}:${session.track.id ?? ""}`;
      if (session.track.id != null && session.track.name) tracks[trackKey] = session.track.name;
    }
    for (let index = 0; index < trackNameRequests.length; index++) {
      const gameId = trackNameRequests[index].gameId;
      for (const [identity, name] of Object.entries(resolvedTrackNames[index].data?.trackNames ?? {})) {
        if (name && tracks[`${gameId}:${identity}`] == null) tracks[`${gameId}:${identity}`] = name;
      }
    }
    return { cars, tracks };
  }, [recentSessions, trackNameRequests, resolvedTrackNames]);
  const totals = response?.totals;
  const periodStats = useMemo(() => {
    const current = {
      laps: totals?.laps ?? 0,
      valid: totals?.validLaps ?? 0,
      best: totals?.bestLapSeconds ?? 0,
      avgTime: totals?.averageLapSeconds ?? 0,
      totalTime: totals?.drivenSeconds ?? 0,
      tracks: totals?.tracks ?? 0,
      cars: totals?.cars ?? 0,
      sessions: totals?.sessions ?? 0,
      favCarId: response?.favouriteCar?.nativeId ?? null,
      favCarCount: response?.favouriteCar?.laps ?? 0,
    };
    return { today: current, week: current, month: current, year: current };
  }, [response, totals]);
  const selectedFrom = Date.parse(dashboard.from);
  const sessionForNavigation = (session: DashboardRecentSession) => {
    void navigate({ to: `${getGameRoute(session.gameId)}/sessions/${session.id}/analyse` as never });
  };

  return <HomePageView
    gameId={gameId}
    gameDisplayName={gameAdapter?.displayName ?? null}
    response={response}
    periodStart={selectedFrom}
    sessions={recentSessions}
    carNames={names.cars}
    trackNames={names.tracks}
    gameStats={cardStats(response?.cards ?? {})}
    hiddenGames={hiddenGames}
    latestSession={latestSession}
    latestRecap={latestRecap}
    latestRecapLoading={latestRecapLoading}
    latestRecapError={latestRecapError}
    latestRecapOutline={latestRecapOutline}
    latestRecapBounds={latestRecapBounds}
    latestRecapCarImageUrl={latestRecapCarImageUrl}
    onAnalyseSession={sessionForNavigation}
    periodTab={periodTab}
    periodStats={periodStats}
    onPeriodTabChange={setPeriodTab}
    lapsLoading={dashboard.isLoading || response?.coverage.metadataComplete === false}
    lapsError={dashboard.isError}
    sessionsLoading={dashboard.isLoading || response?.coverage.metadataComplete === false}
    sessionsError={dashboard.isError}
  />;
}
