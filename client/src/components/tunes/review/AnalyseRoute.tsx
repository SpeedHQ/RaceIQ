import type { GameId } from "@shared/games/ids";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { parseAnalyseLapIds, type AnalyseSearch } from "@/lib/game-routes";
import { AnalysePickerPage } from "./AnalysePickerPage";
import { TrackCarAnalyseReviewPage } from "./TrackCarAnalyseReviewPage";
import { LapAnalyse } from "../../analyse/LapAnalyse";

function InvalidAnalyseSelection({ message }: { message: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-[18rem] items-center justify-center p-8 text-center">
      <div>
        <h1 className="text-lg font-semibold text-app-text">Invalid Analyse selection</h1>
        <p role="alert" className="mt-2 text-sm text-app-text-muted">{message}</p>
        <Button
          variant="app-outline"
          size="app-sm"
          className="mt-4"
          onClick={() => void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, track: undefined, car: undefined, lap: undefined, laps: undefined }) } as never)}
        >
          Back to Analyse picker
        </Button>
      </div>
    </div>
  );
}

export function AnalyseRoute({ gameId }: { gameId: GameId }) {
  const search = useSearch({ strict: false }) as AnalyseSearch;
  if (gameId !== "acc" && gameId !== "ac-evo") return <LapAnalyse />;
  const hasTrack = search.track != null;
  const hasCar = search.car != null;
  const hasLap = search.lap != null;
  const hasComparison = search.laps != null;
  const comparisonLapIds = parseAnalyseLapIds(search.laps);
  const validTrack = !hasTrack || (Number.isInteger(search.track!) && search.track! > 0);
  const validCar = !hasCar || (Number.isInteger(search.car!) && search.car! > 0);
  const validLap = !hasLap || (Number.isInteger(search.lap!) && search.lap! > 0);

  if (!validTrack || !validCar || !validLap) {
    return <InvalidAnalyseSelection message="Track, car, and lap must be positive numeric selections." />;
  }
  if (hasComparison && (comparisonLapIds == null || comparisonLapIds.length === 0)) {
    return <InvalidAnalyseSelection message="Comparison laps must be a comma-separated list of positive, unique lap IDs." />;
  }
  if (hasTrack !== hasCar) {
    return <InvalidAnalyseSelection message="Choose both track and car before selecting laps." />;
  }
  if ((hasLap || hasComparison) && (!hasTrack || !hasCar)) {
    return <InvalidAnalyseSelection message="A lap selection must include its track and car." />;
  }
  if (!hasTrack && !hasCar) return <AnalysePickerPage gameId={gameId} />;
  if (hasLap) return <LapAnalyse />;
  return <TrackCarAnalyseReviewPage gameId={gameId} trackOrdinal={search.track!} carOrdinal={search.car!} />;
}
