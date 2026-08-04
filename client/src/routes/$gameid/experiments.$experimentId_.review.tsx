import { createFileRoute } from "@tanstack/react-router";
import { TestReviewPage } from "../../components/tunes/review/TestReviewPage";
import { setupEngineerGameIdForRoutePrefix, validateTuneReviewSearch } from "../../lib/game-routes";

export const Route = createFileRoute("/$gameid/experiments/$experimentId_/review")({
  component: ExperimentReviewRoute,
  validateSearch: validateTuneReviewSearch,
});

function ExperimentReviewRoute() {
  const { gameid, experimentId } = Route.useParams();
  const { laps, versionId } = Route.useSearch();
  const gameId = setupEngineerGameIdForRoutePrefix(gameid);
  if (!gameId) throw new Error(`Unsupported experiments route: ${gameid}`);
  const lapIds = (laps ?? "")
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  return <TestReviewPage gameId={gameId} experimentId={Number(experimentId)} lapIds={lapIds} versionId={versionId} />;
}
