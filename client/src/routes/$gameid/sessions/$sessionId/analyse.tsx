import { createFileRoute, useSearch } from "@tanstack/react-router";
import { AnalyseRoute, SessionProcessingShell } from "@raceiq/session-analyse/ui";
import type { GameId } from "@raceiq/shared/games/ids";
import { validateAnalyseSearch } from "@raceiq/session-analyse/contracts";
import { gameIdForRoutePrefix } from "../../../../lib/game-routes";
import { useSessions } from "../../../../hooks/session-queries";

function GameSessionAnalyseRoute() {
  const { gameid, sessionId } = Route.useParams();
  const { session: querySessionId } = useSearch({ strict: false }) as { session?: number };
  const gameId = gameIdForRoutePrefix(gameid);
  if (!gameId) throw new Error(`Unsupported Analyse route: ${gameid}`);
  return <SessionAnalyseReadiness gameId={gameId} sessionId={querySessionId ?? Number(sessionId)} />;
}

function SessionAnalyseReadiness({ gameId, sessionId }: { gameId: GameId; sessionId: number }) {
  const sessions = useSessions();
  if (sessions.isError) {
    return (
      <SessionProcessingShell
        error={sessions.error instanceof Error ? sessions.error.message : String(sessions.error)}
        onRefresh={() => void sessions.refetch()}
      />
    );
  }
  if (sessions.data === undefined) return <SessionProcessingShell loading />;
  const session = sessions.data.find((candidate) => candidate.id === sessionId);
  if (!session) return <AnalyseRoute gameId={gameId} sessionId={sessionId} />;
  if (session.processing.state !== "ready") {
    return <SessionProcessingShell processing={session.processing} onRefresh={() => void sessions.refetch()} />;
  }
  return <AnalyseRoute gameId={gameId} sessionId={sessionId} />;
}

export const Route = createFileRoute("/$gameid/sessions/$sessionId/analyse")({
  component: GameSessionAnalyseRoute,
  validateSearch: validateAnalyseSearch,
});
