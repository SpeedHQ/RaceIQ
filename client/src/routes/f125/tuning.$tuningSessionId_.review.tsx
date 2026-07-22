import { createFileRoute } from "@tanstack/react-router";
import { TestReviewPage } from "../../components/tunes/TestReviewPage";

/** Post-test review page. `laps` is a comma-separated list of lap ids recorded
 *  during the test that just ended. */
export type TuneReviewSearch = { laps?: string; lap?: number; view?: "overview" | "s1" | "s2" | "s3"; testId?: number };

export const Route = createFileRoute("/f125/tuning/$tuningSessionId_/review")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): TuneReviewSearch => ({
    laps: typeof search.laps === "string" ? search.laps : undefined,
    // ?lap / ?view are owned by TuneReviewDashboard (focus lap + sector view).
    lap: typeof search.lap === "number" ? search.lap : undefined,
    view: search.view === "overview" || search.view === "s1" || search.view === "s2" || search.view === "s3" ? search.view : undefined,
    testId: typeof search.testId === "number" ? search.testId : undefined,
  }),
});

function RouteComponent() {
  const { tuningSessionId } = Route.useParams();
  const { laps, testId } = Route.useSearch();
  const lapIds = (laps ?? "")
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  return <TestReviewPage gameId="f1-2025" tuningSessionId={Number(tuningSessionId)} lapIds={lapIds} testId={testId} />;
}
