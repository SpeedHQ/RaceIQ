import { useSessionAnalyseHost } from "./host";
import type { GameId } from "@raceiq/shared/games/ids";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { parseAnalyseLapIds, type AnalyseSearch } from "../contracts/search";
import { SessionAnalysePage } from "./SessionAnalysePage";

function InvalidAnalyseSelection({ message, nested }: { message: string; nested: boolean }) {
  const { m, Button } = useSessionAnalyseHost();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-[18rem] items-center justify-center p-8 text-center">
      <div>
        <h1 className="text-lg font-semibold text-app-text">{m.review_invalid_analyse_selection()}</h1>
        <p role="alert" className="mt-2 text-sm text-app-text-muted">
          {message}
        </p>
        <Button variant="app-outline" size="app-sm" className="mt-4" onClick={() => void navigate({ to: (nested ? "../.." : "..") as never })}>
          {m.review_back_to_sessions()}
        </Button>
      </div>
    </div>
  );
}

export function AnalyseRoute({ gameId, sessionId }: { gameId: GameId; sessionId?: number }) {
  const { m, LapAnalyse } = useSessionAnalyseHost();
  const search = useSearch({ strict: false }) as AnalyseSearch;
  const hasTrack = search.track != null;
  const hasCar = search.car != null;
  const hasLap = search.lap != null;
  const hasComparison = search.laps != null;
  const hasPrimary = search.primary != null;
  const nested = sessionId != null;
  const hasSession = search.session != null || (nested && !hasTrack && !hasCar && !hasLap);
  const selectedSessionId = search.session ?? sessionId;
  const comparisonLapIds = parseAnalyseLapIds(search.laps);
  const validTrack = !hasTrack || typeof search.track === "string" && search.track.length > 0;
  const validCar = !hasCar || typeof search.car === "string" && search.car.length > 0;
  const validLap = !hasLap || (Number.isInteger(search.lap!) && search.lap! > 0);

  if (!validTrack || !validCar || !validLap) return <InvalidAnalyseSelection nested={nested} message={m.review_invalid_track_car_lap_selection()} />;
  if (hasSession) {
    if (selectedSessionId == null || !Number.isInteger(selectedSessionId) || selectedSessionId <= 0 || hasTrack || hasCar || hasLap) {
      return <InvalidAnalyseSelection nested={nested} message={m.review_invalid_session_id_selection()} />;
    }
    if (hasComparison !== hasPrimary || (hasComparison && (comparisonLapIds == null || comparisonLapIds.length === 0 || comparisonLapIds.length > 5 || !comparisonLapIds.includes(search.primary!)))) {
      return <InvalidAnalyseSelection nested={nested} message={m.review_invalid_session_laps_selection()} />;
    }
    if (!hasComparison && hasPrimary) return <InvalidAnalyseSelection nested={nested} message={m.review_invalid_laps_primary_pair()} />;
    return <SessionAnalysePage gameId={gameId} sessionId={selectedSessionId} />;
  }
  if (hasPrimary) return <InvalidAnalyseSelection nested={nested} message={m.review_invalid_primary_session_only()} />;
  if (hasComparison && (comparisonLapIds == null || comparisonLapIds.length === 0))
    return <InvalidAnalyseSelection nested={nested} message={m.review_invalid_comparison_lap_ids()} />;
  if (hasTrack !== hasCar) return <InvalidAnalyseSelection nested={nested} message={m.review_choose_track_and_car()} />;
  if (!hasTrack && !hasCar) return <InvalidAnalyseSelection nested={nested} message={m.review_session_selection_required_analyse()} />;
  if ((hasLap || hasComparison) && (!hasTrack || !hasCar)) return <InvalidAnalyseSelection nested={nested} message={m.review_lap_selection_track_car_required()} />;
  if (hasLap) return <LapAnalyse sessionId={nested ? sessionId : undefined} />;
  if (gameId === "lmu") return <LapAnalyse sessionId={nested ? sessionId : undefined} />;
  return <SessionAnalysePage gameId={gameId} trackId={search.track} carId={search.car} />;
}
