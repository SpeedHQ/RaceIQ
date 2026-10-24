import { createFileRoute } from "@tanstack/react-router";
import { SessionProcessingShell } from "@raceiq/session-analyse/ui";
import { LapAnalyse } from "../../../../../components/analyse/LapAnalyse";
import { validateAnalyseSearch } from "@raceiq/session-analyse/contracts";
import { gameIdForRoutePrefix } from "../../../../../lib/game-routes";
import { useSessionLaps } from "../../../../../hooks/laps";

function GameSessionReplayRoute() {
  const { gameid, sessionId, lapId } = Route.useParams();
  const gameId = gameIdForRoutePrefix(gameid);
  if (!gameId) throw new Error(`Unsupported replay route: ${gameid}`);
  return <LapReadinessRoute sessionId={Number(sessionId)} lapId={Number(lapId)} />;
}

function LapReadinessRoute({ sessionId, lapId }: { sessionId: number; lapId: number }) {
  const laps = useSessionLaps(sessionId);
  if (laps.isError) {
    return (
      <SessionProcessingShell
        error={laps.error instanceof Error ? laps.error.message : String(laps.error)}
        onRefresh={() => void laps.refetch()}
      />
    );
  }
  if (laps.data === undefined) return <SessionProcessingShell loading />;
  const lap = laps.data.find((candidate) => candidate.id === lapId && candidate.sessionId === sessionId);
  if (lap && lap.processing.state !== "ready") {
    return <SessionProcessingShell processing={lap.processing} onRefresh={() => void laps.refetch()} />;
  }
  return <LapAnalyse sessionId={sessionId} initialLapId={lapId} />;
}

export const Route = createFileRoute("/$gameid/sessions/$sessionId/replay/$lapId")({
  component: GameSessionReplayRoute,
  validateSearch: (search) => {
    const { cursor, viz, ai, view } = validateAnalyseSearch(search);
    return { cursor, viz, ai, view };
  },
});
