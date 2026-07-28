import { createFileRoute } from "@tanstack/react-router";
import { TestReviewPage } from "../../components/tunes/TestReviewPage";

/** Post-test review page. `laps` is a comma-separated list of lap ids recorded
 *  during the test that just ended. */
export type TuneReviewSearch = { laps?: string; lap?: number; view?: "overview" | "track" | `s${number}`; versionId?: number };

export const Route = createFileRoute("/ac-evo/experiments/$experimentId_/review")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): TuneReviewSearch => ({
    laps: typeof search.laps === "string" ? search.laps : undefined,
    // ?lap / ?view are owned by TuneReviewDashboard (focus lap + sector view).
    lap: typeof search.lap === "number" ? search.lap : undefined,
    view: search.view === "overview" || search.view === "track" || (typeof search.view === "string" && /^s[1-9]\d*$/.test(search.view)) ? (search.view as TuneReviewSearch["view"]) : undefined,
    versionId: typeof search.versionId === "number" ? search.versionId : undefined,
  }),
});

function RouteComponent() {
  const { experimentId } = Route.useParams();
  const { laps, versionId } = Route.useSearch();
  const lapIds = (laps ?? "")
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  return <TestReviewPage gameId="ac-evo" experimentId={Number(experimentId)} lapIds={lapIds} versionId={versionId} />;
}
