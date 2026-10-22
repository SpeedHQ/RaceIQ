import { createFileRoute } from "@tanstack/react-router";
import { RaceStrategiesPage } from "@raceiq/race-strategy/ui";
import { gameIdForRoutePrefix } from "@/lib/game-routes";

function GameStrategyRoute() {
  const { gameid } = Route.useParams();
  const { sessionId } = Route.useSearch();
  const gameId = gameIdForRoutePrefix(gameid);
  if (!gameId) throw new Error(`Unsupported strategy route: ${gameid}`);
  return <div className="min-w-0 p-4 sm:p-6"><RaceStrategiesPage key={`${gameId}:${sessionId ?? "list"}`} gameId={gameId} sessionId={sessionId} /></div>;
}

export const Route = createFileRoute("/$gameid/strategy")({
  validateSearch: (search: Record<string, unknown>): { sessionId?: number } => {
    const sessionId = Number(search.sessionId);
    return Number.isSafeInteger(sessionId) && sessionId > 0 ? { sessionId } : {};
  },
  component: GameStrategyRoute,
});
