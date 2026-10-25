import { m } from "../../../../../paraglide/messages";
import { createFileRoute } from "@tanstack/react-router";
import { SessionProcessingShell } from "@raceiq/session-analyse/ui";
import { LapAnalyse } from "../../../../../components/analyse/LapAnalyse";
import { OpponentLapReplay } from "../../../../../components/analyse/OpponentLapReplay";
import { validateAnalyseSearch } from "@raceiq/session-analyse/contracts";
import { gameIdForRoutePrefix } from "../../../../../lib/game-routes";
import { useSessionLaps } from "../../../../../hooks/laps";

function GameSessionReplayRoute() {
  const { gameid, sessionId, lapId } = Route.useParams();
  const search = Route.useSearch();
  const gameId = gameIdForRoutePrefix(gameid);
  if (!gameId) throw new Error(`Unsupported replay route: ${gameid}`);
  const hasOpponentRef = search.opponentRefInvalid || search.opponentLap !== undefined || search.opponentRevision !== undefined;
  if (hasOpponentRef) {
    if (gameId !== "lmu" || search.opponentRefInvalid ||
      typeof search.opponentLap !== "string" || !search.opponentLap ||
      typeof search.opponentRevision !== "string" || !search.opponentRevision) {
      return <div role="alert">{m.analyse_unavailable()}</div>;
    }
    return <LapReadinessRoute sessionId={Number(sessionId)} lapId={Number(lapId)} opponentLap={search.opponentLap} opponentRevision={search.opponentRevision} />;
  }
  return <LapReadinessRoute sessionId={Number(sessionId)} lapId={Number(lapId)} />;
}

function LapReadinessRoute({ sessionId, lapId, opponentLap, opponentRevision }: { sessionId: number; lapId: number; opponentLap?: string; opponentRevision?: string }) {
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
  if (opponentLap != null && opponentRevision != null) return <OpponentLapReplay anchor={lap} opponentLapId={opponentLap} sourceRevision={opponentRevision} />;
  return <LapAnalyse sessionId={sessionId} initialLapId={lapId} />;
}

export const Route = createFileRoute("/$gameid/sessions/$sessionId/replay/$lapId")({
  component: GameSessionReplayRoute,
  validateSearch: (search) => {
    const { cursor, viz, ai, view } = validateAnalyseSearch(search);
    return {
      cursor, viz, ai, view,
      opponentLap: typeof search.opponentLap === "string" ? search.opponentLap : undefined,
      opponentRevision: typeof search.opponentRevision === "string" ? search.opponentRevision : undefined,
      opponentRefInvalid: (search.opponentLap != null && typeof search.opponentLap !== "string") ||
        (search.opponentRevision != null && typeof search.opponentRevision !== "string"),
    };
  },
});

